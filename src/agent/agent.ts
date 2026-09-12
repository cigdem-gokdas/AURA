import { calculateFeatures } from '../features/calculate.js';
import type { FeatureSnapshot } from '../features/types.js';
import type { ExecutionEngine, OrderRequest, StartupExchangeSnapshot } from '../execution/types.js';
import type { ExecutionTools } from '../execution/discovery.js';
import type { LlmClient, LlmDecisionResult } from '../llm/types.js';
import type { MarketAdapter, SpotFeeRate, TradingBalanceSnapshot } from '../market/types.js';
import { hardStopBreached, promoteBreakEven, activateTrailing, updateAtrTrailingStop,
  takeProfitReached, timeStopReached, regimeInvalidated } from '../monitor/protection.js';
import { InMemoryPositionMonitor } from '../monitor/monitor.js';
import type { OpenPosition, PositionMonitor, StartupMonitorContext } from '../monitor/types.js';
import type { OkxConnector } from '../okx/connector.js';
import { transitionRegime } from '../regime/classify.js';
import type { RegimeDecision, RegimeHysteresisState } from '../regime/types.js';
import { evaluateEntryRisk } from '../risk/evaluate.js';
import type { ApprovedOrderPlan, PreTradeRiskInput, RiskCertificate, RiskMode } from '../risk/types.js';
import { summarizeSignalCalibration } from '../signal/calibration.js';
import { generateCandidate } from '../signal/generate.js';
import { rankEntryCandidates } from '../signal/rank.js';
import type { CandidateSignal, SignalCalibrationDiagnostics } from '../signal/types.js';
import { validRiskConfig, type AgentConfig } from './config.js';

export type AgentState = 'BOOTING' | 'PREFLIGHT' | 'OBSERVE_ONLY' | 'LIVE_READY' | 'LIVE' | 'DEGRADED' | 'HALTED';

export interface SymbolEvaluation {
  symbol: string;
  feature: FeatureSnapshot;
  regime: RegimeDecision;
  nextRegimeState: RegimeHysteresisState;
  candidate: CandidateSignal;
  fee: SpotFeeRate;
}

export interface ObserverSnapshot {
  timestamp: number;
  state: AgentState;
  mcpHealthy: boolean;
  symbols: readonly string[];
  markets: Readonly<Record<string, { close: number; spreadBps: number; atrPctPercentile: number;
    regime: string; candidateAction: string; oqs: number; edgeCostRatio: number }>>;
  selectedSymbol: string | null;
  selectedOQS: number | null;
  llm: { status: string; action: string | null; riskFlag: string | null } | null;
  riskCertificate: RiskCertificate | null;
  openPositionSymbol: string | null;
  position: { symbol: string; quantity: number; entryPrice: number; markPrice: number; stopPrice: number } | null;
  equity: { starting: number; current: number; peak: number; dailyPnl: number; dailyReturnPct: number;
    currentDrawdownPct: number; maximumDrawdownPct: number } | null;
  riskMode: RiskMode | null;
  degradedReason: string | null;
}

export interface PreflightReport {
  passed: boolean;
  state: AgentState;
  checks: readonly { name: string; passed: boolean; detail: string }[];
  positionSymbol: string | null;
}

export interface CycleResult {
  status: 'HOLD' | 'BLOCKED' | 'REJECTED' | 'SUBMITTED' | 'MONITORING' | 'SKIPPED';
  selectedSymbol: string | null;
  reason: string;
}

export interface AgentDependencies {
  connector: OkxConnector;
  market: MarketAdapter;
  execution: ExecutionEngine;
  llm: LlmClient;
  monitor?: PositionMonitor;
  createMonitor?: (snapshot: StartupExchangeSnapshot) => PositionMonitor;
  startupContext?: (snapshot: StartupExchangeSnapshot, references: Readonly<Record<string, number>>)
    => StartupMonitorContext | Promise<StartupMonitorContext>;
  observer?: (snapshot: ObserverSnapshot) => void | Promise<void>;
  persistPosition?: (position: OpenPosition | null) => Promise<void>;
  now?: () => number;
  /** Strategy seam for offline orchestration tests; production uses the existing feature/regime/signal modules. */
  evaluateSymbol?: (symbol: string, previous: RegimeHysteresisState | null, position: OpenPosition | null)
    => Promise<SymbolEvaluation>;
  killSwitch?: () => boolean;
}

const requiredMarketTools = ['market_get_ticker', 'market_get_candles', 'market_get_orderbook', 'market_get_instruments'];
const requiredAccountTools = ['account_get_balance', 'account_get_trade_fee'];
const requiredSpotTools = ['spot_place_order', 'spot_get_orders', 'spot_get_fills'];
const emptyContext = (): StartupMonitorContext => ({ referencePrices: {}, openedAtBySymbol: {}, protectionPlans: {}, protectionModes: {} });
const validTime = (now: number, timestamp: number, maxAge: number): boolean => Number.isSafeInteger(timestamp)
  && timestamp <= now && now - timestamp <= maxAge;

/** One process owns one connector, one position monitor, and explicit per-symbol regime values. */
export class AuraAgent {
  private stateValue: AgentState = 'BOOTING';
  private monitor: PositionMonitor | null;
  private readonly now: () => number;
  private readonly regimes = new Map<string, RegimeHysteresisState>();
  private readonly evaluations = new Map<string, SymbolEvaluation>();
  private readonly metadata = new Map<string, { minOrderSize: number; quantityStep: number; tickSize: number }>();
  private readonly feeRates = new Map<string, SpotFeeRate>();
  private latestLlm: LlmDecisionResult | null = null;
  private latestCertificate: RiskCertificate | null = null;
  private selected: CandidateSignal | null = null;
  private degradedReason: string | null = null;
  private pending: { request: OrderRequest; plan: ApprovedOrderPlan; exchangeOrderId: string | null } | null = null;
  private readonly clientIds = new Set<string>();
  private readonly protectionOverrides = new Map<string, OpenPosition>();
  private busy = false;
  private active: Promise<unknown> | null = null;
  private slowTimer: ReturnType<typeof setInterval> | null = null;
  private fastTimer: ReturnType<typeof setInterval> | null = null;
  private stopping = false;
  private reconnectAttempts = 0;
  private sequence = 0;
  private mcpHealthy = false;

  constructor(readonly config: AgentConfig, private readonly deps: AgentDependencies) {
    this.monitor = deps.monitor ?? null;
    this.now = deps.now ?? Date.now;
  }

  get state(): AgentState { return this.stateValue; }
  get positionMonitor(): PositionMonitor | null { return this.monitor; }
  get pendingOrderId(): string | null { return this.pending?.request.clientOrderId ?? null; }

  private check(checks: { name: string; passed: boolean; detail: string }[], name: string,
    passed: boolean, detail: string): void { checks.push({ name, passed, detail }); }

  private async referencePrices(): Promise<Record<string, number>> {
    const result: Record<string, number> = {};
    for (const symbol of this.config.symbols) {
      const ticker = await this.deps.market.getTicker(symbol);
      if (ticker.symbol !== symbol || !validTime(this.now(), ticker.timestamp, this.config.risk.maxDataAgeMs)
        || !Number.isFinite(ticker.last) || ticker.last <= 0) throw new Error(`Stale or invalid ticker for ${symbol}`);
      result[symbol] = ticker.last;
    }
    return result;
  }

  /** Read-only exchange preflight. No state-changing MCP tool is called. */
  async preflight(): Promise<PreflightReport> {
    if (this.stopping) return { passed: false, state: this.stateValue, checks: [], positionSymbol: null };
    this.stateValue = 'PREFLIGHT';
    const checks: { name: string; passed: boolean; detail: string }[] = [];
    this.check(checks, 'SYMBOLS', this.config.symbols.length > 0 && new Set(this.config.symbols).size === this.config.symbols.length,
      this.config.symbols.join(','));
    this.check(checks, 'MCP_MODE', this.config.connectorMode === 'mcp', 'Official MCP transport required');
    this.check(checks, 'PROFILE', this.deps.connector.profile === this.config.profile, this.config.profile);
    this.check(checks, 'RISK_CONFIG', validRiskConfig(this.config.risk), 'Deterministic risk configuration');
    this.check(checks, 'LLM_CONFIG', this.config.llmConfigured, 'Market Critic configuration');
    try {
      await this.deps.execution.start();
      const health = await this.deps.connector.healthCheck();
      this.mcpHealthy = health.connected && health.status === 'HEALTHY' && health.profile === this.config.profile;
      this.check(checks, 'MCP_HEALTH', this.mcpHealthy, health.reason ?? health.status);
      const tools = new Set((await this.deps.connector.listTools()).map(tool => tool.name));
      for (const [name, names] of [['MARKET_TOOLS', requiredMarketTools], ['ACCOUNT_TOOLS', requiredAccountTools],
        ['SPOT_TOOLS', requiredSpotTools]] as const) {
        this.check(checks, name, names.every(tool => tools.has(tool)), names.filter(tool => !tools.has(tool)).join(',') || 'Available');
      }
      for (const symbol of this.config.symbols) {
        const [meta, fee, orders, fills] = await Promise.all([
          this.deps.market.getInstrumentMeta(symbol), this.deps.market.getSpotFeeRate(symbol),
          this.deps.market.getOpenSpotOrders(symbol), this.deps.market.getRecentSpotFills(symbol),
        ]);
        const validMeta = meta.symbol === symbol && meta.instrumentId === symbol
          && [meta.minOrderSize, meta.quantityStep, meta.tickSize].every(x => Number.isFinite(x) && x > 0);
        this.check(checks, `INSTRUMENT:${symbol}`, validMeta, validMeta ? 'Size, lot and tick available' : 'Invalid metadata');
        this.check(checks, `FEE:${symbol}`, fee.symbol === symbol && Number.isFinite(fee.takerRate), 'Fee readable');
        this.check(checks, `ORDERS_FILLS:${symbol}`, orders.every(o => o.symbol === symbol)
          && fills.every(f => f.symbol === symbol), 'Read-only order/fill history');
        if (validMeta) this.metadata.set(symbol, meta);
        this.feeRates.set(symbol, fee);
      }
      const balance = await this.deps.market.getTradingBalanceSnapshot();
      this.check(checks, 'BALANCES', balance.totalEquityUsd > 0 && Number.isFinite(balance.totalEquityUsd), 'Balance and holdings readable');
      const snapshot = await this.deps.execution.getStartupSnapshot();
      const snapshotValid = snapshot.profile === this.config.profile && snapshot.positions.every(p => this.config.symbols.includes(p.symbol))
        && snapshot.positions.length <= 1 && snapshot.openOrders.every(o => this.config.symbols.includes(o.symbol))
        && snapshot.recentFills.every(fill => this.config.symbols.includes(fill.symbol))
        && this.config.symbols.every(symbol => snapshot.feeRates.some(fee => fee.symbol === symbol));
      this.check(checks, 'STARTUP_SNAPSHOT', snapshotValid, 'Exchange positions, orders, fills and fees');
      const references = await this.referencePrices();
      this.check(checks, 'FRESH_MARKET', true, 'Ticker freshness confirmed for all symbols');
      if (!this.monitor) this.monitor = this.deps.createMonitor?.(snapshot)
        ?? new InMemoryPositionMonitor(snapshot.totalEquityUsd, snapshot.timestamp,
          snapshot.balances.find(item => item.currency === 'USDT')?.available ?? snapshot.totalEquityUsd);
      const local = await this.monitor.getOpenPosition();
      const context = this.deps.startupContext ? await this.deps.startupContext(snapshot, references)
        : local ? { referencePrices: references, openedAtBySymbol: { [local.symbol]: local.openedAt },
          protectionPlans: { [local.symbol]: local.protectionPlan },
          protectionModes: { [local.symbol]: local.protectionMode } } : emptyContext();
      const restored = this.monitor.reconcileStartup(snapshot, context);
      this.check(checks, 'MONITOR_RECONCILIATION', restored.status === 'RESTORED', restored.reason);
      const unresolvedOrders = snapshot.openOrders.length > 0 || this.pending !== null;
      this.check(checks, 'UNRESOLVED_ORDERS', !unresolvedOrders, unresolvedOrders ? 'Open or ambiguous order exists' : 'None');
      const capabilities = (this.deps.execution as ExecutionEngine & {
        getCapabilities?: () => ExecutionTools | null;
      }).getCapabilities?.();
      const protectionKnown = capabilities
        ? capabilities.clientOrderIdSupported && !!capabilities.getBalance
          && (capabilities.attachedProtectionSupported || !!capabilities.getFills)
        : tools.has('spot_place_order') && tools.has('spot_get_fills');
      this.check(checks, 'PROTECTION_CAPABILITY', protectionKnown,
        !protectionKnown ? 'No verified protection capability'
          : capabilities?.attachedProtectionSupported ? 'Exchange-side attached protection available'
            : 'Client-side monitored protection available');
      const passed = checks.every(item => item.passed);
      this.stateValue = passed && this.config.profile === 'live' && this.config.liveTradingArmed ? 'LIVE_READY' : 'OBSERVE_ONLY';
      if (!passed) this.degradedReason = checks.filter(item => !item.passed).map(item => item.name).join(',');
      else this.degradedReason = null;
      return { passed, state: this.stateValue, checks, positionSymbol: restored.position?.symbol ?? null };
    } catch (error) {
      this.mcpHealthy = false;
      this.stateValue = 'OBSERVE_ONLY';
      const detail = error instanceof Error ? error.message : 'Unknown preflight error';
      this.degradedReason = detail;
      this.check(checks, 'EXCHANGE_PREFLIGHT', false, detail);
      return { passed: false, state: this.stateValue, checks, positionSymbol: (await this.monitor?.getOpenPosition())?.symbol ?? null };
    }
  }

  /** Activation is separate from read-only preflight, and cannot promote demo. */
  activate(): boolean {
    if (this.stateValue !== 'LIVE_READY' || this.config.profile !== 'live'
      || !this.config.liveTradingArmed || !this.mcpHealthy || this.pending || this.stopping) return false;
    this.stateValue = 'LIVE';
    return true;
  }

  private async evaluate(symbol: string, position: OpenPosition | null): Promise<SymbolEvaluation> {
    const previous = this.regimes.get(symbol) ?? null;
    if (this.deps.evaluateSymbol) return this.deps.evaluateSymbol(symbol, previous, position);
    const [candles, book, fee] = await Promise.all([
      this.deps.market.getCandles(symbol, this.config.primaryBar, 150),
      this.deps.market.getOrderBook(symbol, 5),
      this.deps.market.getSpotFeeRate(symbol),
    ]);
    const evaluationTime = this.now();
    const barMs = 180_000;
    const sorted = [...candles].filter(candle => candle.timestamp + barMs <= evaluationTime)
      .sort((a, b) => a.timestamp - b.timestamp);
    const latestClosed = sorted.at(-1);
    if (!latestClosed || evaluationTime - (latestClosed.timestamp + barMs) > barMs)
      throw new Error(`Stale closed candles for ${symbol}`);
    const feature = calculateFeatures(symbol, { candles: sorted, orderBook: book }, evaluationTime);
    if (feature.dataAgeMs > this.config.risk.maxDataAgeMs) throw new Error(`Stale order book for ${symbol}`);
    const transition = transitionRegime(symbol, feature, previous);
    const candidate = generateCandidate(symbol, feature, transition.decision,
      { openLong: position ? { symbol: position.symbol, quantity: position.quantity } : null },
      { feeBpsPerSide: Math.abs(fee.takerRate) * 10_000, estimatedSlippageBpsPerSide: feature.spreadBps / 2 },
      { opportunityScoreThreshold: this.config.risk.opportunityScoreThreshold,
        minEdgeCostRatio: this.config.risk.minEdgeCostRatio, maxDataAgeMs: this.config.risk.maxDataAgeMs });
    return { symbol, feature, regime: transition.decision, nextRegimeState: transition.nextState, candidate, fee };
  }

  private retain(evaluation: SymbolEvaluation): void {
    if (evaluation.symbol !== evaluation.feature.symbol || evaluation.symbol !== evaluation.candidate.symbol
      || evaluation.symbol !== evaluation.regime.symbol || evaluation.symbol !== evaluation.nextRegimeState.symbol)
      throw new Error('Cross-symbol evaluation mismatch');
    this.regimes.set(evaluation.symbol, evaluation.nextRegimeState);
    this.evaluations.set(evaluation.symbol, evaluation);
  }

  private currentPosition(position: OpenPosition | null): OpenPosition | null {
    if (!position) return null;
    const override = this.protectionOverrides.get(position.symbol);
    return override ? { ...position, protection: { ...override.protection } } : position;
  }

  private async submitProtectiveExit(position: OpenPosition, price: number): Promise<void> {
    if (this.pending || this.stateValue !== 'LIVE' || !this.deps.connector.isConnected()) return;
    const id = this.nextId();
    const plan: ApprovedOrderPlan = { symbol: position.symbol, side: 'SELL', quantity: position.quantity,
      estimatedNotional: position.quantity * price, referencePrice: price,
      protection: position.protectionPlan, cycleId: id, decisionId: id, clientOrderId: id };
    await this.submit(plan);
  }

  private async monitorHeld(slow: boolean): Promise<string> {
    const monitor = this.monitor;
    if (!monitor) return 'Monitor unavailable';
    const held = this.currentPosition(await monitor.getOpenPosition());
    if (!held) return 'Flat';
    const symbol = held.symbol;
    const ticker = await this.deps.market.getTicker(symbol);
    if (ticker.symbol !== symbol || !validTime(this.now(), ticker.timestamp, this.config.risk.maxDataAgeMs))
      throw new Error(`Stale held-symbol ticker ${symbol}`);
    monitor.updateMark(symbol, ticker.last, this.now());
    let updated = this.currentPosition(await monitor.getOpenPosition())!;
    updated = promoteBreakEven(symbol, updated, ticker.last, this.now());
    updated = activateTrailing(symbol, updated, ticker.last, this.now());
    const latest = this.evaluations.get(symbol);
    if (latest?.feature.atr && latest.feature.atr > 0) {
      updated = updateAtrTrailingStop(symbol, updated, ticker.last, latest.feature.atr,
        this.config.risk.initialStopAtrMultiplier, this.now());
    }
    this.protectionOverrides.set(symbol, updated);
    const equity = await monitor.getEquitySnapshot();
    const immediateReason = (this.deps.killSwitch?.() ?? false) ? 'KILL_SWITCH'
      : equity.currentDrawdown >= this.config.risk.hardPeakDrawdownPct ? 'HARD_DRAWDOWN'
        : hardStopBreached(symbol, updated, ticker.last) ? 'HARD_STOP'
          : takeProfitReached(symbol, updated, ticker.last) ? 'TAKE_PROFIT'
            : timeStopReached(symbol, updated, this.now(), this.config.maxHoldingMs) ? 'TIME_STOP' : null;
    if (immediateReason) {
      await this.submitProtectiveExit(updated, ticker.last);
      await this.deps.persistPosition?.(this.currentPosition(await monitor.getOpenPosition()));
      return immediateReason;
    }
    if (slow) this.retain(await this.evaluate(symbol, updated));
    const evaluation = this.evaluations.get(symbol);
    const invalidRegime = evaluation?.regime.stableRegime === 'TRENDING_DOWN';
    const volatilityExit = evaluation?.regime.stableRegime === 'HIGH_VOLATILITY';
    const reason = volatilityExit ? 'HIGH_VOLATILITY' : invalidRegime ? 'REGIME_INVALIDATION' : null;
    if (reason) await this.submitProtectiveExit(updated, ticker.last);
    await this.deps.persistPosition?.(this.currentPosition(await monitor.getOpenPosition()));
    return reason ?? 'Protected';
  }

  private nextId(): string { this.sequence += 1; return `aura${this.now()}_${this.sequence}`.slice(0, 32); }

  private async submit(plan: ApprovedOrderPlan): Promise<string> {
    const result = await this.deps.execution.submitApprovedOrder(plan);
    this.clientIds.add(plan.clientOrderId);
    if (result.status === 'RECONCILE_REQUIRED' || result.status === 'ACCEPTED') {
      this.pending = { request: { symbol: plan.symbol, clientOrderId: plan.clientOrderId,
        exchangeOrderId: result.exchangeOrderId, cycleId: plan.cycleId, decisionId: plan.decisionId,
        side: plan.side, kind: 'MARKET', quantity: plan.quantity, limitPrice: null },
        plan, exchangeOrderId: result.exchangeOrderId };
      if (result.status === 'RECONCILE_REQUIRED') this.degrade('Ambiguous order; reconciliation required');
      await this.reconcilePending();
    } else if (result.status === 'CONNECTOR_FAILURE') this.degrade('Execution connector failure');
    return result.status;
  }

  private async reconcilePending(): Promise<void> {
    const pending = this.pending;
    if (!pending || !this.deps.connector.isConnected() || !this.monitor) return;
    const result = await this.deps.execution.reconcile(pending.request);
    if (result.order?.symbol === pending.plan.symbol
      && result.order.clientOrderId === pending.plan.clientOrderId
      && (result.order.state === 'CANCELLED' || result.order.state === 'REJECTED')
      && result.order.filledQuantity === 0) {
      this.pending = null;
      this.degradedReason = 'Order cancellation/rejection verified; full preflight required';
      return;
    }
    if (result.outcome !== 'FILLED') return;
    let exchangeOrderId = pending.exchangeOrderId ?? result.order?.exchangeOrderId ?? null;
    if (!exchangeOrderId) {
      const snapshot = await this.deps.execution.getStartupSnapshot();
      exchangeOrderId = snapshot.recentFills.find(fill => fill.symbol === pending.plan.symbol
        && fill.clientOrderId === pending.plan.clientOrderId)?.orderId ?? null;
    }
    if (!exchangeOrderId) return;
    const fills = (await this.deps.market.getRecentSpotFills(pending.plan.symbol))
      .filter(fill => fill.orderId === exchangeOrderId)
      .sort((a, b) => a.timestamp - b.timestamp);
    if (!fills.length) return;
    let total = 0;
    for (const fill of fills) {
      if (fill.symbol !== pending.plan.symbol || fill.side.toUpperCase() !== pending.plan.side) {
        this.degrade('Reconciled fill identity or side mismatch'); return;
      }
      const quote = pending.plan.symbol.split('-')[1];
      const base = pending.plan.symbol.split('-')[0];
      const fee = Math.abs(fill.fee) * (fill.feeCurrency === quote ? 1 : fill.feeCurrency === base ? fill.price : NaN);
      if (!Number.isFinite(fee)) { this.degrade('Unknown fill fee currency'); return; }
      const applied = this.monitor.processFill({ symbol: fill.symbol, clientOrderId: pending.plan.clientOrderId,
        exchangeOrderId: fill.orderId, fillId: fill.fillId, side: fill.side.toUpperCase() as 'BUY' | 'SELL',
        quantity: fill.quantity, price: fill.price, fee, timestamp: fill.timestamp },
      { allowSameSymbolIncrease: false, protectionPlan: pending.plan.protection,
        protectionMode: pending.plan.protection.protectionMode });
      if (applied.status !== 'APPLIED' && applied.status !== 'DUPLICATE_FILL') {
        this.degrade(`Monitor fill rejected: ${applied.status}`); return;
      }
      total += fill.quantity;
      if (applied.closedTradeOutcomeR !== null) this.monitor.recordDecision({ symbol: pending.plan.symbol,
        setupType: 'DETERMINISTIC_EXIT', regime: this.evaluations.get(pending.plan.symbol)?.regime.stableRegime ?? 'UNCERTAIN',
        resultCategory: 'CLOSED', outcomeR: applied.closedTradeOutcomeR,
        stopHit: false, timestamp: fill.timestamp });
    }
    if (total + 1e-12 < pending.plan.quantity) return;
    await this.deps.persistPosition?.(await this.monitor.getOpenPosition());
    this.pending = null;
    if (this.stateValue === 'DEGRADED') this.degradedReason = 'Order resolved; full preflight required';
  }

  private degrade(reason: string): void {
    if (this.stateValue !== 'HALTED') this.stateValue = 'DEGRADED';
    this.degradedReason = reason;
    this.mcpHealthy = false;
  }

  private async withLock<T>(fn: () => Promise<T>, skipped: T): Promise<T> {
    if (this.busy || this.stopping) return skipped;
    this.busy = true;
    const task = fn();
    this.active = task;
    try { return await task; }
    finally { this.active = null; this.busy = false; }
  }

  async runSlowCycle(): Promise<CycleResult> {
    return this.withLock(async () => {
      this.selected = null; this.latestLlm = null; this.latestCertificate = null;
      let result: CycleResult = { status: 'BLOCKED', selectedSymbol: null, reason: 'Not live' };
      try {
        if (this.stateValue !== 'LIVE' && this.stateValue !== 'OBSERVE_ONLY') return result;
        if (!this.deps.connector.isConnected()) { this.degrade('MCP disconnected'); return result; }
        await this.reconcilePending();
        if (this.pending) return { status: 'BLOCKED', selectedSymbol: null, reason: 'Order reconciliation pending' };
        const position = await this.monitor?.getOpenPosition() ?? null;
        if (position) {
          result = { status: 'MONITORING', selectedSymbol: null, reason: await this.monitorHeld(true) };
          return result;
        }
        const exchangeBeforeRanking = await this.deps.execution.getStartupSnapshot();
        if (exchangeBeforeRanking.profile !== this.config.profile || exchangeBeforeRanking.positions.length > 0
          || exchangeBeforeRanking.openOrders.length > 0) {
          this.degrade('Exchange holdings or orders changed while local monitor is flat');
          return { status: 'BLOCKED', selectedSymbol: null, reason: this.degradedReason! };
        }
        const evaluations: SymbolEvaluation[] = [];
        for (const symbol of this.config.symbols) {
          const evaluation = await this.evaluate(symbol, null);
          this.retain(evaluation);
          evaluations.push(evaluation);
        }
        const ranked = rankEntryCandidates(evaluations.map(item => item.candidate));
        const selected = ranked[0] ?? null;
        if (!selected) return { status: 'HOLD', selectedSymbol: null, reason: 'No eligible entry' };
        this.selected = selected;
        if (this.stateValue !== 'LIVE' || this.pending || !this.deps.connector.isConnected())
          return { status: 'BLOCKED', selectedSymbol: selected.symbol, reason: 'Observe-only or disconnected' };
        const other = evaluations.filter(item => item.symbol !== selected.symbol)
          .sort((a, b) => b.candidate.opportunityScore - a.candidate.opportunityScore || a.symbol.localeCompare(b.symbol))[0];
        if (!other) return { status: 'BLOCKED', selectedSymbol: selected.symbol, reason: 'Cross-market context unavailable' };
        const selectedEval = evaluations.find(item => item.symbol === selected.symbol)!;
        this.latestLlm = await this.deps.llm.evaluateSelectedCandidate({ candidate: selected,
          crossMarket: { selectedSymbol: selected.symbol, selectedOQS: selected.opportunityScore,
            otherSymbol: other.symbol, otherOQS: other.candidate.opportunityScore,
            otherRegime: other.regime.stableRegime },
          microstructure: { spreadBps: selectedEval.feature.spreadBps,
            obiTop5: selectedEval.feature.obiTop5, micropriceLeanBps: selectedEval.feature.micropriceLeanBps },
          position: { hasOpenLong: false, openLongSymbol: null },
          recentMemory: this.monitor?.getRecentDecisionMemory() ?? [] });
        const balance = await this.deps.market.getTradingBalanceSnapshot();
        const exchangeAtRisk = await this.deps.execution.getStartupSnapshot();
        const performance = await this.monitor!.getPerformanceState();
        const riskPosition = await this.monitor!.getOpenPosition();
        const riskOpenPositions = exchangeAtRisk.positions.map(position => {
          const reference = this.evaluations.get(position.symbol)?.feature.midPrice ?? position.averageEntryPrice ?? 0;
          const notional = position.quantity * reference;
          return { symbol: position.symbol, quantity: position.quantity, notional,
            exposurePct: notional / exchangeAtRisk.totalEquityUsd };
        });
        if (riskPosition && !riskOpenPositions.some(item => item.symbol === riskPosition.symbol)) {
          const notional = riskPosition.quantity * riskPosition.markPrice;
          riskOpenPositions.push({ symbol: riskPosition.symbol, quantity: riskPosition.quantity, notional,
            exposurePct: notional / exchangeAtRisk.totalEquityUsd });
        }
        const account = { equity: exchangeAtRisk.totalEquityUsd,
          availableQuoteBalance: exchangeAtRisk.balances.find(item => item.currency === 'USDT')?.available ?? 0,
          dayStartEquity: performance.dayStartEquity, peakEquity: Math.max(performance.peakEquity, exchangeAtRisk.totalEquityUsd),
          consecutiveLosses: performance.consecutiveLosses,
          lastLossTimestamp: this.monitor!.getRecentDecisionMemory().find(item => item.resultCategory === 'CLOSED'
            && item.outcomeR !== null && item.outcomeR < 0)?.timestamp ?? null,
          openPositions: riskOpenPositions,
          timestamp: Math.min(balance.timestamp, exchangeAtRisk.timestamp) };
        const id = this.nextId();
        const riskInput: PreTradeRiskInput = { candidate: selected, account,
          market: { symbol: selected.symbol, referencePrice: selectedEval.feature.midPrice,
            spreadBps: selectedEval.feature.spreadBps, atr: selectedEval.feature.atr,
            atrPctPercentile: selectedEval.feature.atrPctPercentile,
            dataAgeMs: selectedEval.feature.dataAgeMs, timestamp: selectedEval.feature.timestamp },
          config: this.config.risk, timestamp: this.now(), llmResult: this.latestLlm,
          clientOrderId: id, knownClientOrderIds: [...this.clientIds], cycleId: id, decisionId: id,
          killSwitchActive: this.deps.killSwitch?.() ?? false, cooldownUntil: null,
          protectionMode: 'CLIENT_SIDE' };
        let risk = evaluateEntryRisk(riskInput);
        if (risk.decision.approved && risk.plan) {
          const meta = this.metadata.get(selected.symbol);
          if (!meta) throw new Error(`Instrument metadata missing for ${selected.symbol}`);
          const rounded = Math.floor((risk.plan.quantity + 1e-12) / meta.quantityStep) * meta.quantityStep;
          const quantity = Number(rounded.toPrecision(15));
          if (!Number.isFinite(quantity) || quantity < meta.minOrderSize || quantity > risk.plan.quantity + 1e-10) {
            this.latestCertificate = risk.certificate;
            this.monitor?.recordDecision({ symbol: selected.symbol, setupType: selected.setupType,
              regime: selected.regime, resultCategory: 'REJECTED_RISK', outcomeR: null, stopHit: null,
              timestamp: this.now() });
            return { status: 'REJECTED', selectedSymbol: selected.symbol, reason: 'Approved size is below exchange minimum or lot step' };
          }
          risk = evaluateEntryRisk({ ...riskInput, requestedNotional: quantity * risk.plan.referencePrice });
        }
        this.latestCertificate = risk.certificate;
        if (exchangeAtRisk.profile !== this.config.profile || exchangeAtRisk.openOrders.length > 0
          || riskOpenPositions.length > 0 || await this.monitor?.getOpenPosition()) {
          this.degrade('Exchange position or open order appeared before execution');
          return { status: 'BLOCKED', selectedSymbol: selected.symbol, reason: this.degradedReason! };
        }
        if (!risk.decision.approved) {
          this.monitor?.recordDecision({ symbol: selected.symbol, setupType: selected.setupType,
            regime: selected.regime, resultCategory: this.latestLlm.status === 'SUCCESS' ? 'REJECTED_RISK' : 'REJECTED_LLM',
            outcomeR: null, stopHit: null, timestamp: this.now() });
          return { status: 'REJECTED', selectedSymbol: selected.symbol, reason: risk.decision.reason };
        }
        if (risk.certificate.verdict !== 'ALLOW' || !risk.plan)
          return { status: 'BLOCKED', selectedSymbol: selected.symbol, reason: 'Risk certificate did not allow' };
        const submission = await this.submit(risk.plan);
        return { status: submission === 'ACCEPTED' ? 'SUBMITTED' : 'BLOCKED',
          selectedSymbol: selected.symbol, reason: submission };
      } catch (error) {
        this.degrade(error instanceof Error ? error.message : 'Cycle failure');
        return { status: 'BLOCKED', selectedSymbol: this.selected?.symbol ?? null, reason: this.degradedReason ?? 'Cycle failure' };
      } finally { await this.publish(); }
    }, { status: 'SKIPPED', selectedSymbol: null, reason: 'Cycle already running or stopping' });
  }

  async runFastCycle(): Promise<void> {
    await this.withLock(async () => {
      if (this.stateValue === 'HALTED') return;
      try {
        if (!this.deps.connector.isConnected()) { this.degrade('MCP disconnected'); await this.recover(); return; }
        const health = await this.deps.connector.healthCheck();
        if (!health.connected || health.status !== 'HEALTHY') { this.degrade('MCP unhealthy'); await this.recover(); return; }
        this.mcpHealthy = true;
        await this.reconcilePending();
        if (this.stateValue === 'DEGRADED') {
          if (await this.monitor?.getOpenPosition()) await this.monitorHeld(false);
          await this.recover(); return;
        }
        await this.monitorHeld(false);
      } catch (error) { this.degrade(error instanceof Error ? error.message : 'Fast safety failure'); }
    }, undefined);
  }

  private async recover(): Promise<void> {
    if (this.reconnectAttempts >= this.config.maxReconnectAttempts || this.stopping) return;
    this.reconnectAttempts += 1;
    try {
      await this.deps.connector.connect();
      if (!this.deps.connector.isConnected()) return;
      if (this.pending) { await this.reconcilePending(); if (this.pending) return; }
      const report = await this.preflight();
      if (!report.passed) { this.degrade('Recovery preflight or reconciliation failed'); return; }
      if (report.state === 'LIVE_READY') this.activate();
      this.reconnectAttempts = 0;
    } catch (error) { this.degrade(error instanceof Error ? error.message : 'Reconnect failure'); }
  }

  async calibrate(): Promise<{ diagnostics: SignalCalibrationDiagnostics; spreads: Readonly<Record<string, number[]>>;
    atrPercentiles: Readonly<Record<string, number[]>> }> {
    if (this.stateValue === 'BOOTING') await this.preflight();
    if (!this.deps.connector.isConnected()) throw new Error('MCP unavailable');
    const candidates: CandidateSignal[] = [];
    const spreads: Record<string, number[]> = {};
    const atrPercentiles: Record<string, number[]> = {};
    const position = await this.monitor?.getOpenPosition() ?? null;
    for (const symbol of this.config.symbols) {
      const item = await this.evaluate(symbol, position);
      this.retain(item);
      candidates.push(item.candidate);
      spreads[symbol] = [item.feature.spreadBps];
      atrPercentiles[symbol] = [item.feature.atrPctPercentile];
    }
    return { diagnostics: summarizeSignalCalibration(candidates), spreads, atrPercentiles };
  }

  /** Explicit command only; it deliberately refuses to improvise a demo order or cleanup. */
  async demoSmoke(): Promise<{ passed: boolean; reason: string; preflight: PreflightReport }> {
    if (this.config.profile !== 'demo' || this.deps.connector.profile !== 'demo')
      return { passed: false, reason: 'Demo smoke requires a confirmed demo MCP profile',
        preflight: { passed: false, state: this.stateValue, checks: [], positionSymbol: null } };
    const preflight = await this.preflight();
    return { passed: false, reason: preflight.passed
      ? 'Safe demo order, protection, and cleanup cannot be proven; no order submitted'
      : 'Demo preflight failed; no order submitted', preflight };
  }

  startScheduling(): void {
    if (this.slowTimer || this.fastTimer || this.stopping) return;
    this.slowTimer = setInterval(() => { void this.runSlowCycle(); }, this.config.slowLoopIntervalMs);
    this.fastTimer = setInterval(() => { void this.runFastCycle(); }, this.config.fastLoopIntervalMs);
    void this.runSlowCycle();
  }

  async shutdown(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    if (this.slowTimer) clearInterval(this.slowTimer);
    if (this.fastTimer) clearInterval(this.fastTimer);
    this.slowTimer = null; this.fastTimer = null;
    await this.active?.catch(() => undefined);
    this.stateValue = 'HALTED';
    await this.publish();
    await this.deps.connector.disconnect();
    this.mcpHealthy = false;
  }

  private async publish(): Promise<void> {
    if (!this.deps.observer) return;
    try {
      const position = this.currentPosition(await this.monitor?.getOpenPosition() ?? null);
      const equity = await this.monitor?.getEquitySnapshot() ?? null;
      const markets = Object.fromEntries([...this.evaluations].map(([symbol, item]) => [symbol, {
        close: item.feature.close, spreadBps: item.feature.spreadBps,
        atrPctPercentile: item.feature.atrPctPercentile, regime: item.regime.stableRegime,
        candidateAction: item.candidate.action, oqs: item.candidate.opportunityScore,
        edgeCostRatio: item.candidate.edgeToCostRatio,
      }]));
      await this.deps.observer({ timestamp: this.now(), state: this.stateValue, mcpHealthy: this.mcpHealthy,
        symbols: [...this.config.symbols], markets, selectedSymbol: this.selected?.symbol ?? null,
        selectedOQS: this.selected?.opportunityScore ?? null,
        llm: this.latestLlm ? { status: this.latestLlm.status,
          action: this.latestLlm.status === 'SUCCESS' ? this.latestLlm.decision.action : null,
          riskFlag: this.latestLlm.status === 'SUCCESS' ? this.latestLlm.decision.risk_flag : null } : null,
        riskCertificate: this.latestCertificate,
        openPositionSymbol: position?.symbol ?? null,
        position: position ? { symbol: position.symbol, quantity: position.quantity,
          entryPrice: position.weightedAverageEntryPrice, markPrice: position.markPrice,
          stopPrice: position.protection.currentStopPrice } : null,
        equity: equity ? { starting: equity.startingEquity, current: equity.currentEquity, peak: equity.peakEquity,
          dailyPnl: equity.dailyPnl, dailyReturnPct: equity.dailyReturn * 100,
          currentDrawdownPct: equity.currentDrawdown * 100,
          maximumDrawdownPct: equity.maximumDrawdown * 100 } : null,
        riskMode: this.latestCertificate?.riskMode ?? null, degradedReason: this.degradedReason });
    } catch { /* The observer is never a decision authority. */ }
  }
}

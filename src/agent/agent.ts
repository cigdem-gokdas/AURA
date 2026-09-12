import { calculateFeatures } from '../features/calculate.js';
import type { FeatureSnapshot } from '../features/types.js';
import type { ExecutionEngine, OrderRequest, StartupExchangeSnapshot } from '../execution/types.js';
import type { LlmClient, LlmDecisionResult } from '../llm/types.js';
import type { MarketAdapter, SpotFeeRate, TradingBalanceSnapshot } from '../market/types.js';
import type { AuditEvent, AuditEventType } from '../memory/audit.js';
import { hardStopBreached, promoteBreakEven, activateTrailing, updateAtrTrailingStop,
  takeProfitReached, timeStopReached, regimeInvalidated } from '../monitor/protection.js';
import { InMemoryPositionMonitor } from '../monitor/monitor.js';
import type { OpenPosition, PositionMonitor, StartupMonitorContext } from '../monitor/types.js';
import type { OkxConnector } from '../okx/connector.js';
import { REQUIRED_READ_CAPABILITIES } from '../okx/capabilities.js';
import { transitionRegime } from '../regime/classify.js';
import type { RegimeDecision, RegimeHysteresisState } from '../regime/types.js';
import { evaluateEntryRisk } from '../risk/evaluate.js';
import type { ApprovedOrderPlan, PreTradeRiskInput, RiskCertificate, RiskMode } from '../risk/types.js';
import { summarizeSignalCalibration } from '../signal/calibration.js';
import { generateCandidate } from '../signal/generate.js';
import { rankEntryCandidates } from '../signal/rank.js';
import type { CandidateSignal, SignalCalibrationDiagnostics } from '../signal/types.js';
import { validRiskConfig, type AgentConfig } from './config.js';
import { ContextPulseCache, crossCheckIndicators, fetchPairEvidence,
  type AtkContextPulse, type AtkCrossMarketContext, type AtkIndicatorCrossCheck } from './atk-evidence.js';
import { DecisionProvenanceBuffer, traceNode, type DecisionProvenanceNode } from './provenance.js';
import { ReadOnlyExplainService, freezeJudgeSnapshot, type ExplainIntent, type JudgeSnapshot } from './judge.js';

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
    regime: string; candidateAction: string; oqs: number; edgeCostRatio: number;
    setupType?: string; obiTop5?: number; micropriceLeanBps?: number; dataAgeMs?: number }>>;
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
  readiness?: 'READY_FOR_OBSERVE' | 'READY_FOR_DEMO' | 'READY_FOR_LIVE' | 'BLOCKED';
  readLane?: { status: 'READY' | 'FAILED'; serverVersion: string | null; profile: string; readOnly: boolean; toolCount: number };
  writeLane?: { status: 'READY' | 'DISABLED' | 'FAILED'; serverVersion: string | null; profile: string; tools: readonly string[] };
  blockers?: readonly string[];
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
  audit?: (event: AuditEvent) => void | Promise<void>;
  persistPosition?: (position: OpenPosition | null) => Promise<void>;
  now?: () => number;
  /** Strategy seam for offline orchestration tests; production uses the existing feature/regime/signal modules. */
  evaluateSymbol?: (symbol: string, previous: RegimeHysteresisState | null, position: OpenPosition | null)
    => Promise<SymbolEvaluation>;
  killSwitch?: () => boolean;
}

const requiredMarketTools = ['market_get_ticker', 'market_get_candles', 'market_get_orderbook', 'market_get_instruments'];
const requiredAccountTools = ['account_get_balance', 'account_get_trade_fee'];
const requiredSpotReadTools = ['spot_get_orders', 'spot_get_fills'];
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
  private readonly contextPulse: ContextPulseCache;
  private readonly provenance = new DecisionProvenanceBuffer();
  private cycleNodes: DecisionProvenanceNode[] = [];
  private lastSnapshot: ObserverSnapshot | null = null;
  private lastPreflight: PreflightReport | null = null;
  private lastIndicatorChecks: AtkIndicatorCrossCheck[] = [];
  private lastPairContext: AtkCrossMarketContext | null = null;
  private lastPulse: AtkContextPulse | null = null;
  private readonly auditedTraceSequence = { READ: 0, WRITE: 0 };

  private audit(eventType: AuditEventType, payload: unknown,
    identity: Partial<Pick<AuditEvent, 'cycleId' | 'decisionId' | 'clientOrderId' | 'symbol'>> = {}): void {
    if (!this.deps.audit) return;
    try {
      void Promise.resolve(this.deps.audit({ eventType, timestamp: this.now(), payload, ...identity }))
        .catch(error => process.stderr.write(`AURA audit failure: ${error instanceof Error ? error.message : 'Unknown error'}\n`));
    } catch (error) {
      process.stderr.write(`AURA audit failure: ${error instanceof Error ? error.message : 'Unknown error'}\n`);
    }
  }

  private auditNewMcpTraces(cycleId?: string): void {
    try {
      const sources = [this.deps.connector.getRecentTraces?.() ?? [],
        this.deps.execution.getWriteTraces?.() ?? []];
      for (const traces of sources) traces.forEach((trace, index) => {
        const marker = trace.sequence ?? index + 1;
        if (marker <= this.auditedTraceSequence[trace.lane]) return;
        this.auditedTraceSequence[trace.lane] = marker;
        this.audit('ATK_MCP_CALL', trace, {
          ...(cycleId || trace.cycleId ? { cycleId: cycleId ?? trace.cycleId! } : {}),
          ...(trace.decisionId ? { decisionId: trace.decisionId } : {}),
          ...(trace.symbol ? { symbol: trace.symbol } : {}),
        });
      });
    } catch (error) {
      process.stderr.write(`AURA audit trace failure: ${error instanceof Error ? error.message : 'Unknown error'}\n`);
    }
  }

  private async bothLanesHealthy(): Promise<boolean> {
    const read = await this.deps.connector.healthCheck();
    const write = await this.deps.execution.getWriteHealth?.();
    return read.connected && read.status === 'HEALTHY' && read.profile === this.config.profile
      && (!write || (write.connected && write.status === 'HEALTHY' && write.profile === this.config.profile));
  }

  constructor(readonly config: AgentConfig, private readonly deps: AgentDependencies) {
    this.monitor = deps.monitor ?? null;
    this.now = deps.now ?? Date.now;
    this.contextPulse = new ContextPulseCache(config.contextPulseEnabled);
  }

  get state(): AgentState { return this.stateValue; }
  get positionMonitor(): PositionMonitor | null { return this.monitor; }
  get pendingOrderId(): string | null { return this.pending?.request.clientOrderId ?? null; }
  get latestProvenance() { return this.provenance.latest(); }
  getJudgeSnapshot(): JudgeSnapshot | null {
    if (!this.lastSnapshot) return null;
    const functional = structuredClone(this.lastSnapshot);
    const traces = [...(this.deps.connector.getRecentTraces?.() ?? []),
      ...(this.deps.execution.getWriteTraces?.() ?? [])]
      .sort((a, b) => a.timestamp - b.timestamp).slice(-100);
    const position = this.currentPosition(this.lastPositionForJudge);
    return freezeJudgeSnapshot({ timestamp: functional.timestamp, functional,
      reasoning: { selectedSymbol: functional.selectedSymbol,
        perSymbolOqs: Object.fromEntries(Object.entries(functional.markets).map(([symbol, market]) => [symbol, market.oqs])),
        criticVerdict: functional.llm?.action ?? null,
        counterThesis: this.latestLlm?.status === 'SUCCESS' ? this.latestLlm.decision.counter_thesis : null,
        riskCertificate: functional.riskCertificate },
      atk: { readLane: this.lastPreflight?.readLane ? structuredClone(this.lastPreflight.readLane) : null,
        writeLane: this.lastPreflight?.writeLane ? structuredClone(this.lastPreflight.writeLane) : null,
        uniqueToolsUsed: [...new Set(traces.map(trace => trace.toolName))].sort(),
        recentTraces: traces.map(trace => ({ ...trace })), latestProvenance: this.provenance.latest(),
        recentDecisions: this.provenance.recent().map(item => ({ ...item, nodes: [] })),
        recentDecisionMemory: this.monitor?.getRecentDecisionMemory() ?? [],
        indicatorCrossChecks: this.lastIndicatorChecks.map(item => ({ ...item })),
        crossMarket: this.lastPairContext ? { ...this.lastPairContext, symbols: [...this.lastPairContext.symbols] as [string, string] } : null,
        contextPulse: this.lastPulse ? { ...this.lastPulse } : null },
      safety: { liveArmed: this.config.liveTradingArmed, riskMode: functional.riskMode,
        protectionMode: position?.protectionMode ?? null, reconciliationPending: this.pending !== null,
        degradedReason: functional.degradedReason } });
  }
  private lastPositionForJudge: OpenPosition | null = null;
  explainCurrentState(intent: ExplainIntent) {
    return new ReadOnlyExplainService(() => this.getJudgeSnapshot()).explainCurrentState(intent);
  }

  private node(source: DecisionProvenanceNode['source'], description: string,
    symbol: string | null, result: string, success = true): void {
    this.cycleNodes.push({ source, lane: null, toolName: null, symbol,
      timestamp: this.now(), description, latencyMs: null, success, result });
  }

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
    let readLaneReport: NonNullable<PreflightReport['readLane']> = { status: 'FAILED', serverVersion: null,
      profile: this.config.profile, readOnly: false, toolCount: 0 };
    let writeLaneReport: NonNullable<PreflightReport['writeLane']> = { status: 'FAILED', serverVersion: null,
      profile: this.config.profile, tools: [] };
    this.check(checks, 'SYMBOLS', this.config.symbols.length > 0 && new Set(this.config.symbols).size === this.config.symbols.length,
      this.config.symbols.join(','));
    this.check(checks, 'MCP_MODE', this.config.connectorMode === 'mcp', 'Official MCP transport required');
    this.check(checks, 'PROFILE', this.deps.connector.profile === this.config.profile, this.config.profile);
    this.check(checks, 'READ_ONLY', this.deps.connector.readOnly !== false, 'READ lane must use --read-only');
    this.check(checks, 'RISK_CONFIG', validRiskConfig(this.config.risk), 'Deterministic risk configuration');
    this.check(checks, 'LLM_CONFIG', this.config.llmConfigured, 'Market Critic configuration');
    this.check(checks, 'LIVE_TRADING_ARMED', true, String(this.config.liveTradingArmed));
    try {
      await this.deps.execution.start();
      const health = await this.deps.connector.healthCheck();
      const writeHealth = await this.deps.execution.getWriteHealth?.();
      const readReady = health.connected && health.status === 'HEALTHY' && health.profile === this.config.profile;
      const writeReady = !writeHealth || (writeHealth.connected && writeHealth.status === 'HEALTHY'
        && writeHealth.profile === this.config.profile);
      this.mcpHealthy = readReady && writeReady;
      this.check(checks, 'READ_LANE', readReady, health.reason ?? health.status);
      this.check(checks, 'WRITE_LANE', writeReady, writeHealth?.reason ?? writeHealth?.status ?? 'Compatible execution adapter');
      const tools = new Set((await this.deps.connector.listTools()).map(tool => tool.name));
      readLaneReport = { status: readReady ? 'READY' : 'FAILED',
        serverVersion: this.deps.connector.getServerVersion?.() ?? null,
        profile: this.config.profile, readOnly: this.deps.connector.readOnly === true,
        toolCount: tools.size };
      writeLaneReport = { status: writeReady ? 'READY' : 'FAILED',
        serverVersion: this.deps.execution.getWriteServerVersion?.() ?? null,
        profile: this.config.profile, tools: this.deps.execution.getWriteToolNames?.() ?? [] };
      for (const [name, names] of [['MARKET_TOOLS', requiredMarketTools], ['ACCOUNT_TOOLS', requiredAccountTools],
        ['SPOT_READ_TOOLS', requiredSpotReadTools]] as const) {
        this.check(checks, name, names.every(tool => tools.has(tool)), names.filter(tool => !tools.has(tool)).join(',') || 'Available');
      }
      const readRegistry = this.deps.connector.getCapabilities?.();
      if (readRegistry) this.check(checks, 'READ_CAPABILITIES', readRegistry.missing(REQUIRED_READ_CAPABILITIES).length === 0,
        readRegistry.missing(REQUIRED_READ_CAPABILITIES).join(',') || 'Available');
      let actualReadOnly = this.deps.connector.readOnly === true;
      if (readRegistry?.has('SYSTEM_CAPABILITIES')) {
        const tool = readRegistry.resolve('SYSTEM_CAPABILITIES')!;
        const result = await this.deps.connector.callTool<unknown>(tool, {});
        const capabilities = (result as { capabilities?: { readOnly?: unknown } })?.capabilities;
        actualReadOnly = capabilities?.readOnly === true;
        this.check(checks, 'SERVER_READ_ONLY', actualReadOnly, actualReadOnly
          ? 'ATK server confirms read-only mode' : 'ATK server did not confirm read-only mode');
      }
      readLaneReport.readOnly = actualReadOnly;
      if (this.deps.connector.readOnly === true && !actualReadOnly) readLaneReport.status = 'FAILED';
      const writeNames = this.deps.execution.getWriteToolNames?.() ?? [];
      if (writeNames.length > 0) this.check(checks, 'WRITE_CAPABILITIES',
        writeNames.includes('spot_place_order') && writeNames.every(name => name.startsWith('spot_')),
        writeNames.includes('spot_place_order') ? 'Spot order placement discovered' : 'Spot order placement missing');
      const executionCapabilities = this.deps.execution.getCapabilities?.();
      if (executionCapabilities) {
        this.check(checks, 'EXECUTION_CAPABILITY', !!executionCapabilities.placeOrder
          && executionCapabilities.clientOrderIdSupported, 'Spot order and client ID schema');
        this.check(checks, 'RECONCILIATION_CAPABILITY', !!executionCapabilities.getOrder
          && !!executionCapabilities.getOrders && !!executionCapabilities.getFills,
        'READ lane order, open-order and fill queries');
      }
      for (const symbol of this.config.symbols) {
        const [meta, fee, orders, fills] = await Promise.all([
          this.deps.market.getInstrumentMeta(symbol), this.deps.market.getSpotFeeRate(symbol),
          this.deps.market.getOpenSpotOrders(symbol), this.deps.market.getRecentSpotFills(symbol),
        ]);
        const validMeta = meta.symbol === symbol && meta.instrumentId === symbol
          && [meta.minOrderSize, meta.quantityStep, meta.tickSize].every(x => Number.isFinite(x) && x > 0);
        this.check(checks, `INSTRUMENT:${symbol}`, validMeta, validMeta
          ? `minSize=${meta.minOrderSize} lot=${meta.quantityStep} tick=${meta.tickSize}` : 'Invalid metadata');
        this.check(checks, `FEE:${symbol}`, fee.symbol === symbol && Number.isFinite(fee.takerRate),
          `taker=${fee.takerRate} maker=${fee.makerRate}`);
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
      const capabilities = executionCapabilities;
      const protectionKnown = capabilities
        ? capabilities.clientOrderIdSupported && !!capabilities.getBalance
          && (capabilities.attachedProtectionSupported || !!capabilities.getFills)
        : (writeNames.length ? writeNames.includes('spot_place_order') : tools.has('spot_place_order'))
          && tools.has('spot_get_fills');
      this.check(checks, 'PROTECTION_CAPABILITY', protectionKnown,
        !protectionKnown ? 'No verified protection capability'
          : capabilities?.attachedProtectionSupported ? 'Exchange-side attached protection available'
            : 'Client-side monitored protection available');
      const passed = checks.every(item => item.passed);
      this.stateValue = passed && this.config.profile === 'live' && this.config.liveTradingArmed ? 'LIVE_READY' : 'OBSERVE_ONLY';
      if (!passed) this.degradedReason = checks.filter(item => !item.passed).map(item => item.name).join(',');
      else this.degradedReason = null;
      const readiness = !passed ? 'BLOCKED' : this.config.profile === 'demo' ? 'READY_FOR_DEMO'
        : this.config.liveTradingArmed ? 'READY_FOR_LIVE' : 'READY_FOR_OBSERVE';
      const report: PreflightReport = { passed, state: this.stateValue, checks, positionSymbol: restored.position?.symbol ?? null,
        readiness, blockers: checks.filter(item => !item.passed).map(item => item.name),
        readLane: readLaneReport, writeLane: writeLaneReport };
      this.lastPreflight = report;
      this.audit('PREFLIGHT', { passed, readiness, checks, positionSymbol: report.positionSymbol });
      this.audit('ATK_MCP_HEALTH', { readLane: readLaneReport, writeLane: writeLaneReport });
      this.audit('STATE_TRANSITION', { state: this.stateValue });
      this.auditNewMcpTraces();
      return report;
    } catch (error) {
      this.mcpHealthy = false;
      this.stateValue = 'OBSERVE_ONLY';
      const detail = error instanceof Error ? error.message : 'Unknown preflight error';
      this.degradedReason = detail;
      try {
        const health = await this.deps.connector.healthCheck();
        readLaneReport = { status: health.connected && health.status === 'HEALTHY'
          && this.deps.connector.readOnly === true ? 'READY' : 'FAILED',
          serverVersion: this.deps.connector.getServerVersion?.() ?? null,
          profile: this.config.profile, readOnly: this.deps.connector.readOnly === true,
          toolCount: (await this.deps.connector.listTools()).length };
      } catch { /* Preserve the last known READ report. */ }
      try {
        const health = await this.deps.execution.getWriteHealth?.();
        if (health) writeLaneReport = { status: health.connected && health.status === 'HEALTHY'
          && (this.deps.execution.getWriteToolNames?.() ?? ['spot_place_order']).includes('spot_place_order')
          ? 'READY' : 'FAILED',
          serverVersion: this.deps.execution.getWriteServerVersion?.() ?? null,
          profile: this.config.profile, tools: this.deps.execution.getWriteToolNames?.() ?? [] };
      } catch { /* Preserve the last known WRITE report. */ }
      this.check(checks, 'EXCHANGE_PREFLIGHT', false, detail);
      const report: PreflightReport = { passed: false, state: this.stateValue, checks,
        positionSymbol: (await this.monitor?.getOpenPosition())?.symbol ?? null,
        readiness: 'BLOCKED', blockers: checks.filter(item => !item.passed).map(item => item.name),
        readLane: readLaneReport, writeLane: writeLaneReport };
      this.lastPreflight = report;
      this.audit('PREFLIGHT', { passed: false, checks, error: detail });
      this.audit('ERROR', { stage: 'PREFLIGHT', reason: detail });
      this.audit('ATK_MCP_HEALTH', { readLane: readLaneReport, writeLane: writeLaneReport });
      this.auditNewMcpTraces();
      return report;
    }
  }

  /** Activation is separate from read-only preflight, and cannot promote demo. */
  activate(): boolean {
    if (this.stateValue !== 'LIVE_READY' || this.config.profile !== 'live'
      || !this.config.liveTradingArmed || !this.mcpHealthy || this.pending || this.stopping) return false;
    this.stateValue = 'LIVE';
    this.audit('STATE_TRANSITION', { state: 'LIVE' });
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
    if (this.pending || this.stateValue !== 'LIVE' || !this.mcpHealthy) return;
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
    if (updated.protection.currentStopPrice !== held.protection.currentStopPrice
      || updated.protection.breakEvenActivated !== held.protection.breakEvenActivated
      || updated.protection.trailingActivated !== held.protection.trailingActivated) {
      this.audit('PROTECTION', { reason: 'STOP_UPDATED', stopPrice: updated.protection.currentStopPrice,
        breakEvenActivated: updated.protection.breakEvenActivated,
        trailingActivated: updated.protection.trailingActivated, mode: updated.protectionMode }, { symbol });
    }
    this.protectionOverrides.set(symbol, updated);
    const equity = await monitor.getEquitySnapshot();
    const immediateReason = (this.deps.killSwitch?.() ?? false) ? 'KILL_SWITCH'
      : equity.currentDrawdown >= this.config.risk.hardPeakDrawdownPct ? 'HARD_DRAWDOWN'
        : hardStopBreached(symbol, updated, ticker.last) ? 'HARD_STOP'
          : takeProfitReached(symbol, updated, ticker.last) ? 'TAKE_PROFIT'
            : timeStopReached(symbol, updated, this.now(), this.config.maxHoldingMs) ? 'TIME_STOP' : null;
    if (immediateReason) {
      this.audit('PROTECTION', { reason: immediateReason, stopPrice: updated.protection.currentStopPrice,
        markPrice: ticker.last, mode: updated.protectionMode }, { symbol });
      const exitRequested = !this.pending && this.stateValue === 'LIVE' && this.mcpHealthy;
      await this.submitProtectiveExit(updated, ticker.last);
      if (exitRequested) this.audit('EXIT', { phase: 'REQUESTED', reason: immediateReason,
        requestedQuantity: updated.quantity, referencePrice: ticker.last }, { symbol });
      await this.deps.persistPosition?.(this.currentPosition(await monitor.getOpenPosition()));
      return immediateReason;
    }
    if (slow) this.retain(await this.evaluate(symbol, updated));
    const evaluation = this.evaluations.get(symbol);
    const invalidRegime = evaluation?.regime.stableRegime === 'TRENDING_DOWN';
    const volatilityExit = evaluation?.regime.stableRegime === 'HIGH_VOLATILITY';
    const reason = volatilityExit ? 'HIGH_VOLATILITY' : invalidRegime ? 'REGIME_INVALIDATION' : null;
    if (reason) await this.submitProtectiveExit(updated, ticker.last);
    if (reason) this.audit('PROTECTION', { reason, markPrice: ticker.last,
      stopPrice: updated.protection.currentStopPrice, mode: updated.protectionMode }, { symbol });
    await this.deps.persistPosition?.(this.currentPosition(await monitor.getOpenPosition()));
    return reason ?? 'Protected';
  }

  private nextId(): string { this.sequence += 1; return `aura${this.now()}_${this.sequence}`.slice(0, 32); }

  private async submit(plan: ApprovedOrderPlan): Promise<string> {
    const identity = { cycleId: plan.cycleId, decisionId: plan.decisionId,
      clientOrderId: plan.clientOrderId, symbol: plan.symbol };
    this.audit('EXECUTION_SUBMITTED', { side: plan.side, quantity: plan.quantity,
      referencePrice: plan.referencePrice, protectionMode: plan.protection.protectionMode }, identity);
    const result = await this.deps.execution.submitApprovedOrder(plan);
    this.audit('EXECUTION_RESULT', { status: result.status, orderId: result.exchangeOrderId,
      reason: result.reason, protectionMode: result.protectionMode,
      protectionVerified: result.protectionVerified }, identity);
    this.clientIds.add(plan.clientOrderId);
    if (result.status === 'RECONCILE_REQUIRED' || result.status === 'ACCEPTED') {
      this.pending = { request: { symbol: plan.symbol, clientOrderId: plan.clientOrderId,
        exchangeOrderId: result.exchangeOrderId, cycleId: plan.cycleId, decisionId: plan.decisionId,
        side: plan.side, kind: 'MARKET', quantity: plan.quantity, limitPrice: null },
        plan, exchangeOrderId: result.exchangeOrderId };
      if (result.status === 'RECONCILE_REQUIRED') {
        this.audit('RECONCILIATION_REQUIRED', { orderId: result.exchangeOrderId,
          reason: result.reason }, identity);
        this.degrade('Ambiguous order; reconciliation required');
      }
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
      this.audit('RECONCILIATION_RESOLVED', { outcome: result.order.state,
        orderId: result.order.exchangeOrderId }, { cycleId: pending.plan.cycleId,
        decisionId: pending.plan.decisionId, clientOrderId: pending.plan.clientOrderId,
        symbol: pending.plan.symbol });
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
      if (applied.status === 'APPLIED') this.audit('FILL', { orderId: fill.orderId,
        fillId: fill.fillId, side: fill.side, quantity: fill.quantity, price: fill.price,
        fee, closedTradePnl: applied.closedTradePnl }, { cycleId: pending.plan.cycleId,
        decisionId: pending.plan.decisionId, clientOrderId: pending.plan.clientOrderId,
        symbol: fill.symbol });
      if (applied.closedTradeOutcomeR !== null) this.monitor.recordDecision({ symbol: pending.plan.symbol,
        setupType: 'DETERMINISTIC_EXIT', regime: this.evaluations.get(pending.plan.symbol)?.regime.stableRegime ?? 'UNCERTAIN',
        resultCategory: 'CLOSED', outcomeR: applied.closedTradeOutcomeR,
        stopHit: false, timestamp: fill.timestamp });
      if (applied.closedTradePnl !== null) this.audit('EXIT', { phase: 'CLOSED',
        orderId: fill.orderId, price: fill.price, quantity: fill.quantity,
        pnl: applied.closedTradePnl, outcomeR: applied.closedTradeOutcomeR },
      { cycleId: pending.plan.cycleId, decisionId: pending.plan.decisionId,
        clientOrderId: pending.plan.clientOrderId, symbol: fill.symbol });
    }
    if (total + 1e-12 < pending.plan.quantity) return;
    await this.deps.persistPosition?.(await this.monitor.getOpenPosition());
    this.pending = null;
    this.audit('RECONCILIATION_RESOLVED', { outcome: 'FILLED', orderId: exchangeOrderId,
      quantity: total }, { cycleId: pending.plan.cycleId, decisionId: pending.plan.decisionId,
      clientOrderId: pending.plan.clientOrderId, symbol: pending.plan.symbol });
    if (this.stateValue === 'DEGRADED') this.degradedReason = 'Order resolved; full preflight required';
  }

  private degrade(reason: string): void {
    if (this.stateValue !== 'HALTED') this.stateValue = 'DEGRADED';
    this.degradedReason = reason;
    this.mcpHealthy = false;
    this.audit('DEGRADED', { reason, state: this.stateValue });
    this.audit('STATE_TRANSITION', { state: this.stateValue, reason });
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
      this.lastIndicatorChecks = []; this.lastPairContext = null;
      this.cycleNodes = [];
      const provenanceCycleId = this.nextId();
      const readBefore = this.deps.connector.getRecentTraces?.() ?? [];
      const writeBefore = this.deps.execution.getWriteTraces?.() ?? [];
      const readTraceStart = readBefore.at(-1)?.sequence ?? readBefore.length;
      const writeTraceStart = writeBefore.at(-1)?.sequence ?? writeBefore.length;
      let result: CycleResult = { status: 'BLOCKED', selectedSymbol: null, reason: 'Not live' };
      const finish = (next: CycleResult): CycleResult => { result = next; return next; };
      try {
        if (this.stateValue !== 'LIVE' && this.stateValue !== 'OBSERVE_ONLY') return result;
        if (!await this.bothLanesHealthy()) { this.degrade('MCP lane disconnected');
          return finish({ status: 'BLOCKED', selectedSymbol: null, reason: 'MCP lane disconnected' }); }
        await this.reconcilePending();
        if (this.pending) return finish({ status: 'BLOCKED', selectedSymbol: null, reason: 'Order reconciliation pending' });
        const position = await this.monitor?.getOpenPosition() ?? null;
        if (position) {
          result = { status: 'MONITORING', selectedSymbol: null, reason: await this.monitorHeld(true) };
          this.node('LOCAL', 'Held-position protection and reconciliation', position.symbol, result.reason);
          return result;
        }
        const exchangeBeforeRanking = await this.deps.execution.getStartupSnapshot();
        if (exchangeBeforeRanking.profile !== this.config.profile || exchangeBeforeRanking.positions.length > 0
          || exchangeBeforeRanking.openOrders.length > 0) {
          this.degrade('Exchange holdings or orders changed while local monitor is flat');
          return finish({ status: 'BLOCKED', selectedSymbol: null, reason: this.degradedReason! });
        }
        const evaluations: SymbolEvaluation[] = [];
        for (const symbol of this.config.symbols) {
          const evaluation = await this.evaluate(symbol, null);
          this.retain(evaluation);
          evaluations.push(evaluation);
          this.audit('MARKET_ACCEPTED', { price: evaluation.feature.close,
            spreadBps: evaluation.feature.spreadBps, dataAgeMs: evaluation.feature.dataAgeMs },
          { cycleId: provenanceCycleId, symbol });
          this.audit('FEATURES_COMPUTED', { emaFast: evaluation.feature.emaFast,
            emaSlow: evaluation.feature.emaSlow, atr: evaluation.feature.atr,
            adx: evaluation.feature.adx, obiTop5: evaluation.feature.obiTop5,
            micropriceLeanBps: evaluation.feature.micropriceLeanBps },
          { cycleId: provenanceCycleId, symbol });
          this.audit('REGIME_DECISION', { regime: evaluation.regime.stableRegime,
            rawProposal: evaluation.regime.rawProposedRegime }, { cycleId: provenanceCycleId, symbol });
          this.audit('CANDIDATE', { action: evaluation.candidate.action,
            setupType: evaluation.candidate.setupType, oqs: evaluation.candidate.opportunityScore,
            edgeCostRatio: evaluation.candidate.edgeToCostRatio }, { cycleId: provenanceCycleId, symbol });
          this.node('LOCAL', 'Features, regime and opportunity score', symbol,
            `${evaluation.regime.stableRegime}; OQS ${evaluation.candidate.opportunityScore}`);
        }
        const ranked = rankEntryCandidates(evaluations.map(item => item.candidate));
        const selected = ranked[0] ?? null;
        this.audit('OPPORTUNITY_SELECTED', { selectedSymbol: selected?.symbol ?? null,
          oqs: selected?.opportunityScore ?? null,
          rankedSymbols: ranked.map(item => item.symbol) }, { cycleId: provenanceCycleId,
          ...(selected ? { symbol: selected.symbol } : {}) });
        this.node('LOCAL', 'Deterministic cross-symbol ranking', selected?.symbol ?? null,
          selected ? `Selected ${selected.symbol}` : 'No eligible entry');
        if (!selected) return finish({ status: 'HOLD', selectedSymbol: null, reason: 'No eligible entry' });
        this.selected = selected;
        if (this.stateValue !== 'LIVE' || this.pending || !await this.bothLanesHealthy())
          return finish({ status: 'BLOCKED', selectedSymbol: selected.symbol, reason: 'Observe-only or disconnected' });
        const other = evaluations.filter(item => item.symbol !== selected.symbol)
          .sort((a, b) => b.candidate.opportunityScore - a.candidate.opportunityScore || a.symbol.localeCompare(b.symbol))[0];
        if (!other) return finish({ status: 'BLOCKED', selectedSymbol: selected.symbol, reason: 'Cross-market context unavailable' });
        const selectedEval = evaluations.find(item => item.symbol === selected.symbol)!;
        const optionalEvidence = await Promise.allSettled([
          crossCheckIndicators(this.deps.connector, selectedEval.feature),
          fetchPairEvidence(this.deps.connector, selected.symbol, other.symbol, this.now()),
          this.contextPulse.get(this.deps.connector, this.config.symbols, this.now()),
        ]);
        this.lastIndicatorChecks = optionalEvidence[0].status === 'fulfilled' ? optionalEvidence[0].value : [];
        this.lastPairContext = optionalEvidence[1].status === 'fulfilled' ? optionalEvidence[1].value
          : { symbols: [selected.symbol, other.symbol], status: 'UNAVAILABLE', spread: null, timestamp: this.now() };
        this.lastPulse = optionalEvidence[2].status === 'fulfilled' ? optionalEvidence[2].value : null;
        this.latestLlm = await this.deps.llm.evaluateSelectedCandidate({ candidate: selected,
          crossMarket: { selectedSymbol: selected.symbol, selectedOQS: selected.opportunityScore,
            otherSymbol: other.symbol, otherOQS: other.candidate.opportunityScore,
            otherRegime: other.regime.stableRegime },
          microstructure: { spreadBps: selectedEval.feature.spreadBps,
            obiTop5: selectedEval.feature.obiTop5, micropriceLeanBps: selectedEval.feature.micropriceLeanBps },
          position: { hasOpenLong: false, openLongSymbol: null },
          recentMemory: this.monitor?.getRecentDecisionMemory() ?? [],
          indicatorCrossChecks: this.lastIndicatorChecks,
          atkCrossMarket: this.lastPairContext,
          contextPulse: this.lastPulse });
        this.audit('MARKET_CRITIC_RESULT', this.latestLlm.status === 'SUCCESS'
          ? { status: this.latestLlm.status, verdict: this.latestLlm.decision.action,
            counter_thesis: this.latestLlm.decision.counter_thesis,
            riskFlag: this.latestLlm.decision.risk_flag,
            setupQuality: this.latestLlm.decision.setup_quality }
          : { status: this.latestLlm.status }, { cycleId: provenanceCycleId, symbol: selected.symbol });
        this.node('LLM', 'Market Critic reviewed selected candidate', selected.symbol,
          this.latestLlm.status === 'SUCCESS' ? this.latestLlm.decision.action : this.latestLlm.status,
          this.latestLlm.status === 'SUCCESS');
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
            this.audit('RISK_CERTIFICATE', risk.certificate, { cycleId: provenanceCycleId,
              decisionId: id, clientOrderId: id, symbol: selected.symbol });
            this.monitor?.recordDecision({ symbol: selected.symbol, setupType: selected.setupType,
              regime: selected.regime, resultCategory: 'REJECTED_RISK', outcomeR: null, stopHit: null,
              timestamp: this.now() });
            return finish({ status: 'REJECTED', selectedSymbol: selected.symbol, reason: 'Approved size is below exchange minimum or lot step' });
          }
          risk = evaluateEntryRisk({ ...riskInput, requestedNotional: quantity * risk.plan.referencePrice });
        }
        this.latestCertificate = risk.certificate;
        this.audit('RISK_CERTIFICATE', risk.certificate, { cycleId: provenanceCycleId,
          decisionId: id, clientOrderId: id, symbol: selected.symbol });
        if (risk.certificate.riskMode === 'LOCKDOWN') this.audit('LOCKDOWN',
          { reason: risk.decision.reason }, { cycleId: provenanceCycleId, symbol: selected.symbol });
        this.node('RISK', 'Deterministic Risk Certificate', selected.symbol,
          risk.certificate.verdict, risk.certificate.verdict === 'ALLOW');
        if (exchangeAtRisk.profile !== this.config.profile || exchangeAtRisk.openOrders.length > 0
          || riskOpenPositions.length > 0 || await this.monitor?.getOpenPosition()) {
          this.degrade('Exchange position or open order appeared before execution');
          return finish({ status: 'BLOCKED', selectedSymbol: selected.symbol, reason: this.degradedReason! });
        }
        if (!risk.decision.approved) {
          this.monitor?.recordDecision({ symbol: selected.symbol, setupType: selected.setupType,
            regime: selected.regime, resultCategory: this.latestLlm.status === 'SUCCESS' ? 'REJECTED_RISK' : 'REJECTED_LLM',
            outcomeR: null, stopHit: null, timestamp: this.now() });
          return finish({ status: 'REJECTED', selectedSymbol: selected.symbol, reason: risk.decision.reason });
        }
        if (risk.certificate.verdict !== 'ALLOW' || !risk.plan)
          return finish({ status: 'BLOCKED', selectedSymbol: selected.symbol, reason: 'Risk certificate did not allow' });
        const submission = await this.submit(risk.plan);
        this.node('LOCAL', 'Execution submission and reconciliation', selected.symbol, submission,
          submission === 'ACCEPTED');
        return finish({ status: submission === 'ACCEPTED' ? 'SUBMITTED' : 'BLOCKED',
          selectedSymbol: selected.symbol, reason: submission });
      } catch (error) {
        this.degrade(error instanceof Error ? error.message : 'Cycle failure');
        this.audit('ERROR', { stage: 'SLOW_CYCLE', reason: this.degradedReason },
          { cycleId: provenanceCycleId, ...(this.selected ? { symbol: this.selected.symbol } : {}) });
        this.node('LOCAL', 'Cycle failed closed', this.selected?.symbol ?? null, 'BLOCKED', false);
        return finish({ status: 'BLOCKED', selectedSymbol: this.selected?.symbol ?? null, reason: this.degradedReason ?? 'Cycle failure' });
      } finally {
        const newTraces = (all: readonly import('../okx/telemetry.js').AtkToolTrace[], marker: number) =>
          all.some(trace => trace.sequence !== undefined)
            ? all.filter(trace => (trace.sequence ?? 0) > marker) : all.slice(marker);
        const traces = [...newTraces(this.deps.connector.getRecentTraces?.() ?? [], readTraceStart),
          ...newTraces(this.deps.execution.getWriteTraces?.() ?? [], writeTraceStart)];
        this.auditNewMcpTraces(provenanceCycleId);
        this.provenance.record({ cycleId: provenanceCycleId, timestamp: this.now(),
          selectedSymbol: this.selected?.symbol ?? null,
          result: result.status,
          summary: { symbol: this.selected?.symbol ?? null, setupType: this.selected?.setupType ?? null,
            oqs: this.selected?.opportunityScore ?? null, selection: this.selected ? 'SELECTED' : 'NOT_SELECTED',
            criticVerdict: this.latestLlm?.status === 'SUCCESS' ? this.latestLlm.decision.action : this.latestLlm?.status ?? null,
            counterThesis: this.latestLlm?.status === 'SUCCESS' ? this.latestLlm.decision.counter_thesis : null,
            riskResult: this.latestCertificate?.verdict ?? null,
            primaryRejectionReason: result.status === 'REJECTED' ? result.reason
              : this.latestCertificate?.gates.find(gate => gate.status === 'FAIL')?.reason ?? null,
            executionResult: result.status === 'SUBMITTED' ||
              (result.status === 'BLOCKED' && ['RECONCILE_REQUIRED', 'CONNECTOR_FAILURE', 'REJECTED',
                'DUPLICATE', 'INVALID_PLAN'].includes(result.reason)) ? result.reason : null,
            outcomeR: null, pnl: null },
          nodes: [...traces.map(traceNode), ...this.cycleNodes].sort((a, b) => a.timestamp - b.timestamp) });
        this.audit('DECISION_PROVENANCE', this.provenance.latest(),
          { cycleId: provenanceCycleId,
            ...(this.selected ? { symbol: this.selected.symbol } : {}) });
        await this.publish();
      }
    }, { status: 'SKIPPED', selectedSymbol: null, reason: 'Cycle already running or stopping' });
  }

  async runFastCycle(): Promise<void> {
    await this.withLock(async () => {
      if (this.stateValue === 'HALTED') return;
      try {
        if (!await this.bothLanesHealthy()) { this.degrade('MCP lane unhealthy'); await this.recover(); return; }
        this.mcpHealthy = true;
        await this.reconcilePending();
        if (this.stateValue === 'DEGRADED') {
          if (await this.monitor?.getOpenPosition()) await this.monitorHeld(false);
          await this.recover(); return;
        }
        await this.monitorHeld(false);
      } catch (error) {
        this.degrade(error instanceof Error ? error.message : 'Fast safety failure');
        this.audit('ERROR', { stage: 'FAST_CYCLE', reason: this.degradedReason });
      } finally {
        this.auditNewMcpTraces();
      }
    }, undefined);
  }

  private async recover(): Promise<void> {
    if (this.reconnectAttempts >= this.config.maxReconnectAttempts || this.stopping) return;
    this.reconnectAttempts += 1;
    try {
      await this.deps.connector.connect();
      await this.deps.execution.start();
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
    const result = { diagnostics: summarizeSignalCalibration(candidates), spreads, atrPercentiles };
    this.audit('CALIBRATION', result);
    return result;
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
    this.audit('STATE_TRANSITION', { state: 'HALTED' });
    await this.publish();
    await this.deps.execution.stop?.();
    await this.deps.connector.disconnect();
    this.mcpHealthy = false;
  }

  private async publish(): Promise<void> {
    try {
      const position = this.currentPosition(await this.monitor?.getOpenPosition() ?? null);
      this.lastPositionForJudge = position;
      const equity = await this.monitor?.getEquitySnapshot() ?? null;
      const markets = Object.fromEntries([...this.evaluations].map(([symbol, item]) => [symbol, {
        close: item.feature.close, spreadBps: item.feature.spreadBps,
        atrPctPercentile: item.feature.atrPctPercentile, regime: item.regime.stableRegime,
        candidateAction: item.candidate.action, oqs: item.candidate.opportunityScore,
        edgeCostRatio: item.candidate.edgeToCostRatio, setupType: item.candidate.setupType,
        obiTop5: item.feature.obiTop5, micropriceLeanBps: item.feature.micropriceLeanBps,
        dataAgeMs: item.feature.dataAgeMs,
      }]));
      const snapshot: ObserverSnapshot = { timestamp: this.now(), state: this.stateValue, mcpHealthy: this.mcpHealthy,
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
        riskMode: this.latestCertificate?.riskMode ?? null, degradedReason: this.degradedReason };
      this.lastSnapshot = structuredClone(snapshot);
      const observing = this.deps.observer?.(structuredClone(snapshot));
      if (observing) void Promise.resolve(observing).catch(() => undefined);
    } catch { /* The observer is never a decision authority. */ }
  }
}

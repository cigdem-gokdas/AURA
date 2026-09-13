import { calculateFeatures } from '../features/calculate.js';
import { randomUUID } from 'node:crypto';
import type { FeatureSnapshot } from '../features/types.js';
import type { AttachedProtectionLink, DemoSmokeExecutionResult, DemoSmokeRequest, DemoSmokeStage,
  ExchangePositionSnapshot, ExecutionEngine, OrderRequest, OrderStatus, OrderSubmissionResult,
  ProtectionCancelResult, ProtectionSignature, StartupExchangeSnapshot } from '../execution/types.js';
import { minimumDemoSmokeQuantity } from '../execution/smoke-size.js';
import { protectionSignatureMatches, protectionTriggers } from '../execution/engine.js';
import type { RecentSpotFill } from '../market/types.js';
import type { LlmClient, LlmDecisionResult } from '../llm/types.js';
import type { MarketAdapter, SpotFeeRate, TradingBalanceSnapshot } from '../market/types.js';
import { selectLiquidUniverse, type UniverseSelection } from '../market/universe.js';
import type { AuditEvent, AuditEventType } from '../memory/audit.js';
import { hardStopBreached, promoteBreakEven, activateTrailing, updateAtrTrailingStop,
  takeProfitReached, timeStopReached, regimeInvalidated } from '../monitor/protection.js';
import { InMemoryPositionMonitor } from '../monitor/monitor.js';
import type { OpenPosition, PositionMonitor, StartupMonitorContext } from '../monitor/types.js';
import type { OkxConnector } from '../okx/connector.js';
import { createOkxClientId, isAuraOkxClientId } from '../okx/client-id.js';
import { REQUIRED_READ_CAPABILITIES } from '../okx/capabilities.js';
import { transitionRegime } from '../regime/classify.js';
import type { RegimeDecision, RegimeHysteresisState } from '../regime/types.js';
import { evaluateEntryRisk } from '../risk/evaluate.js';
import type { ApprovedOrderPlan, PreTradeRiskInput, RiskCertificate, RiskMode } from '../risk/types.js';
import { summarizeSignalCalibration } from '../signal/calibration.js';
import { generateCandidate } from '../signal/generate.js';
import { costContextFromOkxTakerFee } from '../signal/cost.js';
import { rankEntryCandidates } from '../signal/rank.js';
import type { CandidateSignal, SignalCalibrationDiagnostics } from '../signal/types.js';
import { validRiskConfig, type AgentConfig } from './config.js';
import { ContextPulseCache, crossCheckIndicators, fetchPairEvidence,
  type AtkContextPulse, type AtkCrossMarketContext, type AtkIndicatorCrossCheck } from './atk-evidence.js';
import { DecisionProvenanceBuffer, traceNode, type DecisionProvenanceNode } from './provenance.js';
import { ReadOnlyExplainService, freezeJudgeSnapshot, type ExplainIntent, type JudgeSnapshot } from './judge.js';
import { OwnershipAmbiguityError } from './recovery.js';
import { selectDemoSmokeMarket } from './demo-smoke.js';

export type AgentState = 'BOOTING' | 'PREFLIGHT' | 'OBSERVE_ONLY' | 'LIVE_READY' | 'LIVE' | 'DEGRADED' | 'HALTED';

export interface SymbolEvaluation {
  symbol: string;
  feature: FeatureSnapshot;
  regime: RegimeDecision;
  nextRegimeState: RegimeHysteresisState;
  candidate: CandidateSignal;
  fee: SpotFeeRate;
}

export interface ObservedPosition {
  symbol: string; quantity: number; entryPrice: number; markPrice: number; stopPrice: number;
  unrealizedPnl?: number; realizedPnl?: number; takeProfitPrice?: number | null;
  breakEvenActivated?: boolean; trailingActivated?: boolean; protectionMode?: string;
}

export interface ObserverSnapshot {
  timestamp: number;
  state: AgentState;
  mcpHealthy: boolean;
  symbols: readonly string[];
  universe?: UniverseSelection | null;
  markets: Readonly<Record<string, { close: number; spreadBps: number; atrPctPercentile: number;
    regime: string; candidateAction: string; oqs: number; edgeCostRatio: number;
    setupType?: string; obiTop5?: number; micropriceLeanBps?: number; dataAgeMs?: number }>>;
  selectedSymbol: string | null;
  selectedOQS: number | null;
  llm: { status: string; action: string | null; riskFlag: string | null; confidence?: number | null;
    regimeConfirmation?: string | null; setupQuality?: string | null; reason?: string | null } | null;
  riskCertificate: RiskCertificate | null;
  openPositionSymbol: string | null;
  openPositionSymbols?: readonly string[];
  maxConcurrentPositions?: number;
  position: ObservedPosition | null;
  positions?: readonly ObservedPosition[];
  equity: { starting: number; current: number; peak: number; dailyPnl: number; dailyReturnPct: number;
    currentDrawdownPct: number; maximumDrawdownPct: number } | null;
  riskMode: RiskMode | null;
  degradedReason: string | null;
  unmanagedInventory?: readonly ExchangePositionSnapshot[];
}

export interface PreflightReport {
  passed: boolean;
  state: AgentState;
  checks: readonly { name: string; passed: boolean; detail: string }[];
  positionSymbol: string | null;
  positionSymbols?: readonly string[];
  universe?: UniverseSelection | null;
  unmanagedInventory?: readonly ExchangePositionSnapshot[];
  readiness?: 'READY_FOR_OBSERVE' | 'READY_FOR_DEMO' | 'READY_FOR_LIVE' | 'BLOCKED';
  readLane?: { status: 'READY' | 'FAILED'; serverVersion: string | null; profile: string; readOnly: boolean; toolCount: number };
  writeLane?: { status: 'READY' | 'DISABLED' | 'FAILED'; serverVersion: string | null; profile: string; tools: readonly string[] };
  blockers?: readonly string[];
}

interface PendingOrder {
  request: OrderRequest;
  plan: ApprovedOrderPlan;
  exchangeOrderId: string | null;
  protectionIds: readonly string[];
}

export interface AttachedProtectionSmokeResult {
  passed: boolean;
  reason: string;
  stages: readonly string[];
  evidence: {
    symbol: string;
    entryClientOrderId: string | null;
    entryOrderId: string | null;
    protectionMode: string | null;
    protectionVerified: boolean;
    protectionIds: readonly string[];
    linkedPendingProtection: number;
    netOwnedBase: number;
    exitClientOrderId: string | null;
    exitOrderId: string | null;
    cleanupStatus: string | null;
    dustQuantity: number;
  };
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
  persistPositions?: (positions: readonly OpenPosition[]) => Promise<void>;
  recoverySymbols?: () => Promise<readonly string[]>;
  now?: () => number;
  /** Strategy seam for offline orchestration tests; production uses the existing feature/regime/signal modules. */
  evaluateSymbol?: (symbol: string, previous: RegimeHysteresisState | null, position: OpenPosition | null)
    => Promise<SymbolEvaluation>;
  killSwitch?: () => boolean;
  /** CLI notice before any demo-smoke placement; unused by autonomous loops. */
  demoSmokeNotice?: (line: string) => void;
  smokeRecovery?: { begin(request: Pick<DemoSmokeRequest, 'symbol' | 'cycleId' | 'entryClientOrderId'>,
    startedAt: number): Promise<void>; clear(entryClientOrderId: string): Promise<void> };
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
  private universeSymbols: string[];
  private universeSelection: UniverseSelection | null = null;
  private latestLlm: LlmDecisionResult | null = null;
  private latestCertificate: RiskCertificate | null = null;
  private selected: CandidateSignal | null = null;
  private degradedReason: string | null = null;
  private unmanagedInventory: ExchangePositionSnapshot[] = [];
  private ownershipReconciliationPending = false;
  private pending: PendingOrder | null = null;
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
  private entriesDisarmed = false;
  private killSwitchLatched = false;
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

  private killSwitchActive(): boolean { return this.killSwitchLatched || (this.deps.killSwitch?.() ?? false); }

  /** Runtime disarm is one-way; rearming requires a fresh, fully checked agent:run. */
  disarmEntries(): void {
    this.entriesDisarmed = true;
    this.audit('STATE_TRANSITION', { control: 'DISARM', entriesDisarmed: true });
    void this.publish();
  }

  /** Latch before any await, then run deterministic protection as soon as the active cycle releases its lock. */
  engageKillSwitch(): void {
    this.entriesDisarmed = true;
    this.killSwitchLatched = true;
    this.audit('STATE_TRANSITION', { control: 'KILL', entriesDisarmed: true, protectiveExitRequested: true });
    void this.publish();
    const active = this.active;
    void (async () => {
      await active?.catch(() => undefined);
      if (!this.stopping) await this.runFastCycle();
    })().catch(error => this.degrade(error instanceof Error ? error.message : 'Kill-switch protection cycle failed'));
  }

  constructor(readonly config: AgentConfig, private readonly deps: AgentDependencies) {
    this.monitor = deps.monitor ?? null;
    this.now = deps.now ?? Date.now;
    this.contextPulse = new ContextPulseCache(config.contextPulseEnabled);
    this.universeSymbols = [...config.symbols];
  }

  private async openPositions(): Promise<readonly OpenPosition[]> {
    if (!this.monitor) return [];
    if (this.monitor.getOpenPositions) return this.monitor.getOpenPositions();
    const single = await this.monitor.getOpenPosition();
    return single ? [single] : [];
  }

  private async persistPositions(): Promise<void> {
    const positions = (await this.openPositions()).map(item => this.currentPosition(item)!);
    if (this.deps.persistPositions) await this.deps.persistPositions(positions);
    else if (positions.length <= 1) await this.deps.persistPosition?.(positions[0] ?? null);
    else throw new Error('Multi-position checkpoint persistence unavailable');
  }

  private async refreshUniverse(force = false): Promise<void> {
    if (!force && this.universeSelection
      && this.now() - this.universeSelection.evaluatedAt < this.config.universeRefreshMs) return;
    if (this.deps.market.getSpotTickers24h && this.deps.market.getSpotInstrumentListings) {
      const [tickers, instruments] = await Promise.all([
        this.deps.market.getSpotTickers24h(), this.deps.market.getSpotInstrumentListings(),
      ]);
      const selection = selectLiquidUniverse(tickers, instruments, this.config.universeSize,
        this.config.min24hQuoteVolumeUsdt, this.now(), this.config.risk.maxDataAgeMs);
      if (selection.selected.length < 2) throw new Error('Fewer than two liquid USDT spot pairs passed universe selection');
      this.universeSelection = selection;
      this.universeSymbols = selection.selected.map(item => item.symbol);
      this.audit('UNIVERSE_SELECTION', selection);
    } else if (!this.universeSymbols.length) {
      throw new Error('READ-lane bulk spot ticker/instrument capability unavailable');
    }
    const held = (await this.openPositions()).map(item => item.symbol);
    const recovery = await this.deps.recoverySymbols?.() ?? [];
    this.config.symbols.splice(0, this.config.symbols.length,
      ...new Set([...this.universeSymbols, ...held, ...recovery]));
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
      safety: { liveArmed: this.config.liveTradingArmed && !this.entriesDisarmed
        && !this.killSwitchActive(), riskMode: functional.riskMode,
        protectionMode: position?.protectionMode ?? null,
        protectionModes: Object.fromEntries((functional.positions ?? []).map(item =>
          [item.symbol, item.protectionMode ?? 'UNAVAILABLE'])),
        reconciliationPending: this.pending !== null || this.ownershipReconciliationPending,
        degradedReason: functional.degradedReason } });
  }
  private lastPositionForJudge: OpenPosition | null = null;
  private lastProtectionCleanup: ProtectionCancelResult | null = null;
  private lastExitSubmission: OrderSubmissionResult | null = null;
  private resetVerificationEvidence(): void { this.lastProtectionCleanup = null; this.lastExitSubmission = null; }
  private verificationEvidence(): { exit: OrderSubmissionResult | null; cleanup: ProtectionCancelResult | null } {
    return { exit: this.lastExitSubmission, cleanup: this.lastProtectionCleanup };
  }
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

  /** Wait out bounded exchange/local clock skew; feature validation still rejects future or stale data. */
  private async settleClockSkew(timestamp: number): Promise<number> {
    const now = this.now();
    const futureMs = timestamp - now;
    if (futureMs > 0 && futureMs <= 2_000) {
      await new Promise<void>(resolve => setTimeout(resolve, futureMs + 1));
      return this.now();
    }
    return now;
  }

  private async referencePrices(): Promise<Record<string, number>> {
    const result: Record<string, number> = {};
    for (const symbol of this.config.symbols) {
      const ticker = await this.deps.market.getTicker(symbol);
      const now = await this.settleClockSkew(ticker.timestamp);
      if (ticker.symbol !== symbol || !validTime(now, ticker.timestamp, this.config.risk.maxDataAgeMs)
        || !Number.isFinite(ticker.last) || ticker.last <= 0) throw new Error(`Stale or invalid ticker for ${symbol}`);
      result[symbol] = ticker.last;
    }
    return result;
  }

  /** Read-only exchange preflight. No state-changing MCP tool is called. */
  async preflight(): Promise<PreflightReport> {
    if (this.stopping) return { passed: false, state: this.stateValue, checks: [], positionSymbol: null };
    this.stateValue = 'PREFLIGHT';
    this.unmanagedInventory = [];
    this.ownershipReconciliationPending = false;
    const checks: { name: string; passed: boolean; detail: string }[] = [];
    let readLaneReport: NonNullable<PreflightReport['readLane']> = { status: 'FAILED', serverVersion: null,
      profile: this.config.profile, readOnly: false, toolCount: 0 };
    let writeLaneReport: NonNullable<PreflightReport['writeLane']> = { status: 'FAILED', serverVersion: null,
      profile: this.config.profile, tools: [] };
    this.check(checks, 'UNIVERSE_CONFIG', this.config.universeSize >= 2
      && this.config.min24hQuoteVolumeUsdt > 0, 'Daily USDT spot liquidity policy');
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
      await this.refreshUniverse(true);
      this.check(checks, 'SYMBOLS', this.universeSymbols.length >= 2
        && new Set(this.universeSymbols).size === this.universeSymbols.length,
        this.universeSymbols.join(','));
      this.check(checks, 'UNIVERSE_SELECTION', this.universeSelection !== null
        || !this.deps.market.getSpotTickers24h,
        this.universeSelection ? `minimum24hUSDT=${this.universeSelection.minimumQuoteVolume24h}; `
          + `excludedLiquidity=${this.universeSelection.excludedForLiquidity}; `
          + this.universeSelection.selected.map(item => `${item.symbol}:${item.quoteVolume24h}`).join(', ')
          : 'Fixed-symbol test adapter');
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
        const capabilities = (result as { capabilities?: { readOnly?: unknown; hasAuth?: unknown; demo?: unknown } })?.capabilities;
        actualReadOnly = capabilities?.readOnly === true;
        this.check(checks, 'SERVER_READ_ONLY', actualReadOnly, actualReadOnly
          ? 'ATK server confirms read-only mode' : 'ATK server did not confirm read-only mode');
        // ATK reports whether the selected profile actually loaded credentials and which
        // trading mode it is in. A missing [profiles.<name>] section otherwise surfaces
        // only as opaque failures on every authenticated call.
        if (typeof capabilities?.hasAuth === 'boolean') {
          this.check(checks, 'SERVER_AUTH', capabilities.hasAuth, capabilities.hasAuth
            ? 'ATK profile credentials loaded'
            : `ATK loaded no credentials for the selected ${this.config.profile} profile; add its [profiles.<name>] section to ~/.okx/config.toml`);
        }
        if (typeof capabilities?.demo === 'boolean') {
          const expectedDemo = this.config.profile === 'demo';
          this.check(checks, 'SERVER_MODE', capabilities.demo === expectedDemo, capabilities.demo === expectedDemo
            ? `ATK server confirms ${this.config.profile} mode`
            : `ATK server reports demo=${String(capabilities.demo)} while AURA expects ${this.config.profile}`);
        }
      }
      readLaneReport.readOnly = actualReadOnly;
      if (this.deps.connector.readOnly === true && !actualReadOnly) readLaneReport.status = 'FAILED';
      const writeNames = this.deps.execution.getWriteToolNames?.() ?? [];
      if (writeNames.length > 0) this.check(checks, 'WRITE_CAPABILITIES',
        writeNames.includes('spot_place_order'),
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
        && new Set(snapshot.positions.map(p => p.symbol)).size === snapshot.positions.length
        && snapshot.openOrders.every(o => this.config.symbols.includes(o.symbol))
        && snapshot.recentFills.every(fill => this.config.symbols.includes(fill.symbol))
        && this.config.symbols.every(symbol => snapshot.feeRates.some(fee => fee.symbol === symbol));
      this.check(checks, 'STARTUP_SNAPSHOT', snapshotValid, 'Exchange positions, orders, fills and fees');
      const references = await this.referencePrices();
      this.check(checks, 'FRESH_MARKET', true, 'Ticker freshness confirmed for all symbols');
      if (!this.monitor) this.monitor = this.deps.createMonitor?.(snapshot)
        ?? new InMemoryPositionMonitor(snapshot.totalEquityUsd, snapshot.timestamp,
          snapshot.balances.find(item => item.currency === 'USDT')?.available ?? snapshot.totalEquityUsd,
          this.config.risk.maxConcurrentPositions);
      const locals = await this.openPositions();
      const context = this.deps.startupContext ? await this.deps.startupContext(snapshot, references)
        : locals.length ? { referencePrices: references,
          openedAtBySymbol: Object.fromEntries(locals.map(item => [item.symbol, item.openedAt])),
          protectionPlans: Object.fromEntries(locals.map(item => [item.symbol, item.protectionPlan])),
          protectionModes: Object.fromEntries(locals.map(item => [item.symbol, item.protectionMode])) } : emptyContext();
      const managedPositions = context.managedPositions ?? snapshot.positions;
      this.unmanagedInventory = (context.unmanagedInventory ?? []).map(position => ({ ...position }));
      this.check(checks, 'POSITION_OWNERSHIP', managedPositions.length <= this.config.risk.maxConcurrentPositions,
        managedPositions.length <= this.config.risk.maxConcurrentPositions
          ? `${managedPositions.length} AURA-managed active trade(s)`
          : 'AURA-managed active trades exceed configured position cap');
      if (this.config.profile === 'live' && this.config.liveTradingArmed
        && managedPositions.length === 0 && this.deps.execution.liveEntryProtectionReady) {
        this.check(checks, 'LIVE_ENTRY_PROTECTION', this.deps.execution.liveEntryProtectionReady(),
          'Exchange-side entry protection must be verified before new live entries');
      }
      this.check(checks, 'UNMANAGED_INVENTORY', true,
        this.unmanagedInventory.length ? this.unmanagedInventory.map(position =>
          `${position.symbol} ${position.quantity}`).join(', ') : 'None');
      const managedSnapshot: StartupExchangeSnapshot = { ...snapshot, positions: managedPositions };
      const restored = this.monitor.reconcileStartup(managedSnapshot, context);
      this.check(checks, 'MONITOR_RECONCILIATION', restored.status === 'RESTORED', restored.reason);
      const unresolvedOrders = snapshot.openOrders.length > 0 || this.pending !== null;
      this.check(checks, 'UNRESOLVED_ORDERS', !unresolvedOrders, unresolvedOrders ? 'Open or ambiguous order exists' : 'None');
      // Pending algo protection must belong to the restored AURA trade; anything else
      // (an orphaned stop, an external algo) is unresolved and blocks readiness.
      const attachSupported = executionCapabilities?.attachedProtectionSupported === true;
      const restoredPositions = restored.positions ?? (restored.position ? [restored.position] : []);
      const ownedProtection = new Set(restoredPositions.flatMap(item => [...(item.attachedProtectionIds ?? [])]));
      const unresolvedProtection: string[] = [];
      let protectionQueryAvailable = true;
      if (this.deps.execution.getPendingProtection) {
        for (const symbol of this.config.symbols) {
          const pendingProtection = await this.deps.execution.getPendingProtection(symbol);
          if (pendingProtection === null) { protectionQueryAvailable = false; continue; }
          for (const item of pendingProtection) {
            const owned = restoredPositions.some(position => position.symbol === symbol
              && (ownedProtection.has(item.algoId)
                || (!!position.entryOrderId && item.orderId === position.entryOrderId)));
            if (!owned) unresolvedProtection.push(`${symbol}:${item.algoId}`);
          }
        }
      } else protectionQueryAvailable = false;
      this.check(checks, 'UNRESOLVED_PROTECTION', unresolvedProtection.length === 0 && (protectionQueryAvailable || !attachSupported),
        unresolvedProtection.length ? `Pending algo protection not linked to the AURA trade: ${unresolvedProtection.join(', ')}`
          : protectionQueryAvailable ? 'None' : 'Algo protection query unavailable while attachment is supported');
      if (executionCapabilities) this.check(checks, 'PROTECTION_LIFECYCLE', !attachSupported
        || (!!executionCapabilities.cancelAlgoOrder && !!executionCapabilities.getAlgoOrders && !!executionCapabilities.getOrder),
      attachSupported ? 'Attached protection can be verified and cancelled through discovered tools' : 'Client-side protection only');
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
      const report: PreflightReport = { passed, state: this.stateValue, checks,
        positionSymbol: restoredPositions.length === 1 ? restoredPositions[0]!.symbol : null,
        positionSymbols: restoredPositions.map(item => item.symbol), universe: this.universeSelection,
        unmanagedInventory: this.unmanagedInventory.map(position => ({ ...position })),
        readiness, blockers: checks.filter(item => !item.passed).map(item => item.name),
        readLane: readLaneReport, writeLane: writeLaneReport };
      this.lastPreflight = report;
      this.audit('PREFLIGHT', { passed, readiness, checks, positionSymbol: report.positionSymbol,
        unmanagedInventory: report.unmanagedInventory });
      this.audit('ATK_MCP_HEALTH', { readLane: readLaneReport, writeLane: writeLaneReport });
      this.audit('STATE_TRANSITION', { state: this.stateValue });
      this.auditNewMcpTraces();
      await this.publish();
      return report;
    } catch (error) {
      this.mcpHealthy = false;
      this.stateValue = 'OBSERVE_ONLY';
      this.ownershipReconciliationPending = error instanceof OwnershipAmbiguityError;
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
        positionSymbols: (await this.openPositions()).map(item => item.symbol), universe: this.universeSelection,
        unmanagedInventory: this.unmanagedInventory.map(position => ({ ...position })),
        readiness: 'BLOCKED', blockers: checks.filter(item => !item.passed).map(item => item.name),
        readLane: readLaneReport, writeLane: writeLaneReport };
      this.lastPreflight = report;
      this.audit('PREFLIGHT', { passed: false, checks, error: detail });
      this.audit('ERROR', { stage: 'PREFLIGHT', reason: detail });
      this.audit('ATK_MCP_HEALTH', { readLane: readLaneReport, writeLane: writeLaneReport });
      this.auditNewMcpTraces();
      await this.publish();
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
    // A bounded measured exchange/local clock skew can put a fresh ATK book
    // briefly in the future. Wait for local time to catch up rather
    // than accepting future data or changing the stale-data limit.
    const evaluationTime = await this.settleClockSkew(book.timestamp);
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
      costContextFromOkxTakerFee(fee.takerRate, feature.spreadBps),
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

  /** New entries require exact AURA ownership, while unrelated inventory stays separate. */
  private async assertExchangeMatchesMonitor(snapshot: StartupExchangeSnapshot): Promise<void> {
    if (snapshot.profile !== this.config.profile || snapshot.openOrders.length > 0) {
      throw new Error('Exchange profile or open orders changed before entry');
    }
    const context = this.deps.startupContext
      ? await this.deps.startupContext(snapshot, {}) : emptyContext();
    const managed = context.managedPositions ?? snapshot.positions;
    const local = await this.openPositions();
    if (managed.length !== local.length || managed.length > this.config.risk.maxConcurrentPositions
      || managed.some(item => !local.some(position => position.symbol === item.symbol
        && Math.abs(position.quantity - item.quantity) <= 1e-10)))
      throw new OwnershipAmbiguityError('AURA-managed exchange positions differ from local monitor');
    this.unmanagedInventory = (context.unmanagedInventory ?? []).map(position => ({ ...position }));
  }

  private currentPosition(position: OpenPosition | null): OpenPosition | null {
    if (!position) return null;
    const override = this.protectionOverrides.get(position.symbol);
    // A stale override from an earlier closed trade in the same symbol must never
    // re-apply its stop levels to a new position.
    if (override && override.openedAt !== position.openedAt) {
      this.protectionOverrides.delete(position.symbol);
      return position;
    }
    return override ? { ...position, protection: { ...override.protection } } : position;
  }

  private quoteFee(symbol: string, fill: { fee: number; feeCurrency: string; price: number }): number {
    const [base, quote] = symbol.split('-');
    return Math.abs(fill.fee) * (fill.feeCurrency === quote ? 1 : fill.feeCurrency === base ? fill.price : NaN);
  }

  /**
   * Sells whole exchange lots of the AURA-managed quantity only. If the exchange no
   * longer holds that quantity (attached exchange-side stop or an external sale), no
   * SELL is sent; the missing quantity is reconciled from conclusive fill evidence.
   */
  private async submitProtectiveExit(position: OpenPosition, price: number,
    context: 'LIVE' | 'DEMO_VERIFICATION' = 'LIVE'): Promise<boolean> {
    if (this.pending || !this.mcpHealthy) return false;
    // Autonomous exits need LIVE; the explicit demo verifier may exit only on the demo profile.
    if (context === 'LIVE' ? !['LIVE', 'DEGRADED'].includes(this.stateValue)
      || this.config.profile !== 'live' || !this.config.liveTradingArmed : this.config.profile !== 'demo') return false;
    const symbol = position.symbol;
    const meta = this.metadata.get(symbol);
    if (!meta) { this.degrade(`Instrument metadata missing for ${symbol} exit`); return false; }
    const exchange = await this.deps.execution.getStartupSnapshot();
    if (exchange.profile !== this.config.profile) { this.degrade('Exchange profile changed before exit'); return false; }
    const holding = exchange.positions.find(item => item.symbol === symbol)?.quantity ?? 0;
    const inventory = this.unmanagedInventory.filter(item => item.symbol === symbol)
      .reduce((sum, item) => sum + item.quantity, 0);
    const externalSells = (await this.deps.market.getRecentSpotFills(symbol)).some(fill =>
      fill.symbol === symbol && fill.side === 'sell' && fill.timestamp >= position.openedAt
      && !isAuraOkxClientId(fill.clientOrderId, 'EXIT'));
    if (externalSells) {
      await this.reconcileExternalExit(position, holding, inventory, meta.quantityStep);
      return false;
    }
    if (holding + meta.quantityStep < inventory + position.quantity) {
      await this.reconcileExternalExit(position, holding, inventory, meta.quantityStep);
      return false;
    }
    const quantity = Number((Math.floor((position.quantity + 1e-12) / meta.quantityStep) * meta.quantityStep).toPrecision(15));
    if (holding - inventory + 1e-12 < quantity) {
      await this.reconcileExternalExit(position, holding, inventory, meta.quantityStep);
      return false;
    }
    if (!Number.isFinite(quantity) || quantity < meta.minOrderSize) {
      this.audit('PROTECTION', { reason: 'EXIT_BELOW_MINIMUM', quantity: position.quantity,
        minOrderSize: meta.minOrderSize, mode: position.protectionMode }, { symbol });
      this.degrade(`Managed ${symbol} quantity is below the exchange minimum; manual exit required`);
      return false;
    }
    const id = this.nextInternalId();
    const plan: ApprovedOrderPlan = { symbol, side: 'SELL', quantity,
      estimatedNotional: quantity * price, referencePrice: price,
      protection: position.protectionPlan, cycleId: id, decisionId: id,
      clientOrderId: createOkxClientId('EXIT') };
    this.lastExitSubmission = await this.submit(plan);
    return true;
  }

  /** Applies external SELL fills only when they account for the whole managed quantity; otherwise fails closed. */
  private async reconcileExternalExit(position: OpenPosition, holding: number, inventory: number,
    step: number): Promise<void> {
    const symbol = position.symbol;
    this.audit('PROTECTION', { reason: 'EXTERNAL_EXIT_DETECTED', managedQuantity: position.quantity,
      exchangeHolding: holding, unmanagedInventory: inventory, mode: position.protectionMode }, { symbol });
    try {
      if (!this.monitor) throw new OwnershipAmbiguityError('Monitor unavailable during external exit');
      const fills = (await this.deps.market.getRecentSpotFills(symbol))
        .filter(fill => fill.symbol === symbol && fill.side === 'sell' && fill.timestamp >= position.openedAt
          && !isAuraOkxClientId(fill.clientOrderId, 'EXIT'))
        .sort((a, b) => a.timestamp - b.timestamp);
      const sold = fills.reduce((sum, fill) => sum + fill.quantity, 0);
      if (!fills.length || Math.abs(sold - position.quantity) > step || Math.abs(holding - inventory) > step) {
        throw new OwnershipAmbiguityError(`Managed ${symbol} quantity missing from exchange without matching sell fills`);
      }
      let remaining = position.quantity;
      for (const fill of fills) {
        const fee = this.quoteFee(symbol, fill);
        if (!Number.isFinite(fee)) throw new OwnershipAmbiguityError('Unknown external fill fee currency');
        const quantity = Math.min(fill.quantity, remaining);
        if (quantity <= 0) break;
        const applied = this.monitor.processFill({ symbol, clientOrderId: fill.clientOrderId ?? '',
          exchangeOrderId: fill.orderId, fillId: fill.fillId, side: 'SELL', quantity, price: fill.price, fee,
          timestamp: Math.max(fill.timestamp, this.now()) });
        if (applied.status !== 'APPLIED' && applied.status !== 'DUPLICATE_FILL') {
          throw new OwnershipAmbiguityError(`Monitor rejected external fill: ${applied.status}`);
        }
        remaining -= quantity;
        this.audit('FILL', { orderId: fill.orderId, fillId: fill.fillId, side: 'sell', quantity,
          price: fill.price, fee, external: true, closedTradePnl: applied.closedTradePnl }, { symbol });
        this.recordClose(symbol, applied, fill.timestamp, true, { orderId: fill.orderId, price: fill.price, quantity, external: true });
      }
      await this.writeOffResidual(symbol, { symbol });
      await this.persistPositions();
      if (!(await this.monitor.getOpenPosition(symbol))) await this.cleanupProtection(position, {});
    } catch (error) {
      this.ownershipReconciliationPending = true;
      this.degrade(error instanceof Error ? error.message : 'External exit reconciliation failed');
    }
  }

  private recordClose(symbol: string, applied: { closedTradePnl: number | null; closedTradeOutcomeR: number | null },
    timestamp: number, stopHit: boolean, detail: Record<string, unknown>,
    identity: Partial<Pick<AuditEvent, 'cycleId' | 'decisionId' | 'clientOrderId'>> = {}): void {
    if (applied.closedTradeOutcomeR !== null) this.monitor?.recordDecision({ symbol,
      setupType: 'DETERMINISTIC_EXIT', regime: this.evaluations.get(symbol)?.regime.stableRegime ?? 'UNCERTAIN',
      resultCategory: 'CLOSED', outcomeR: applied.closedTradeOutcomeR, stopHit, timestamp });
    if (applied.closedTradePnl !== null) {
      this.protectionOverrides.delete(symbol);
      this.audit('EXIT', { phase: 'CLOSED', ...detail, pnl: applied.closedTradePnl,
        outcomeR: applied.closedTradeOutcomeR }, { ...identity, symbol });
    }
  }

  /** A sub-lot remainder cannot be sold; it is written off and stays in the wallet as inventory. */
  private async writeOffResidual(symbol: string,
    identity: Partial<Pick<AuditEvent, 'cycleId' | 'decisionId' | 'clientOrderId' | 'symbol'>>): Promise<void> {
    if (!this.monitor?.closeResidualDust) return;
    const residual = await this.monitor.getOpenPosition(symbol);
    const meta = this.metadata.get(symbol);
    if (!residual || residual.symbol !== symbol || !meta || residual.quantity >= meta.quantityStep) return;
    const closed = this.monitor.closeResidualDust(symbol, meta.quantityStep, this.now());
    if (closed.status !== 'APPLIED') return;
    this.recordClose(symbol, closed, this.now(), false, { dustQuantity: residual.quantity,
      note: 'Sub-lot remainder written off at zero; it remains in the wallet as unmanaged inventory' }, identity);
  }

  private async monitorHeld(slow: boolean, symbol: string): Promise<string> {
    const monitor = this.monitor;
    if (!monitor) return 'Monitor unavailable';
    const held = this.currentPosition(await monitor.getOpenPosition(symbol));
    if (!held) return 'Flat';
    const ticker = await this.deps.market.getTicker(symbol);
    const markTime = await this.settleClockSkew(ticker.timestamp);
    if (ticker.symbol !== symbol || !validTime(markTime, ticker.timestamp, this.config.risk.maxDataAgeMs))
      throw new Error(`Stale held-symbol ticker ${symbol}`);
    monitor.updateMark(symbol, ticker.last, markTime);
    let updated = this.currentPosition(await monitor.getOpenPosition(symbol))!;
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
    const immediateReason = this.killSwitchActive() ? 'KILL_SWITCH'
      : equity.currentDrawdown >= this.config.risk.hardPeakDrawdownPct ? 'HARD_DRAWDOWN'
        : hardStopBreached(symbol, updated, ticker.last) ? 'HARD_STOP'
          : takeProfitReached(symbol, updated, ticker.last) ? 'TAKE_PROFIT'
            : timeStopReached(symbol, updated, this.now(), this.config.maxHoldingMs) ? 'TIME_STOP' : null;
    if (immediateReason) {
      this.audit('PROTECTION', { reason: immediateReason, stopPrice: updated.protection.currentStopPrice,
        markPrice: ticker.last, mode: updated.protectionMode }, { symbol });
      const exitRequested = await this.submitProtectiveExit(updated, ticker.last);
      if (exitRequested) this.audit('EXIT', { phase: 'REQUESTED', reason: immediateReason,
        requestedQuantity: updated.quantity, referencePrice: ticker.last }, { symbol });
      await this.persistPositions();
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
    await this.persistPositions();
    return reason ?? 'Protected';
  }

  private async monitorHeldAll(slow: boolean): Promise<string> {
    const results: string[] = [];
    for (const position of await this.openPositions()) {
      results.push(`${position.symbol}:${await this.monitorHeld(slow, position.symbol)}`);
    }
    return results.length ? results.join(', ') : 'Flat';
  }

  private nextInternalId(): string { this.sequence += 1; return `aura${this.now()}_${this.sequence}`; }

  private async submit(plan: ApprovedOrderPlan): Promise<OrderSubmissionResult> {
    const identity = { cycleId: plan.cycleId, decisionId: plan.decisionId,
      clientOrderId: plan.clientOrderId, symbol: plan.symbol };
    if (plan.side === 'BUY' && (this.entriesDisarmed || this.killSwitchActive())) {
      this.audit('EXECUTION_RESULT', { status: 'REJECTED', reason: 'Runtime entries disarmed' }, identity);
      return { status: 'REJECTED', symbol: plan.symbol, clientOrderId: plan.clientOrderId,
        cycleId: plan.cycleId, decisionId: plan.decisionId, accepted: false,
        exchangeOrderId: null, reason: 'Runtime entries disarmed', timestamp: this.now(),
        protectionMode: null, protectionVerified: false };
    }
    this.audit('EXECUTION_SUBMITTED', { side: plan.side, quantity: plan.quantity,
      referencePrice: plan.referencePrice, protectionMode: plan.protection.protectionMode }, identity);
    const result = await this.deps.execution.submitApprovedOrder(plan);
    this.audit('EXECUTION_RESULT', { status: result.status, orderId: result.exchangeOrderId,
      reason: result.reason, protectionMode: result.protectionMode,
      protectionVerified: result.protectionVerified }, identity);
    this.clientIds.add(plan.clientOrderId);
    if (result.status === 'RECONCILE_REQUIRED' || result.status === 'ACCEPTED') {
      // The engine reports the protection mode it actually achieved (verified
      // exchange-side attachment or client-side fallback); the position records that truth.
      const protection = plan.side === 'BUY' && result.protectionMode
        && result.protectionMode !== plan.protection.protectionMode
        ? { ...plan.protection, protectionMode: result.protectionMode } : plan.protection;
      this.pending = { request: { symbol: plan.symbol, clientOrderId: plan.clientOrderId,
        exchangeOrderId: result.exchangeOrderId, cycleId: plan.cycleId, decisionId: plan.decisionId,
        side: plan.side, kind: 'MARKET', quantity: plan.quantity, limitPrice: null },
        plan: { ...plan, protection }, exchangeOrderId: result.exchangeOrderId,
        protectionIds: [...(result.protectionIds ?? [])] };
      if (result.status === 'RECONCILE_REQUIRED') {
        this.audit('RECONCILIATION_REQUIRED', { orderId: result.exchangeOrderId,
          reason: result.reason }, identity);
        this.degrade('Ambiguous order; reconciliation required');
      }
      await this.reconcilePending();
    } else if (result.status === 'CONNECTOR_FAILURE') this.degrade('Execution connector failure');
    return result;
  }

  /**
   * Exchange precision only: the stop trigger is aligned down to the instrument tick and
   * the distance/fraction are kept consistent. Sizing and the risk certificate are untouched.
   */
  private alignPlanToTick(plan: ApprovedOrderPlan, tickSize: number | undefined): ApprovedOrderPlan {
    if (plan.side !== 'BUY' || !tickSize || !Number.isFinite(tickSize) || tickSize <= 0) return plan;
    const initialStopPrice = Number((Math.floor(plan.protection.initialStopPrice / tickSize + 1e-9) * tickSize).toPrecision(15));
    if (!(initialStopPrice > 0) || initialStopPrice >= plan.referencePrice) return plan;
    const stopDistanceAbsolute = plan.referencePrice - initialStopPrice;
    return { ...plan, tickSize, protection: { ...plan.protection, initialStopPrice, stopDistanceAbsolute,
      stopDistanceFraction: stopDistanceAbsolute / plan.referencePrice } };
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
    // Exact match only: same order, same client ID (when reported), same symbol and side.
    const observed = (await this.deps.market.getRecentSpotFills(pending.plan.symbol))
      .filter(fill => fill.orderId === exchangeOrderId && fill.symbol === pending.plan.symbol
        && fill.side.toUpperCase() === pending.plan.side
        && (fill.clientOrderId == null || fill.clientOrderId === pending.plan.clientOrderId))
      .sort((a, b) => a.timestamp - b.timestamp);
    const fills = observed.length ? observed : this.fillsFromOrderRecord(result.order, pending, exchangeOrderId);
    if (!fills.length) return;
    const before = await this.monitor.getOpenPosition(pending.plan.symbol);
    let total = 0;
    for (const fill of fills) {
      if (fill.symbol !== pending.plan.symbol || fill.side.toUpperCase() !== pending.plan.side) {
        this.degrade('Reconciled fill identity or side mismatch'); return;
      }
      const base = pending.plan.symbol.split('-')[0];
      const fee = this.quoteFee(pending.plan.symbol, fill);
      if (!Number.isFinite(fee)) { this.degrade('Unknown fill fee currency'); return; }
      // OKX charges spot BUY fees in the base currency: the wallet receives fillSz minus
      // the fee. Only that net quantity is AURA-owned and later sellable.
      const ownedQuantity = fill.side === 'buy' && fill.feeCurrency === base
        ? fill.quantity - Math.abs(fill.fee) : fill.quantity;
      if (!(ownedQuantity > 0)) { this.degrade('Fill fee consumed the owned quantity'); return; }
      const applied = this.monitor.processFill({ symbol: fill.symbol, clientOrderId: pending.plan.clientOrderId,
        exchangeOrderId: fill.orderId, fillId: fill.fillId, side: fill.side.toUpperCase() as 'BUY' | 'SELL',
        quantity: ownedQuantity, price: fill.price, fee, timestamp: fill.timestamp },
      { allowSameSymbolIncrease: false, protectionPlan: pending.plan.protection,
        protectionMode: pending.plan.protection.protectionMode, entryProtectionIds: pending.protectionIds });
      if (applied.status !== 'APPLIED' && applied.status !== 'DUPLICATE_FILL') {
        this.degrade(`Monitor fill rejected: ${applied.status}`); return;
      }
      total += fill.quantity;
      const identity = { cycleId: pending.plan.cycleId, decisionId: pending.plan.decisionId,
        clientOrderId: pending.plan.clientOrderId };
      if (applied.status === 'APPLIED') this.audit('FILL', { orderId: fill.orderId,
        fillId: fill.fillId, side: fill.side, quantity: fill.quantity, ownedQuantity, price: fill.price,
        fee, closedTradePnl: applied.closedTradePnl }, { ...identity, symbol: fill.symbol });
      this.recordClose(pending.plan.symbol, applied, fill.timestamp, false,
        { orderId: fill.orderId, price: fill.price, quantity: fill.quantity }, identity);
    }
    if (total + 1e-12 < pending.plan.quantity) return;
    if (pending.plan.side === 'SELL') await this.writeOffResidual(pending.plan.symbol, { cycleId: pending.plan.cycleId,
      decisionId: pending.plan.decisionId, clientOrderId: pending.plan.clientOrderId });
    await this.persistPositions();
    this.pending = null;
    this.audit('RECONCILIATION_RESOLVED', { outcome: 'FILLED', orderId: exchangeOrderId,
      quantity: total }, { cycleId: pending.plan.cycleId, decisionId: pending.plan.decisionId,
      clientOrderId: pending.plan.clientOrderId, symbol: pending.plan.symbol });
    if (this.stateValue === 'DEGRADED') this.degradedReason = 'Order resolved; full preflight required';
    if (pending.plan.side === 'SELL' && before && !(await this.monitor.getOpenPosition(pending.plan.symbol))) {
      await this.cleanupProtection(before, { cycleId: pending.plan.cycleId,
        decisionId: pending.plan.decisionId, clientOrderId: pending.plan.clientOrderId });
    }
  }

  /**
   * After a trade closes, exchange-side protection attached to its entry is cancelled
   * so it can never sell a later position or unmanaged inventory. Only protection
   * linked to this entry's identifiers is touched; ambiguity blocks new entries.
   */
  private async cleanupProtection(position: OpenPosition,
    identity: Partial<Pick<AuditEvent, 'cycleId' | 'decisionId' | 'clientOrderId'>>): Promise<void> {
    const symbol = position.symbol;
    const triggers = protectionTriggers(position.protectionPlan, this.metadata.get(symbol)?.tickSize);
    const link: AttachedProtectionLink = { symbol, entryOrderId: position.entryOrderId ?? null,
      entryClientOrderId: position.entryClientOrderId ?? null,
      protectionIds: [...(position.attachedProtectionIds ?? [])],
      // The live OCO is correlated by its exact triggers and protected quantity; IDs alone are not enough.
      signature: { slTriggerPx: triggers.sl, tpTriggerPx: triggers.tp, quantity: position.quantity,
        notBefore: position.openedAt - 60_000 } };
    const attachedEvidence = position.protectionMode === 'EXCHANGE_SIDE' || link.protectionIds.length > 0;
    if (!this.deps.execution.cancelAttachedProtection) {
      if (attachedEvidence) {
        this.ownershipReconciliationPending = true;
        this.degrade(`Attached ${symbol} protection cannot be cancelled by this execution adapter`);
      }
      return;
    }
    if (!attachedEvidence && !link.entryOrderId) return;
    const result = await this.deps.execution.cancelAttachedProtection(link);
    this.lastProtectionCleanup = result;
    this.audit('PROTECTION', { reason: `ATTACHED_CLEANUP_${result.status}`, protectionIds: result.protectionIds,
      detail: result.reason, entryOrderId: link.entryOrderId, mode: position.protectionMode }, { ...identity, symbol });
    if (result.status === 'AMBIGUOUS') {
      this.ownershipReconciliationPending = true;
      this.degrade(`Attached ${symbol} protection cleanup ambiguous; reconciliation required`);
    }
  }

  /**
   * When the fills index lags, the exchange order record is authoritative provided it
   * matches exactly: ordId, clOrdId, symbol, side, the full requested quantity, a trade
   * identity (normalized like fill IDs), fill price and fee. Anything less stays pending.
   */
  private fillsFromOrderRecord(order: OrderStatus | null, pending: PendingOrder, exchangeOrderId: string): RecentSpotFill[] {
    if (!order || order.state !== 'FILLED' || order.exchangeOrderId !== exchangeOrderId
      || order.symbol !== pending.plan.symbol || order.clientOrderId !== pending.plan.clientOrderId
      || !order.tradeId || order.averageFillPrice === null || !(order.averageFillPrice > 0)
      || order.fee == null || !order.feeCurrency
      || Math.abs(order.filledQuantity - order.requestedQuantity) > 1e-12
      || Math.abs(order.filledQuantity - pending.plan.quantity) > 1e-12) return [];
    return [{ symbol: order.symbol, fillId: order.tradeId, tradeId: order.tradeId, orderId: exchangeOrderId,
      clientOrderId: order.clientOrderId, side: pending.plan.side === 'BUY' ? 'buy' : 'sell',
      quantity: order.filledQuantity, price: order.averageFillPrice, fee: order.fee,
      feeCurrency: order.feeCurrency, timestamp: order.fillTime ?? order.updatedAt }];
  }

  /** Verifier-only: bounded READ re-reconciliation while the exchange indexes a fill. */
  private async settlePending(attempts: number): Promise<void> {
    for (let attempt = 0; attempt < attempts && this.pending; attempt += 1) {
      if (attempt > 0) await new Promise<void>(resolve => setTimeout(resolve, 500));
      await this.reconcilePending();
    }
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
      const provenanceCycleId = this.nextInternalId();
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
        if (this.universeSelection && this.now() - this.universeSelection.evaluatedAt >= this.config.universeRefreshMs) {
          await this.refreshUniverse(true);
          for (const symbol of this.universeSymbols) if (!this.metadata.has(symbol)) {
            const meta = await this.deps.market.getInstrumentMeta(symbol);
            if (meta.symbol !== symbol || meta.state && meta.state !== 'live')
              throw new Error(`New universe instrument ${symbol} unavailable`);
            this.metadata.set(symbol, meta);
            this.feeRates.set(symbol, await this.deps.market.getSpotFeeRate(symbol));
          }
        }
        const heldBefore = await this.openPositions();
        if (heldBefore.length) {
          const monitoring = await this.monitorHeldAll(true);
          this.node('LOCAL', 'Held-position protection and reconciliation', null, monitoring);
          if (this.pending || monitoring.split(', ').some(item => !item.endsWith(':Protected')))
            return finish({ status: 'MONITORING', selectedSymbol: null, reason: monitoring });
          if (heldBefore.length >= this.config.risk.maxConcurrentPositions)
            return finish({ status: 'MONITORING', selectedSymbol: null,
              reason: `Managed-position cap ${this.config.risk.maxConcurrentPositions} is full` });
        }
        if (this.entriesDisarmed || this.killSwitchActive())
          return finish({ status: 'BLOCKED', selectedSymbol: null, reason: 'Runtime entries disarmed' });
        const exchangeBeforeRanking = await this.deps.execution.getStartupSnapshot();
        await this.assertExchangeMatchesMonitor(exchangeBeforeRanking);
        const held = await this.openPositions();
        const evaluations: SymbolEvaluation[] = [];
        for (const symbol of this.universeSymbols) {
          const evaluation = await this.evaluate(symbol, held.find(item => item.symbol === symbol) ?? null);
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
        const heldSymbols = new Set(held.map(item => item.symbol));
        const ranked = rankEntryCandidates(evaluations.map(item => item.candidate))
          .filter(item => !heldSymbols.has(item.symbol));
        const selected = ranked[0] ?? null;
        this.audit('OPPORTUNITY_SELECTED', { selectedSymbol: selected?.symbol ?? null,
          oqs: selected?.opportunityScore ?? null,
          rankedSymbols: ranked.map(item => item.symbol) }, { cycleId: provenanceCycleId,
          ...(selected ? { symbol: selected.symbol } : {}) });
        this.node('LOCAL', 'Deterministic cross-symbol ranking', selected?.symbol ?? null,
          selected ? `Selected ${selected.symbol}` : 'No eligible entry');
        if (!selected) return finish({ status: 'HOLD', selectedSymbol: null, reason: 'No eligible entry' });
        this.selected = selected;
        // Observe-only mode still produces the Market Critic verdict and the deterministic
        // Risk Certificate (all READ-lane work); execution is withheld further below.
        if (this.pending || !await this.bothLanesHealthy())
          return finish({ status: 'BLOCKED', selectedSymbol: selected.symbol, reason: 'Order pending or MCP lane disconnected' });
        const other = evaluations.filter(item => item.symbol !== selected.symbol)
          .sort((a, b) => b.candidate.opportunityScore - a.candidate.opportunityScore || a.symbol.localeCompare(b.symbol))[0];
        if (!other) return finish({ status: 'BLOCKED', selectedSymbol: selected.symbol, reason: 'Cross-market context unavailable' });
        const selectedEval = evaluations.find(item => item.symbol === selected.symbol)!;
        const optionalEvidence = await Promise.allSettled([
          crossCheckIndicators(this.deps.connector, selectedEval.feature),
          fetchPairEvidence(this.deps.connector, selected.symbol, other.symbol, this.now()),
          this.contextPulse.get(this.deps.connector, this.universeSymbols, this.now()),
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
          position: { hasOpenLong: held.length > 0, openLongSymbol: held.length === 1 ? held[0]!.symbol : null },
          recentMemory: this.monitor?.getRecentDecisionMemory() ?? [],
          indicatorCrossChecks: this.lastIndicatorChecks,
          atkCrossMarket: this.lastPairContext,
          contextPulse: this.lastPulse });
        const criticLatencyMs = typeof this.latestLlm.latencyMs === 'number'
          && Number.isFinite(this.latestLlm.latencyMs) && this.latestLlm.latencyMs >= 0
          ? Math.round(this.latestLlm.latencyMs) : null;
        const criticTimeoutReason = this.latestLlm.status === 'TIMEOUT'
          ? `Market Critic timeout${criticLatencyMs === null ? '' : ` after ${criticLatencyMs}ms`}` : null;
        this.audit('MARKET_CRITIC_RESULT', this.latestLlm.status === 'SUCCESS'
          ? { status: this.latestLlm.status, verdict: this.latestLlm.decision.action,
            counter_thesis: this.latestLlm.decision.counter_thesis,
            riskFlag: this.latestLlm.decision.risk_flag,
            setupQuality: this.latestLlm.decision.setup_quality, latencyMs: criticLatencyMs }
          : { status: this.latestLlm.status, latencyMs: criticLatencyMs,
            ...(criticTimeoutReason ? { reason: criticTimeoutReason } : {}) },
          { cycleId: provenanceCycleId, symbol: selected.symbol });
        this.node('LLM', 'Market Critic reviewed selected candidate', selected.symbol,
          this.latestLlm.status === 'SUCCESS' ? this.latestLlm.decision.action
            : criticTimeoutReason ?? this.latestLlm.status,
          this.latestLlm.status === 'SUCCESS');
        const balance = await this.deps.market.getTradingBalanceSnapshot();
        const exchangeAtRisk = await this.deps.execution.getStartupSnapshot();
        await this.assertExchangeMatchesMonitor(exchangeAtRisk);
        const performance = await this.monitor!.getPerformanceState();
        const riskPositions = await this.openPositions();
        // Raw spot balances are inventory, not active trades. Only the reconciled
        // monitor positions enter the hard risk position gates.
        if (riskPositions.some(position => !exchangeAtRisk.positions.some(item => item.symbol === position.symbol
          && item.quantity + 1e-10 >= position.quantity))) {
          throw new Error('AURA-managed position no longer reconciles with exchange inventory');
        }
        const riskOpenPositions = riskPositions.map(position => {
          const notional = position.quantity * position.markPrice;
          return { symbol: position.symbol, quantity: position.quantity, notional,
            exposurePct: notional / exchangeAtRisk.totalEquityUsd };
        });
        const account = { equity: exchangeAtRisk.totalEquityUsd,
          availableQuoteBalance: exchangeAtRisk.balances.find(item => item.currency === 'USDT')?.available ?? 0,
          dayStartEquity: performance.dayStartEquity, peakEquity: Math.max(performance.peakEquity, exchangeAtRisk.totalEquityUsd),
          consecutiveLosses: performance.consecutiveLosses,
          lastLossTimestamp: this.monitor!.getRecentDecisionMemory().find(item => item.resultCategory === 'CLOSED'
            && item.outcomeR !== null && item.outcomeR < 0)?.timestamp ?? null,
          openPositions: riskOpenPositions,
          timestamp: Math.min(balance.timestamp, exchangeAtRisk.timestamp) };
        const id = this.nextInternalId();
        const clientOrderId = createOkxClientId('ENTRY');
        const selectedMeta = this.metadata.get(selected.symbol);
        if (!selectedMeta) throw new Error(`Instrument metadata missing for ${selected.symbol}`);
        const minimumNotional = Math.max(this.config.risk.minTradeNotionalUsd,
          selectedMeta.minOrderSize * selectedEval.feature.midPrice);
        const riskInput: PreTradeRiskInput = { candidate: selected, account,
          market: { symbol: selected.symbol, referencePrice: selectedEval.feature.midPrice,
            spreadBps: selectedEval.feature.spreadBps, atr: selectedEval.feature.atr,
            atrPctPercentile: selectedEval.feature.atrPctPercentile,
            dataAgeMs: selectedEval.feature.dataAgeMs, timestamp: selectedEval.feature.timestamp },
          config: { ...this.config.risk, minTradeNotionalUsd: minimumNotional },
          timestamp: this.now(), llmResult: this.latestLlm,
          clientOrderId, knownClientOrderIds: [...this.clientIds], cycleId: id, decisionId: id,
          quantityStep: selectedMeta.quantityStep,
          killSwitchActive: this.killSwitchActive(), cooldownUntil: null,
          protectionMode: 'CLIENT_SIDE' };
        let risk = evaluateEntryRisk(riskInput);
        if (risk.decision.approved && risk.plan) {
          const roundedDown = Math.floor((risk.plan.quantity + 1e-12) / selectedMeta.quantityStep)
            * selectedMeta.quantityStep;
          const minimumLot = Math.ceil((minimumNotional
            / risk.plan.referencePrice - 1e-12) / selectedMeta.quantityStep) * selectedMeta.quantityStep;
          const quantity = Number((roundedDown * risk.plan.referencePrice + 1e-9
            < minimumNotional ? minimumLot : roundedDown).toPrecision(15));
          if (!Number.isFinite(quantity) || quantity < selectedMeta.minOrderSize) {
            this.latestCertificate = risk.certificate;
            this.audit('RISK_CERTIFICATE', risk.certificate, { cycleId: provenanceCycleId,
              decisionId: id, clientOrderId, symbol: selected.symbol });
            this.monitor?.recordDecision({ symbol: selected.symbol, setupType: selected.setupType,
              regime: selected.regime, resultCategory: 'REJECTED_RISK', outcomeR: null, stopHit: null,
              timestamp: this.now() });
            return finish({ status: 'REJECTED', selectedSymbol: selected.symbol, reason: 'Approved size is below exchange minimum or lot step' });
          }
          risk = evaluateEntryRisk({ ...riskInput, requestedNotional: quantity * risk.plan.referencePrice });
        }
        this.latestCertificate = risk.certificate;
        this.audit('RISK_CERTIFICATE', risk.certificate, { cycleId: provenanceCycleId,
          decisionId: id, clientOrderId, symbol: selected.symbol });
        if (risk.certificate.riskMode === 'LOCKDOWN') this.audit('LOCKDOWN',
          { reason: risk.decision.reason }, { cycleId: provenanceCycleId, symbol: selected.symbol });
        this.node('RISK', 'Deterministic Risk Certificate', selected.symbol,
          risk.certificate.verdict, risk.certificate.verdict === 'ALLOW');
        if (exchangeAtRisk.profile !== this.config.profile || exchangeAtRisk.openOrders.length > 0
          || (await this.openPositions()).length !== riskOpenPositions.length) {
          this.degrade('Exchange position count or open order changed before execution');
          return finish({ status: 'BLOCKED', selectedSymbol: selected.symbol, reason: this.degradedReason! });
        }
        if (!risk.decision.approved) {
          this.monitor?.recordDecision({ symbol: selected.symbol, setupType: selected.setupType,
            regime: selected.regime, resultCategory: this.latestLlm.status === 'SUCCESS' ? 'REJECTED_RISK' : 'REJECTED_LLM',
            outcomeR: null, stopHit: null, timestamp: this.now() });
          const primaryReason = criticTimeoutReason &&
            (risk.decision.rejectionCategory === 'DATA_FRESH' || risk.decision.rejectionCategory === 'LLM_REACHABLE')
            ? criticTimeoutReason : risk.decision.reason;
          return finish({ status: 'REJECTED', selectedSymbol: selected.symbol, reason: primaryReason });
        }
        if (risk.certificate.verdict !== 'ALLOW' || !risk.plan)
          return finish({ status: 'BLOCKED', selectedSymbol: selected.symbol, reason: 'Risk certificate did not allow' });
        if (this.stateValue !== 'LIVE') {
          // Analysis is complete; only LIVE (live profile, armed, activated) may reach the WRITE lane.
          this.node('LOCAL', 'Execution withheld: observe-only mode', selected.symbol, 'OBSERVE_ONLY');
          return finish({ status: 'BLOCKED', selectedSymbol: selected.symbol, reason: 'OBSERVE_ONLY_EXECUTION_WITHHELD' });
        }
        const submission = await this.submit(this.alignPlanToTick(risk.plan, this.metadata.get(selected.symbol)?.tickSize));
        this.node('LOCAL', 'Execution submission and reconciliation', selected.symbol, submission.status,
          submission.status === 'ACCEPTED');
        return finish({ status: submission.status === 'ACCEPTED' ? 'SUBMITTED' : 'BLOCKED',
          selectedSymbol: selected.symbol, reason: submission.status });
      } catch (error) {
        if (error instanceof OwnershipAmbiguityError) {
          this.ownershipReconciliationPending = true;
          this.unmanagedInventory = [];
        }
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
          if ((await this.openPositions()).length) await this.monitorHeldAll(false);
          await this.recover(); return;
        }
        await this.monitorHeldAll(false);
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
    atrPercentiles: Readonly<Record<string, number[]>>; universe: UniverseSelection | null }> {
    if (this.stateValue === 'BOOTING') await this.preflight();
    if (!this.deps.connector.isConnected()) throw new Error('MCP unavailable');
    await this.refreshUniverse(true);
    const candidates: CandidateSignal[] = [];
    const spreads: Record<string, number[]> = {};
    const atrPercentiles: Record<string, number[]> = {};
    const positions = await this.openPositions();
    for (const symbol of this.universeSymbols) {
      const item = await this.evaluate(symbol, positions.find(position => position.symbol === symbol) ?? null);
      this.retain(item);
      candidates.push(item.candidate);
      spreads[symbol] = [item.feature.spreadBps];
      atrPercentiles[symbol] = [item.feature.atrPctPercentile];
    }
    const result = { diagnostics: summarizeSignalCalibration(candidates), spreads, atrPercentiles,
      universe: this.universeSelection };
    this.audit('CALIBRATION', result);
    return result;
  }

  /** Explicit infrastructure command; never invoked by autonomous strategy loops. */
  async demoSmoke(): Promise<{ passed: boolean; reason: string; preflight: PreflightReport;
    execution?: DemoSmokeExecutionResult }> {
    const refused = (reason: string, preflight: PreflightReport = {
      passed: false, state: this.stateValue, checks: [], positionSymbol: null,
    }) => ({ passed: false, reason, preflight });
    if (this.config.profile !== 'demo' || this.deps.connector.profile !== 'demo'
      || this.config.liveTradingArmed || !this.config.demoSmokeArmFlagExplicitlyFalse) {
      return refused('DEMO_SMOKE refused: OKX_PROFILE=demo and LIVE_TRADING_ARMED=false are required');
    }
    if (!this.deps.startupContext || !this.deps.smokeRecovery || !this.deps.execution.runDemoSmoke
      || !this.deps.execution.verifyDemoRuntime) {
      return refused('DEMO_SMOKE refused: explicit ownership and demo execution adapters are required');
    }
    const preflight = await this.preflight();
    if (!preflight.passed || preflight.readiness !== 'READY_FOR_DEMO'
      || preflight.positionSymbol !== null || preflight.readLane?.status !== 'READY'
      || preflight.readLane.profile !== 'demo' || preflight.readLane.readOnly !== true
      || preflight.writeLane?.status !== 'READY' || preflight.writeLane.profile !== 'demo'
      || await this.monitor?.getOpenPosition()) {
      return refused('DEMO_SMOKE refused: demo preflight or flat AURA ownership failed', preflight);
    }
    if (!await this.deps.execution.verifyDemoRuntime()) {
      return refused('DEMO_SMOKE refused: both MCP servers must report demo=true', preflight);
    }
    let activeRequest: DemoSmokeRequest | null = null;
    let markerStarted = false;
    let markerCleared = false;
    try {
      const initial = await this.deps.execution.getStartupSnapshot();
      const initialOwnership = await this.deps.startupContext(initial, {});
      if (initial.profile !== 'demo' || initial.openOrders.length > 0
        || !initialOwnership.managedPositions || initialOwnership.managedPositions.length !== 0) {
        return refused('DEMO_SMOKE refused: active order or AURA-managed position detected', preflight);
      }
      const quoteAvailable = initial.balances.find(item => item.currency === 'USDT')?.available ?? 0;
      const selection = await selectDemoSmokeMarket(this.universeSymbols, this.deps.market,
        quoteAvailable, this.config.risk.maxDataAgeMs, this.config.risk.maxSpreadBps, this.now);
      if (!selection) return refused('DEMO_SMOKE refused: no fresh, affordable symbol satisfies the spread limit', preflight);
      const baseline = await this.deps.execution.getStartupSnapshot();
      const ownership = await this.deps.startupContext(baseline, {});
      if (baseline.profile !== 'demo' || baseline.openOrders.length > 0
        || !ownership.managedPositions || ownership.managedPositions.length !== 0
        || await this.monitor?.getOpenPosition()) {
        return refused('DEMO_SMOKE refused: ownership changed before execution', preflight);
      }
      const internalId = `AURA-SMOKE-${randomUUID()}`;
      const request: DemoSmokeRequest = { symbol: selection.symbol, quantity: selection.quantity,
        quantityStep: selection.quantityStep, minOrderSize: selection.minOrderSize,
        tickSize: selection.tickSize, referencePrice: selection.referencePrice,
        feeRate: selection.feeRate, cycleId: `${internalId}C`, decisionId: `${internalId}D`,
        entryClientOrderId: createOkxClientId('SMOKE'),
        protectionClientOrderId: createOkxClientId('PROT'),
        exitClientOrderId: createOkxClientId('EXIT'), baseline };
      activeRequest = request;
      this.deps.demoSmokeNotice?.(`DEMO_SMOKE intended ${selection.symbol} BUY ${selection.quantity} `
        + `approximate_notional_usdt=${selection.approximateNotional}`);
      await this.deps.smokeRecovery.begin(request, this.now());
      markerStarted = true;
      this.cycleNodes = [];
      const readStart = this.deps.connector.getRecentTraces?.().length ?? 0;
      const writeStart = this.deps.execution.getWriteTraces?.().length ?? 0;
      const stage = (item: DemoSmokeStage): void => {
        this.audit('DEMO_SMOKE', item, { cycleId: request.cycleId,
          decisionId: request.decisionId, clientOrderId: item.clientOrderId, symbol: item.symbol });
        this.auditNewMcpTraces(request.cycleId);
        this.node('LOCAL', `DEMO_SMOKE ${item.stage}`, item.symbol, item.detail ?? item.stage,
          !['RECONCILE_REQUIRED', 'MANUAL_RECONCILIATION_REQUIRED', 'REFUSED'].includes(item.stage));
      };
      const execution = await this.deps.execution.runDemoSmoke(request, stage);
      if (execution.status === 'REFUSED' || execution.status === 'REJECTED'
        || execution.status === 'ENTRY_NOT_ACCEPTED') {
        await this.deps.smokeRecovery.clear(request.entryClientOrderId);
        markerCleared = true;
      }
      if (execution.status === 'PASS') {
        try {
          const finalSnapshot = await this.deps.execution.getStartupSnapshot();
          if (finalSnapshot.profile !== 'demo' || finalSnapshot.openOrders.length > 0
            || await this.monitor?.getOpenPosition()) {
            execution.status = 'MANUAL_RECONCILIATION_REQUIRED';
            execution.reason = 'Final AURA ownership or open-order check failed';
          } else {
            await this.deps.smokeRecovery.clear(request.entryClientOrderId);
            markerCleared = true;
            const finalOwnership = await this.deps.startupContext(finalSnapshot, {});
            if (!finalOwnership.managedPositions || finalOwnership.managedPositions.length > 0) {
              execution.status = 'MANUAL_RECONCILIATION_REQUIRED';
              execution.reason = 'Final AURA ownership check failed';
            }
            this.unmanagedInventory = (finalOwnership.unmanagedInventory ?? []).map(item => ({ ...item }));
          }
        } catch {
          execution.status = 'MANUAL_RECONCILIATION_REQUIRED';
          execution.reason = 'Final AURA ownership could not be verified';
        }
        if (execution.status !== 'PASS' && markerCleared) {
          await this.deps.smokeRecovery.begin(request, this.now());
          markerCleared = false;
        }
      }
      this.auditNewMcpTraces(request.cycleId);
      const traces = [...(this.deps.connector.getRecentTraces?.() ?? []).slice(readStart),
        ...(this.deps.execution.getWriteTraces?.() ?? []).slice(writeStart)];
      this.provenance.record({ cycleId: request.cycleId, timestamp: this.now(),
        selectedSymbol: selection.symbol, result: `DEMO_SMOKE_${execution.status}`,
        nodes: [...this.cycleNodes, ...traces.map(traceNode)],
        summary: { symbol: selection.symbol, setupType: 'DEMO_SMOKE', oqs: null,
          selection: 'SELECTED', criticVerdict: null, counterThesis: null, riskResult: null,
          primaryRejectionReason: execution.status === 'PASS' ? null : execution.reason,
          executionResult: execution.status, outcomeR: null, pnl: null } });
      this.audit('DECISION_PROVENANCE', { cycleId: request.cycleId, result: execution.status,
        setupType: 'DEMO_SMOKE' }, { cycleId: request.cycleId, decisionId: request.decisionId,
        clientOrderId: request.entryClientOrderId, symbol: selection.symbol });
      if (execution.status === 'RECONCILE_REQUIRED'
        || execution.status === 'MANUAL_RECONCILIATION_REQUIRED') {
        this.ownershipReconciliationPending = true;
        this.degrade('DEMO_SMOKE_MANUAL_RECONCILIATION_REQUIRED');
      }
      await this.publish();
      return { passed: execution.status === 'PASS', reason: execution.reason, preflight, execution };
    } catch (error) {
      if (!markerStarted) return refused(`DEMO_SMOKE refused before submission: ${error instanceof Error
        ? error.message : 'Unknown preparation failure'}`, preflight);
      if (activeRequest && markerCleared) {
        await this.deps.smokeRecovery.begin(activeRequest, this.now()).catch(() => undefined);
      }
      this.ownershipReconciliationPending = true;
      this.degrade('DEMO_SMOKE_MANUAL_RECONCILIATION_REQUIRED');
      await this.publish();
      const reason = `DEMO_SMOKE_MANUAL_RECONCILIATION_REQUIRED: ${error instanceof Error ? error.message : 'Unknown failure'}`;
      return activeRequest ? { passed: false, reason, preflight,
        execution: { status: 'MANUAL_RECONCILIATION_REQUIRED', reason,
          entryState: 'RECONCILE_REQUIRED', writeDiagnostic: null,
          symbol: activeRequest.symbol, clientOrderId: activeRequest.entryClientOrderId,
          orderId: null, confirmedFilledQuantity: 0, entryAverageFillPrice: null,
          entryFeeAmount: 0, entryFeeCurrency: null, netOwnedBase: 0,
          protectionTest: 'UNAVAILABLE', protectionId: null, exitOrderId: null,
          dustQuantity: 0, auraManagedActivePositionCount: 0 } } : refused(reason, preflight);
    }
  }

  /**
   * DEMO-ONLY verification of the production entry path. It drives the same submit(),
   * attached TP/SL payload, fill reconciliation, protective exit and attached-protection
   * cleanup a live BUY would use, then proves a flat, unambiguous final state. Never called
   * by autonomous loops; every ambiguity fails closed and leaves the smoke marker in place.
   */
  async attachedProtectionSmoke(): Promise<AttachedProtectionSmokeResult> {
    const symbol = 'ETH-USDT';
    const stages: string[] = [];
    const evidence: AttachedProtectionSmokeResult['evidence'] = { symbol, entryClientOrderId: null, entryOrderId: null,
      protectionMode: null, protectionVerified: false, protectionIds: [], linkedPendingProtection: 0,
      netOwnedBase: 0, exitClientOrderId: null, exitOrderId: null, cleanupStatus: null, dustQuantity: 0 };
    const stage = (name: string, detail?: string): void => {
      stages.push(detail ? `${name}: ${detail}` : name);
      this.audit('DEMO_SMOKE', { stage: `ATTACHED_${name}`, symbol, clientOrderId: evidence.entryClientOrderId ?? '',
        ...(detail ? { detail } : {}) }, { symbol, ...(evidence.entryClientOrderId ? { clientOrderId: evidence.entryClientOrderId } : {}) });
      this.deps.demoSmokeNotice?.(`ATTACHED_PROTECTION_SMOKE ${name}${detail ? ` ${detail}` : ''}`);
    };
    const refused = (reason: string): AttachedProtectionSmokeResult => ({ passed: false, reason, stages, evidence });
    if (this.config.profile !== 'demo' || this.deps.connector.profile !== 'demo'
      || this.config.liveTradingArmed || !this.config.demoSmokeArmFlagExplicitlyFalse) {
      return refused('REFUSED: OKX_PROFILE=demo and LIVE_TRADING_ARMED=false are required');
    }
    const execution = this.deps.execution;
    if (!this.deps.startupContext || !this.deps.smokeRecovery || !execution.verifyDemoRuntime
      || !execution.cancelAttachedProtection || !execution.getPendingProtection || !execution.getCapabilities) {
      return refused('REFUSED: demo runtime, ownership, and attached-protection adapters are required');
    }
    if (!this.config.symbols.includes(symbol)) return refused(`REFUSED: ${symbol} is not in the tracked universe`);
    const preflight = await this.preflight();
    if (!preflight.passed || preflight.readiness !== 'READY_FOR_DEMO' || preflight.positionSymbol !== null
      || preflight.readLane?.status !== 'READY' || preflight.readLane.profile !== 'demo' || preflight.readLane.readOnly !== true
      || preflight.writeLane?.status !== 'READY' || preflight.writeLane.profile !== 'demo' || await this.monitor?.getOpenPosition()) {
      return refused('REFUSED: demo preflight or flat AURA ownership failed');
    }
    if (!execution.getCapabilities()?.attachedProtectionSupported) {
      return refused('REFUSED: the discovered spot order schema does not support attached TP/SL');
    }
    if (!await execution.verifyDemoRuntime()) return refused('REFUSED: both MCP servers must report demo=true');
    const meta = this.metadata.get(symbol);
    const fee = this.feeRates.get(symbol);
    if (!meta || !fee) return refused('REFUSED: instrument metadata or fee rate unavailable');
    let markerStarted = false;
    try {
      const baseline = await execution.getStartupSnapshot();
      const ownership = await this.deps.startupContext(baseline, {});
      if (baseline.profile !== 'demo' || baseline.openOrders.length > 0
        || (ownership.managedPositions ?? baseline.positions).length > 0) {
        return refused('REFUSED: active order or AURA-managed position detected');
      }
      const base = symbol.split('-')[0]!;
      const baseBefore = baseline.balances.find(item => item.currency === base)?.equity ?? 0;
      const quoteAvailable = baseline.balances.find(item => item.currency === 'USDT')?.available ?? 0;
      const inventoryBefore = (ownership.unmanagedInventory ?? []).map(item => ({ ...item }));
      const ticker = await this.deps.market.getTicker(symbol);
      const now = await this.settleClockSkew(ticker.timestamp);
      if (ticker.symbol !== symbol || !validTime(now, ticker.timestamp, this.config.risk.maxDataAgeMs)
        || !Number.isFinite(ticker.ask) || ticker.ask <= 0) return refused('REFUSED: stale or invalid ticker');
      const reference = ticker.ask;
      const quantity = minimumDemoSmokeQuantity({ symbol, instrumentId: symbol, ...meta },
        Math.abs(fee.takerRate), reference, quoteAvailable);
      if (quantity === null) return refused('REFUSED: no fee-safe minimum quantity is affordable');
      // Same plan shape and protection geometry as a live entry; the ATR distance is replaced
      // by a fixed 2% for the smoke and the same tick alignment is applied before submit().
      const stopDistance = reference * 0.02;
      const plan = this.alignPlanToTick({ symbol, side: 'BUY', quantity, estimatedNotional: quantity * reference,
        referencePrice: reference,
        protection: { symbol, initialStopPrice: reference - stopDistance, stopDistanceAbsolute: stopDistance,
          stopDistanceFraction: 0.02, breakEvenTriggerR: this.config.risk.breakEvenTriggerR,
          trailingActivationR: this.config.risk.trailingActivationR, takeProfitR: this.config.risk.takeProfitR,
          protectionMode: 'CLIENT_SIDE' },
        cycleId: `AURA-ATTACHED-${randomUUID()}C`, decisionId: `AURA-ATTACHED-${randomUUID()}D`,
        clientOrderId: createOkxClientId('ENTRY') }, meta.tickSize);
      evidence.entryClientOrderId = plan.clientOrderId;
      this.unmanagedInventory = inventoryBefore;
      this.resetVerificationEvidence();
      stage('ENTRY_INTENT', `${symbol} BUY ${quantity} reference=${reference} stop=${plan.protection.initialStopPrice} `
        + `takeProfitR=${plan.protection.takeProfitR} via production submit() with attached TP/SL`);
      await this.deps.smokeRecovery.begin({ symbol, cycleId: plan.cycleId, entryClientOrderId: plan.clientOrderId }, this.now());
      markerStarted = true;
      const submission = await this.submit(plan);
      if (submission.status === 'ACCEPTED') await this.settlePending(8);
      evidence.entryOrderId = submission.exchangeOrderId;
      evidence.protectionMode = submission.protectionMode;
      evidence.protectionVerified = submission.protectionVerified;
      evidence.protectionIds = [...(submission.protectionIds ?? [])];
      stage('ENTRY_RESULT', `${submission.status} mode=${submission.protectionMode ?? 'none'} verified=${submission.protectionVerified} `
        + `protectionIds=${evidence.protectionIds.join(',') || 'none'}${submission.reason ? ` reason=${submission.reason}` : ''}`);
      if (submission.status !== 'ACCEPTED') throw new Error(`Entry not accepted: ${submission.status}`);
      if (this.pending) throw new Error('Entry fill not conclusively reconciled');
      const position = await this.monitor!.getOpenPosition();
      if (!position || position.symbol !== symbol || position.entryClientOrderId !== plan.clientOrderId) {
        throw new Error('Reconciled fill did not produce the AURA-managed position');
      }
      evidence.netOwnedBase = position.quantity;
      stage('ENTRY_FILLED', `netOwnedBase=${position.quantity} entryOrderId=${position.entryOrderId ?? 'unknown'} mode=${position.protectionMode}`);
      const pendingProtection = (await execution.getPendingProtection(symbol)) ?? [];
      const triggers = protectionTriggers(plan.protection, meta.tickSize);
      const signature: ProtectionSignature = { slTriggerPx: triggers.sl, tpTriggerPx: triggers.tp,
        quantity: plan.quantity, notBefore: null };
      const ownsProtection = (item: { algoId: string; orderId: string | null } & Parameters<typeof protectionSignatureMatches>[0]) =>
        evidence.protectionIds.includes(item.algoId)
        || (!!position.entryOrderId && item.orderId === position.entryOrderId)
        || protectionSignatureMatches(item, signature);
      const linked = pendingProtection.filter(ownsProtection);
      evidence.linkedPendingProtection = linked.length;
      // Exactly one live algo may carry this entry's signature; zero is unproven, more than one is ambiguous.
      const verified = submission.protectionMode === 'EXCHANGE_SIDE' && submission.protectionVerified
        && evidence.protectionIds.length > 0 && linked.length === 1 && position.protectionMode === 'EXCHANGE_SIDE';
      stage('PROTECTION_EVIDENCE', verified
        ? `PASS exchange reports ${linked.length} pending algo linked to entry ${position.entryOrderId}`
        : `FAIL mode=${submission.protectionMode ?? 'none'} verified=${submission.protectionVerified} linkedPending=${linked.length}`);
      // Flatten through the production protective-exit path regardless of the verdict.
      const exitTicker = await this.deps.market.getTicker(symbol);
      const exited = await this.submitProtectiveExit(position, exitTicker.last, 'DEMO_VERIFICATION');
      if (exited) await this.settlePending(8);
      const { exit, cleanup } = this.verificationEvidence();
      evidence.exitClientOrderId = exit?.clientOrderId ?? null;
      evidence.exitOrderId = exit?.exchangeOrderId ?? null;
      if (!exited) throw new Error(`Protective exit was not submitted (${this.degradedReason ?? 'exit guard refused'})`);
      if (exit?.status !== 'ACCEPTED') throw new Error(`Exit not accepted: ${exit?.status ?? 'unknown'}`);
      if (this.pending) throw new Error('Exit fill not conclusively reconciled');
      const residual = await this.monitor!.getOpenPosition();
      if (residual) throw new Error(`Position still open after exit: ${residual.quantity}`);
      evidence.cleanupStatus = cleanup?.status ?? null;
      stage('EXIT_FILLED', `exitOrderId=${evidence.exitOrderId ?? 'unknown'} attachedCleanup=${evidence.cleanupStatus ?? 'not run'}`);
      if (this.stateValue === 'DEGRADED' || this.ownershipReconciliationPending) {
        throw new Error(this.degradedReason ?? 'Reconciliation pending after exit');
      }
      if (evidence.cleanupStatus !== 'CANCELLED' && evidence.cleanupStatus !== 'NONE') {
        throw new Error(`Attached protection cleanup ${evidence.cleanupStatus ?? 'did not run'}`);
      }
      const finalSnapshot = await execution.getStartupSnapshot();
      const finalPending = (await execution.getPendingProtection(symbol)) ?? [];
      const ownedPending = finalPending.filter(ownsProtection);
      const ownedOrders = finalSnapshot.openOrders.filter(order => order.clientOrderId === plan.clientOrderId
        || (!!evidence.exitClientOrderId && order.clientOrderId === evidence.exitClientOrderId));
      const baseAfter = finalSnapshot.balances.find(item => item.currency === base)?.equity ?? 0;
      evidence.dustQuantity = Math.max(0, baseAfter - baseBefore);
      const finalOwnership = await this.deps.startupContext(finalSnapshot, {});
      const inventoryAfter = finalOwnership.unmanagedInventory ?? [];
      const inventoryIntact = inventoryBefore.every(before => {
        const after = inventoryAfter.find(item => item.symbol === before.symbol);
        return !!after && after.quantity + meta.quantityStep / 10 >= before.quantity;
      });
      const managedAfter = (finalOwnership.managedPositions ?? finalSnapshot.positions).length;
      // A sub-lot remainder is unsellable by definition; anything at or above one lot is not flat.
      const flat = finalSnapshot.profile === 'demo' && managedAfter === 0 && ownedOrders.length === 0
        && ownedPending.length === 0 && inventoryIntact && evidence.dustQuantity < meta.quantityStep;
      stage('FINAL_STATE', flat ? `FLAT managed=0 ownedOrders=0 ownedPending=0 dust=${evidence.dustQuantity} inventoryIntact=true`
        : `NOT FLAT managed=${managedAfter} ownedOrders=${ownedOrders.length} ownedPending=${ownedPending.length} `
          + `dust=${evidence.dustQuantity} inventoryIntact=${inventoryIntact}`);
      if (!flat) throw new Error('Final flat reconciliation failed');
      this.unmanagedInventory = inventoryAfter.map(item => ({ ...item }));
      await this.deps.smokeRecovery.clear(plan.clientOrderId);
      await this.publish();
      if (!verified) {
        stage('UNVERIFIED', 'Flattened safely, but exchange-side attached protection was not proven');
        return { passed: false, reason: 'ATTACHED_PROTECTION_UNVERIFIED: entry and exit reconciled flat, but no authoritative attached TP/SL evidence',
          stages, evidence };
      }
      stage('PASS', 'Production entry, attached TP/SL, protective exit, protection cleanup, and flat state verified');
      return { passed: true, reason: 'Production attached protection lifecycle verified on demo', stages, evidence };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown failure';
      if (!markerStarted) return refused(`REFUSED before submission: ${message}`);
      this.ownershipReconciliationPending = true;
      this.degrade('ATTACHED_PROTECTION_SMOKE_MANUAL_RECONCILIATION_REQUIRED');
      stage('MANUAL_RECONCILIATION_REQUIRED', message);
      await this.publish();
      return { passed: false, reason: `MANUAL_RECONCILIATION_REQUIRED: ${message}`, stages, evidence };
    }
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
      const positions = (await this.openPositions()).map(item => this.currentPosition(item)!);
      const position = positions[0] ?? null;
      this.lastPositionForJudge = positions.length === 1 ? position : null;
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
        symbols: [...this.universeSymbols], universe: this.universeSelection,
        markets, selectedSymbol: this.selected?.symbol ?? null,
        selectedOQS: this.selected?.opportunityScore ?? null,
        llm: this.latestLlm ? { status: this.latestLlm.status,
          action: this.latestLlm.status === 'SUCCESS' ? this.latestLlm.decision.action : null,
          riskFlag: this.latestLlm.status === 'SUCCESS' ? this.latestLlm.decision.risk_flag : null,
          confidence: this.latestLlm.status === 'SUCCESS' ? this.latestLlm.decision.confidence : null,
          regimeConfirmation: this.latestLlm.status === 'SUCCESS' ? this.latestLlm.decision.regime_confirmation : null,
          setupQuality: this.latestLlm.status === 'SUCCESS' ? this.latestLlm.decision.setup_quality : null,
          reason: this.latestLlm.status === 'SUCCESS' ? this.latestLlm.decision.reason : null } : null,
        riskCertificate: this.latestCertificate,
        openPositionSymbol: positions.length === 1 ? position?.symbol ?? null : null,
        openPositionSymbols: positions.map(item => item.symbol),
        maxConcurrentPositions: this.config.risk.maxConcurrentPositions,
        positions: positions.map(item => ({ symbol: item.symbol, quantity: item.quantity,
          entryPrice: item.weightedAverageEntryPrice, markPrice: item.markPrice,
          stopPrice: item.protection.currentStopPrice,
          unrealizedPnl: item.unrealizedPnl, realizedPnl: item.realizedPnl,
          takeProfitPrice: item.protection.takeProfitPrice,
          breakEvenActivated: item.protection.breakEvenActivated,
          trailingActivated: item.protection.trailingActivated,
          protectionMode: item.protectionMode })),
        position: positions.length === 1 && position ? { symbol: position.symbol, quantity: position.quantity,
          entryPrice: position.weightedAverageEntryPrice, markPrice: position.markPrice,
          stopPrice: position.protection.currentStopPrice,
          unrealizedPnl: position.unrealizedPnl, realizedPnl: position.realizedPnl,
          takeProfitPrice: position.protection.takeProfitPrice,
          breakEvenActivated: position.protection.breakEvenActivated,
          trailingActivated: position.protection.trailingActivated,
          protectionMode: position.protectionMode } : null,
        equity: equity ? { starting: equity.startingEquity, current: equity.currentEquity, peak: equity.peakEquity,
          dailyPnl: equity.dailyPnl, dailyReturnPct: equity.dailyReturn * 100,
          currentDrawdownPct: equity.currentDrawdown * 100,
          maximumDrawdownPct: equity.maximumDrawdown * 100 } : null,
        riskMode: this.latestCertificate?.riskMode ?? null, degradedReason: this.degradedReason,
        unmanagedInventory: this.unmanagedInventory.map(position => ({ ...position })) };
      this.lastSnapshot = structuredClone(snapshot);
      const observing = this.deps.observer?.(structuredClone(snapshot));
      if (observing) await Promise.resolve(observing).catch(() => undefined);
    } catch { /* The observer is never a decision authority. */ }
  }
}

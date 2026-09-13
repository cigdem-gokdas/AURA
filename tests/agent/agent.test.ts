import { describe, expect, it, vi } from 'vitest';
import { AuraAgent, type AgentDependencies, type ObserverSnapshot, type SymbolEvaluation } from '../../src/agent/agent.js';
import { agentConfigFromEnv, parseSymbols } from '../../src/agent/config.js';
import type { ExecutionEngine, StartupExchangeSnapshot } from '../../src/execution/types.js';
import type { FeatureSnapshot } from '../../src/features/types.js';
import type { LlmClient } from '../../src/llm/types.js';
import type { MarketAdapter, RecentSpotFill } from '../../src/market/types.js';
import type { OkxConnector } from '../../src/okx/connector.js';
import type { ApprovedOrderPlan, ProtectionPlan } from '../../src/risk/types.js';
import type { CandidateSignal } from '../../src/signal/types.js';
import type { AtkToolTrace } from '../../src/okx/telemetry.js';
import { createProductionAgent } from '../../src/main.js';
import { AgentRecoveryStore } from '../../src/agent/recovery.js';
import { InMemoryPositionMonitor } from '../../src/monitor/monitor.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditLog, type AuditEvent } from '../../src/memory/audit.js';
import { publishJudgeSnapshot, readJudgeSnapshot } from '../../src/status-mcp/bridge.js';

const NOW = 1_000_000;
const symbols = ['BTC-USDT', 'ETH-USDT'];
const toolNames = ['market_get_ticker', 'market_get_candles', 'market_get_orderbook', 'market_get_instruments',
  'account_get_balance', 'account_get_trade_fee', 'spot_place_order', 'spot_get_orders', 'spot_get_fills'];

function env(profile = 'live', armed = 'true'): NodeJS.ProcessEnv {
  return { OKX_PROFILE: profile, OKX_CONNECTOR_MODE: 'mcp', LIVE_TRADING_ARMED: armed,
    SYMBOLS: symbols.join(','), LLM_PROVIDER: 'openai', LLM_MODEL: 'test', OPENAI_API_KEY: 'test-only',
    MAX_SPREAD_BPS: '20' };
}

function feature(symbol: string): FeatureSnapshot {
  return { symbol, timestamp: NOW, close: 100, bestBid: 99.99, bestAsk: 100.01, midPrice: 100,
    emaFast: 101, emaSlow: 99, adx: 30, atr: 2, atrPct: 0.02, atrPctPercentile: 0.5,
    volume: 100, volumeSma20: 100, return5: 0.02, zScore20: 1, obiTop5: 0.2,
    spreadBps: 2, microprice: 100, micropriceLeanBps: 1, dataAgeMs: 0 };
}

function candidate(symbol: string, score: number, edge = 3): CandidateSignal {
  return { symbol, action: score > 0 ? 'BUY' : 'HOLD', intent: score > 0 ? 'OPEN_LONG' : 'NONE',
    setupType: score > 0 ? 'TREND_CONTINUATION' : 'NONE', regime: 'TRENDING_UP',
    opportunityScore: score, scoreBreakdown: { regimeStructure: 30, momentumOrReversion: 20,
      volumeQuality: 10, orderBookImbalance: 10, micropriceQuality: 10, spreadQuality: 10,
      dataQuality: 10, total: score }, estimatedMoveBps: 60, estimatedRoundTripCostBps: 20,
    edgeToCostRatio: edge, clearsEstimatedCosts: score > 0, bullEvidence: [], bearEvidence: [],
    reasons: [], rejectionCategories: [], timestamp: NOW };
}

function evaluation(symbol: string, score: number, edge = 3): SymbolEvaluation {
  return { symbol, feature: feature(symbol), regime: { symbol, stableRegime: 'TRENDING_UP',
    rawProposedRegime: 'TRENDING_UP', transitioned: false, reason: 'test' },
    nextRegimeState: { symbol, stableRegime: 'TRENDING_UP', pendingRegime: null, pendingCount: 0 },
    candidate: candidate(symbol, score, edge), fee: { symbol, makerRate: 0.001, takerRate: 0.001 } };
}

function protection(symbol: string): ProtectionPlan {
  return { symbol, initialStopPrice: 90, stopDistanceAbsolute: 10, stopDistanceFraction: 0.1,
    breakEvenTriggerR: 1, trailingActivationR: 1.5, takeProfitR: 2.5, protectionMode: 'CLIENT_SIDE' };
}

function harness(options: { scores?: Record<string, number>; edges?: Record<string, number>;
  held?: string; profile?: 'demo' | 'live'; armed?: boolean; observer?: (s: ObserverSnapshot) => void;
  audit?: (event: AuditEvent) => void | Promise<void>;
  llmFailure?: boolean; ambiguous?: boolean; evaluationDelay?: Promise<void>; tickerPrice?: number;
  missingTool?: string } = {}) {
  const profile = options.profile ?? 'live';
  let connected = false;
  let writeConnected = false;
  const writeTraces: AtkToolTrace[] = [];
  const connector: OkxConnector = {
    profile, connect: vi.fn(async () => { connected = true; }),
    disconnect: vi.fn(async () => { connected = false; }), isConnected: () => connected,
    healthCheck: vi.fn(async () => ({ connected, profile, status: connected ? 'HEALTHY' as const : 'UNAVAILABLE' as const,
      reason: null, timestamp: NOW })),
    listTools: vi.fn(async () => toolNames.filter(name => name !== options.missingTool)
      .map(name => ({ name, description: null, inputSchema: {} }))),
    callTool: vi.fn(async () => { throw new Error('Unexpected real MCP call'); }),
  };
  const snapshot: StartupExchangeSnapshot = { profile, totalEquityUsd: 10_000,
    positions: options.held ? [{ symbol: options.held, quantity: 1, averageEntryPrice: 100, updatedAt: NOW }] : [],
    openOrders: [], balances: [{ currency: 'USDT', equity: options.held ? 9_900 : 10_000,
      available: options.held ? 9_900 : 10_000 }], recentFills: [],
    feeRates: symbols.map(symbol => ({ symbol, makerRate: 0.001, takerRate: 0.001 })),
    orderLookupSupported: true, timestamp: NOW };
  const market: MarketAdapter = {
    getTicker: vi.fn(async symbol => ({ symbol, bid: (options.tickerPrice ?? 100) - 0.01,
      ask: (options.tickerPrice ?? 100) + 0.01, last: options.tickerPrice ?? 100, timestamp: NOW })),
    getCandles: vi.fn(async () => []), getOrderBook: vi.fn(async () => { throw new Error('unused'); }),
    getInstrumentMeta: vi.fn(async symbol => ({ symbol, instrumentId: symbol,
      minOrderSize: 0.00001, quantityStep: 0.00001, tickSize: 0.01 })),
    checkConnectorAvailable: vi.fn(async () => connected), checkMarketReachable: vi.fn(async () => true),
    getSpotFeeRate: vi.fn(async symbol => ({ symbol, makerRate: 0.001, takerRate: 0.001 })),
    getTradingBalanceSnapshot: vi.fn(async () => ({ totalEquityUsd: 10_000,
      balances: [{ currency: 'USDT', equity: 10_000, available: 10_000 }], timestamp: NOW })),
    getOpenSpotOrders: vi.fn(async () => []), getRecentSpotFills: vi.fn(async () => []),
  };
  const execution: ExecutionEngine = {
    start: vi.fn(async () => { await connector.connect(); writeConnected = true; }),
    stop: vi.fn(async () => { writeConnected = false; }),
    getWriteHealth: vi.fn(async () => ({ connected: writeConnected, profile,
      status: writeConnected ? 'HEALTHY' as const : 'UNAVAILABLE' as const,
      reason: null, timestamp: NOW })),
    getWriteTraces: () => [...writeTraces],
    submitApprovedOrder: vi.fn(async plan => {
      writeTraces.push({ timestamp: NOW, lane: 'WRITE', toolName: 'spot_place_order',
        purpose: 'SPOT_PLACE_ORDER', symbol: plan.symbol, profile, latencyMs: 1,
        success: !options.ambiguous, errorCode: options.ambiguous ? 'TOOL_CALL_FAILED' : null,
        errorMessage: null, cycleId: plan.cycleId, decisionId: plan.decisionId });
      return { status: options.ambiguous ? 'RECONCILE_REQUIRED' as const : 'ACCEPTED' as const,
      symbol: plan.symbol, clientOrderId: plan.clientOrderId, cycleId: plan.cycleId, decisionId: plan.decisionId,
      accepted: !options.ambiguous, exchangeOrderId: options.ambiguous ? null : 'order-1', reason: null,
      timestamp: NOW, protectionMode: 'CLIENT_SIDE' as const, protectionVerified: false };
    }),
    getOrderStatus: vi.fn(async () => { throw new Error('unused'); }),
    reconcile: vi.fn(async request => ({ outcome: 'NOT_FOUND' as const, symbol: request.symbol,
      clientOrderId: request.clientOrderId, cycleId: request.cycleId, decisionId: request.decisionId,
      order: null, position: null, reconciled: false, reason: 'not found', timestamp: NOW })),
    getStartupSnapshot: vi.fn(async () => snapshot),
    getPendingProtection: vi.fn(async () => []),
    cancelAttachedProtection: vi.fn(async link => ({ status: 'CANCELLED' as const,
      protectionIds: [...link.protectionIds], reason: 'test cancellation' })),
  };
  const llm: LlmClient = { evaluateSelectedCandidate: vi.fn(async () => options.llmFailure
    ? { status: 'TIMEOUT' as const } : { status: 'SUCCESS' as const,
      decision: { action: 'AGREE' as const, confidence: 0.8, regime_confirmation: 'TRENDING_UP' as const,
        setup_quality: 'A' as const, risk_flag: 'LOW' as const, reason: 'test', counter_thesis: 'test',
        memory_signal: 'NONE' as const }, latencyMs: 1,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, estimatedCostUsd: 0 } }) };
  const evaluated: string[] = [];
  const deps: AgentDependencies = { connector, market, execution, llm, now: () => NOW,
    smokeRecovery: { begin: async () => undefined, clear: async () => undefined },
    evaluateSymbol: vi.fn(async symbol => { evaluated.push(symbol);
      if (options.evaluationDelay) await options.evaluationDelay;
      return evaluation(symbol, options.scores?.[symbol] ?? 80, options.edges?.[symbol] ?? 3); }),
    startupContext: (snap, references) => options.held ? { referencePrices: references,
      openedAtBySymbol: { [options.held]: NOW - 100 }, protectionPlans: { [options.held]: protection(options.held) },
      protectionModes: { [options.held]: 'CLIENT_SIDE' } } :
      { referencePrices: references, openedAtBySymbol: {}, protectionPlans: {}, protectionModes: {} },
  };
  if (options.observer) deps.observer = options.observer;
  if (options.audit) deps.audit = options.audit;
  const agent = new AuraAgent(agentConfigFromEnv(env(profile, String(options.armed ?? true))), deps);
  return { agent, connector, market, execution, llm, evaluated, snapshot,
    setWriteConnected: (value: boolean) => { writeConnected = value; } };
}

async function withRecoveryAgent(run: (agent: AuraAgent, h: ReturnType<typeof harness>,
  store: AgentRecoveryStore) => Promise<void>, score = 80): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'aura-ownership-'));
  const h = harness();
  const store = new AgentRecoveryStore(join(directory, 'checkpoint.json'));
  const agent = new AuraAgent(agentConfigFromEnv(env()), {
    connector: h.connector, market: h.market, execution: h.execution, llm: h.llm,
    now: () => NOW, evaluateSymbol: async symbol => evaluation(symbol, score),
    startupContext: (snapshot, references) => store.context(snapshot, references),
  });
  try { await run(agent, h, store); }
  finally { await agent.shutdown(); await rm(directory, { recursive: true, force: true }); }
}

async function saveOwnedPosition(store: AgentRecoveryStore, symbol: string): Promise<void> {
  const monitor = new InMemoryPositionMonitor(10_000, 0);
  const plan = protection(symbol);
  expect(monitor.processFill({ symbol, clientOrderId: 'aura100_1', exchangeOrderId: 'order-1',
    fillId: 'fill-1', side: 'BUY', quantity: 1, price: 100, fee: 0, timestamp: NOW - 100 },
  { allowSameSymbolIncrease: false, protectionPlan: plan, protectionMode: 'CLIENT_SIDE' }).status).toBe('APPLIED');
  await store.save((await monitor.getOpenPosition())!);
}

describe('AURA orchestration', () => {
  it('parses an ordered unique symbol universe and rejects duplicates', () => {
    expect(parseSymbols(' ETH-USDT , BTC-USDT ')).toEqual(['ETH-USDT', 'BTC-USDT']);
    expect(() => parseSymbols('BTC-USDT,BTC-USDT')).toThrow();
    expect(() => parseSymbols('')).toThrow();
  });

  it('constructs separate inert read and write MCP lanes', () => {
    const production = createProductionAgent({ ...env(), OKX_LIVE_PROFILE: 'competition' });
    const deps = (production as unknown as { deps: AgentDependencies }).deps;
    expect((deps.market as unknown as { connector: OkxConnector }).connector).toBe(deps.connector);
    const write = (deps.execution as unknown as { connector: OkxConnector }).connector;
    expect(write).not.toBe(deps.connector);
    expect((deps.execution as unknown as { readConnector: OkxConnector }).readConnector).toBe(deps.connector);
    expect(deps.connector.readOnly).toBe(true);
    expect(write.lane).toBe('WRITE');
    expect(write.readOnly).toBe(false);
    expect(deps.connector.isConnected()).toBe(false);
    expect(write.isConnected()).toBe(false);
  });

  it.each([
    [{ 'BTC-USDT': 80, 'ETH-USDT': 90 }, 'ETH-USDT'],
    [{ 'BTC-USDT': 90, 'ETH-USDT': 80 }, 'BTC-USDT'],
    [{ 'BTC-USDT': 80, 'ETH-USDT': 80 }, 'BTC-USDT'],
  ])('ranks both symbols and sends exactly one selected candidate to the critic', async (scores, selected) => {
    const h = harness({ scores });
    expect((await h.agent.preflight()).passed).toBe(true);
    expect(h.agent.activate()).toBe(true);
    const result = await h.agent.runSlowCycle();
    expect(h.evaluated).toEqual(symbols);
    expect(result.selectedSymbol).toBe(selected);
    expect(h.llm.evaluateSelectedCandidate).toHaveBeenCalledTimes(1);
    expect(vi.mocked(h.llm.evaluateSelectedCandidate).mock.calls[0]?.[0].candidate.symbol).toBe(selected);
    expect(h.execution.submitApprovedOrder).toHaveBeenCalledTimes(1);
    const entryId = vi.mocked(h.execution.submitApprovedOrder).mock.calls[0]?.[0].clientOrderId;
    expect(entryId).toMatch(/^AURAENTRY[0-9a-f]{22}$/);
    expect(entryId).toMatch(/^[A-Za-z0-9]{1,32}$/);
    await h.agent.shutdown();
  });

  it('uses edge/cost after an OQS tie', async () => {
    const h = harness({ scores: { 'BTC-USDT': 80, 'ETH-USDT': 80 },
      edges: { 'BTC-USDT': 2, 'ETH-USDT': 4 } });
    await h.agent.preflight(); h.agent.activate();
    expect((await h.agent.runSlowCycle()).selectedSymbol).toBe('ETH-USDT');
    await h.agent.shutdown();
  });

  it.each([[20, 'SUBMITTED'], [26, 'REJECTED']] as const)(
    'honors exchange minimum lot %s through the hard notional floor (%s)', async (minimumSize, expected) => {
      const h = harness();
      h.market.getInstrumentMeta = vi.fn(async symbol => ({ symbol, instrumentId: symbol,
        minOrderSize: minimumSize, quantityStep: 1, tickSize: 0.01 }));
      expect((await h.agent.preflight()).passed).toBe(true);
      expect(h.agent.activate()).toBe(true);
      const result = await h.agent.runSlowCycle();
      expect(result.status).toBe(expected);
      if (expected === 'SUBMITTED') {
        expect(vi.mocked(h.execution.submitApprovedOrder).mock.calls[0]?.[0].quantity).toBe(20);
      } else {
        expect(result.reason).toContain('MIN_TRADE_NOTIONAL');
        expect(h.execution.submitApprovedOrder).not.toHaveBeenCalled();
      }
      await h.agent.shutdown();
    },
  );

  it('publishes HOLD without LLM or order, and ignores observer failure', async () => {
    const observer = vi.fn(() => { throw new Error('observer failure'); });
    const h = harness({ scores: { 'BTC-USDT': 0, 'ETH-USDT': 0 }, observer });
    await h.agent.preflight(); h.agent.activate();
    expect((await h.agent.runSlowCycle()).status).toBe('HOLD');
    expect(observer).toHaveBeenCalledTimes(2);
    expect(h.llm.evaluateSelectedCandidate).not.toHaveBeenCalled();
    expect(h.execution.submitApprovedOrder).not.toHaveBeenCalled();
    await h.agent.shutdown();
  });

  it('disarms a running live agent without stopping deterministic monitoring', async () => {
    const h = harness();
    expect((await h.agent.preflight()).passed).toBe(true);
    expect(h.agent.activate()).toBe(true);
    h.agent.disarmEntries();
    await vi.waitFor(() => expect(h.agent.getJudgeSnapshot()?.safety.liveArmed).toBe(false));
    expect((await h.agent.runSlowCycle()).status).toBe('BLOCKED');
    expect(h.llm.evaluateSelectedCandidate).not.toHaveBeenCalled();
    expect(h.execution.submitApprovedOrder).not.toHaveBeenCalled();
    await h.agent.shutdown();
  });

  it('latches operator kill before a new BUY and requests a managed protective SELL without LLM', async () => {
    const h = harness({ held: 'BTC-USDT', llmFailure: true });
    expect((await h.agent.preflight()).passed).toBe(true);
    expect(h.agent.activate()).toBe(true);
    h.agent.engageKillSwitch();
    await vi.waitFor(() => expect(h.agent.getJudgeSnapshot()?.safety.liveArmed).toBe(false));
    await vi.waitFor(() => expect(h.execution.submitApprovedOrder).toHaveBeenCalledTimes(1));
    expect(vi.mocked(h.execution.submitApprovedOrder).mock.calls[0]?.[0]).toMatchObject({
      symbol: 'BTC-USDT', side: 'SELL',
    });
    expect(h.llm.evaluateSelectedCandidate).not.toHaveBeenCalled();
    expect(vi.mocked(h.execution.submitApprovedOrder).mock.calls.some(([plan]) => plan.side === 'BUY')).toBe(false);
    await h.agent.shutdown();
  });

  it('does not submit a BUY when kill arrives during an already-running decision cycle', async () => {
    let release!: () => void;
    const evaluationDelay = new Promise<void>(done => { release = done; });
    const h = harness({ evaluationDelay });
    expect((await h.agent.preflight()).passed).toBe(true);
    expect(h.agent.activate()).toBe(true);
    const cycle = h.agent.runSlowCycle();
    await vi.waitFor(() => expect(h.evaluated).toContain('BTC-USDT'));
    h.agent.engageKillSwitch();
    release();
    expect((await cycle).status).toBe('REJECTED');
    expect(h.execution.submitApprovedOrder).not.toHaveBeenCalled();
    await h.agent.shutdown();
  });

  it.each(symbols)('reconstructs an exchange %s position while evaluating another symbol once', async held => {
    const h = harness({ held });
    const report = await h.agent.preflight();
    expect(report.positionSymbol).toBe(held);
    expect(report.passed).toBe(true);
    h.agent.activate();
    const result = await h.agent.runSlowCycle();
    expect(result.status).toBe('SUBMITTED');
    expect(result.selectedSymbol).not.toBe(held);
    expect(h.evaluated.slice(-2)).toEqual(symbols);
    expect(h.llm.evaluateSelectedCandidate).toHaveBeenCalledTimes(1);
    expect(h.execution.submitApprovedOrder).toHaveBeenCalledTimes(1);
    expect(vi.mocked(h.execution.submitApprovedOrder).mock.calls[0]?.[0]).toMatchObject({
      symbol: result.selectedSymbol, side: 'BUY',
    });
    await h.agent.runFastCycle();
    expect(h.llm.evaluateSelectedCandidate).toHaveBeenCalledTimes(1);
    await h.agent.shutdown();
  });

  it('executes a BTC hard-stop path on the fast loop even when the critic is unavailable', async () => {
    const h = harness({ held: 'BTC-USDT', llmFailure: true, tickerPrice: 80 });
    expect((await h.agent.preflight()).passed).toBe(true);
    h.agent.activate();
    await h.agent.runFastCycle();
    expect(h.execution.submitApprovedOrder).toHaveBeenCalledTimes(1);
    expect(vi.mocked(h.execution.submitApprovedOrder).mock.calls[0]?.[0].side).toBe('SELL');
    expect(vi.mocked(h.execution.submitApprovedOrder).mock.calls[0]?.[0].clientOrderId)
      .toMatch(/^AURAEXIT[0-9a-f]{22}$/);
    expect(h.llm.evaluateSelectedCandidate).not.toHaveBeenCalled();
    await h.agent.runFastCycle();
    expect(h.execution.submitApprovedOrder).toHaveBeenCalledTimes(1);
    await h.agent.shutdown();
  });

  it('preserves a held-position protective exit when audit and status observers fail', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const h = harness({ held: 'ETH-USDT', llmFailure: true, tickerPrice: 80,
        audit: () => { throw new Error('audit disk unavailable'); },
        observer: () => { throw new Error('status bridge unavailable'); } });
      expect((await h.agent.preflight()).passed).toBe(true);
      h.agent.activate();
      expect((await h.agent.runSlowCycle()).status).toBe('MONITORING');
      expect(h.execution.submitApprovedOrder).toHaveBeenCalledTimes(1);
      expect(vi.mocked(h.execution.submitApprovedOrder).mock.calls[0]?.[0]).toMatchObject({
        symbol: 'ETH-USDT', side: 'SELL' });
      expect(h.llm.evaluateSelectedCandidate).not.toHaveBeenCalled();
      await h.agent.shutdown();
    } finally { stderr.mockRestore(); }
  });

  it('does not become live in demo or when unarmed', async () => {
    for (const options of [{ profile: 'demo' as const, armed: true }, { profile: 'live' as const, armed: false }]) {
      const h = harness(options);
      expect((await h.agent.preflight()).state).toBe('OBSERVE_ONLY');
      expect(h.agent.activate()).toBe(false);
      expect((await h.agent.runSlowCycle()).status).toBe('BLOCKED');
      expect(h.execution.submitApprovedOrder).not.toHaveBeenCalled();
      await h.agent.shutdown();
    }
  });

  it('blocks armed live readiness when the execution adapter cannot verify entry protection', async () => {
    const h = harness();
    h.execution.liveEntryProtectionReady = () => false;
    const report = await h.agent.preflight();
    expect(report.readiness).toBe('BLOCKED');
    expect(report.checks.find(check => check.name === 'LIVE_ENTRY_PROTECTION')?.passed).toBe(false);
    expect(h.agent.activate()).toBe(false);
    expect(h.execution.submitApprovedOrder).not.toHaveBeenCalled();
    await h.agent.shutdown();
  });

  it('degrades on connector loss, blocks new entry, and disconnects on shutdown', async () => {
    const h = harness(); await h.agent.preflight(); h.agent.activate();
    await h.connector.disconnect();
    expect((await h.agent.runSlowCycle()).status).toBe('BLOCKED');
    expect(h.agent.state).toBe('DEGRADED');
    expect(h.llm.evaluateSelectedCandidate).not.toHaveBeenCalled();
    await h.agent.shutdown();
    expect(h.connector.disconnect).toHaveBeenCalledTimes(2);
    expect(h.agent.state).toBe('HALTED');
  });

  it('reports separate lane readiness and blocks entry after a WRITE crash', async () => {
    const h = harness();
    const report = await h.agent.preflight();
    expect(report.readLane?.status).toBe('READY');
    expect(report.writeLane?.status).toBe('READY');
    expect(report.readiness).toBe('READY_FOR_LIVE');
    expect(report.checks.find(check => check.name === 'LIVE_TRADING_ARMED')?.detail).toBe('true');
    expect(report.checks.find(check => check.name === 'INSTRUMENT:BTC-USDT')?.detail).toContain('minSize=');
    expect(report.checks.find(check => check.name === 'FEE:ETH-USDT')?.detail).toContain('taker=');
    h.agent.activate();
    h.setWriteConnected(false);
    expect((await h.agent.runSlowCycle()).status).toBe('BLOCKED');
    expect(h.agent.state).toBe('DEGRADED');
    expect(h.llm.evaluateSelectedCandidate).not.toHaveBeenCalled();
    expect(h.execution.submitApprovedOrder).not.toHaveBeenCalled();
    await h.agent.shutdown();
  });

  it('blocks readiness when a required discovered READ capability is missing', async () => {
    const h = harness({ missingTool: 'market_get_candles' });
    const report = await h.agent.preflight();
    expect(report.passed).toBe(false);
    expect(report.readiness).toBe('BLOCKED');
    expect(report.blockers).toContain('MARKET_TOOLS');
    expect(h.agent.activate()).toBe(false);
    await h.agent.shutdown();
  });

  it('does not rank or call the critic when exchange holdings appear while local monitor is flat', async () => {
    const h = harness(); await h.agent.preflight(); h.agent.activate();
    h.snapshot.positions = [{ symbol: 'ETH-USDT', quantity: 1, averageEntryPrice: 100, updatedAt: NOW }];
    expect((await h.agent.runSlowCycle()).status).toBe('BLOCKED');
    expect(h.agent.state).toBe('DEGRADED');
    expect(h.evaluated).toEqual([]);
    expect(h.llm.evaluateSelectedCandidate).not.toHaveBeenCalled();
    await h.agent.shutdown();
  });

  it('blocks ambiguous execution without a blind retry', async () => {
    const h = harness({ ambiguous: true }); await h.agent.preflight(); h.agent.activate();
    await h.agent.runSlowCycle();
    expect(h.agent.state).toBe('DEGRADED');
    expect(h.agent.pendingOrderId).not.toBeNull();
    await h.agent.runSlowCycle();
    expect(h.execution.submitApprovedOrder).toHaveBeenCalledTimes(1);
    await h.agent.shutdown();
  });

  it('requires a full reconciliation before resuming live after a disconnect', async () => {
    const h = harness(); await h.agent.preflight(); h.agent.activate();
    await h.connector.disconnect();
    h.snapshot.openOrders = [{ symbol: 'BTC-USDT', clientOrderId: 'external', cycleId: '', decisionId: '',
      exchangeOrderId: 'external-order', state: 'OPEN', requestedQuantity: 1, filledQuantity: 0,
      averageFillPrice: null, updatedAt: NOW }];
    await h.agent.runFastCycle();
    expect(h.agent.state).toBe('DEGRADED');
    expect(h.execution.submitApprovedOrder).not.toHaveBeenCalled();
    h.snapshot.openOrders = [];
    await h.agent.runFastCycle();
    expect(h.agent.state).toBe('LIVE');
    expect(h.execution.getStartupSnapshot).toHaveBeenCalledTimes(3);
    await h.agent.shutdown();
  });

  it('bounds READ reconnect attempts and never submits while the lane stays down', async () => {
    const h = harness(); await h.agent.preflight(); h.agent.activate();
    await h.connector.disconnect();
    const connect = vi.mocked(h.connector.connect);
    const initialCalls = connect.mock.calls.length;
    connect.mockRejectedValue(new Error('READ unavailable'));
    for (let attempt = 0; attempt < 6; attempt += 1) await h.agent.runFastCycle();
    expect(connect.mock.calls.length - initialCalls).toBe(3);
    expect(h.agent.state).toBe('DEGRADED');
    expect(h.execution.submitApprovedOrder).not.toHaveBeenCalled();
    await h.agent.shutdown();
  });

  it('publishes a rejected entry with certificate and sanitized performance', async () => {
    const snapshots: ObserverSnapshot[] = [];
    const h = harness({ llmFailure: true, observer: snapshot => { snapshots.push(snapshot); } });
    await h.agent.preflight(); h.agent.activate();
    expect((await h.agent.runSlowCycle()).status).toBe('REJECTED');
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0]?.state).toBe('LIVE_READY');
    expect(snapshots[0]?.riskMode).toBeNull();
    expect(snapshots[1]?.selectedSymbol).toBe('BTC-USDT');
    expect(snapshots[1]?.selectedOQS).toBe(80);
    expect(snapshots[1]?.llm?.status).toBe('TIMEOUT');
    expect(snapshots[1]?.riskCertificate?.verdict).toBe('REJECT');
    expect(snapshots[1]?.equity?.starting).toBe(10_000);
    expect(h.agent.latestProvenance?.nodes.some(node => node.source === 'RISK')).toBe(true);
    expect(h.agent.latestProvenance?.nodes.some(node => node.lane === 'WRITE')).toBe(false);
    expect(h.agent.explainCurrentState('WHY_REJECTED').text).toContain('Risk rejected');
    expect(h.execution.submitApprovedOrder).not.toHaveBeenCalled();
    await h.agent.shutdown();
  });

  it('publishes an accepted order cycle with its risk certificate', async () => {
    const snapshots: ObserverSnapshot[] = [];
    const h = harness({ observer: snapshot => { snapshots.push(snapshot); } });
    await h.agent.preflight(); h.agent.activate();
    expect((await h.agent.runSlowCycle()).status).toBe('SUBMITTED');
    expect(snapshots.at(-1)?.riskCertificate?.verdict).toBe('ALLOW');
    expect(snapshots.at(-1)?.llm?.action).toBe('AGREE');
    expect(snapshots.at(-1)?.equity?.current).toBe(10_000);
    const judge = h.agent.getJudgeSnapshot();
    expect(judge?.reasoning.selectedSymbol).toBe('BTC-USDT');
    expect(judge?.reasoning.criticVerdict).toBe('AGREE');
    expect(judge?.safety.liveArmed).toBe(true);
    expect(judge?.atk.latestProvenance?.nodes.some(node => node.lane === 'WRITE'
      && node.toolName === 'spot_place_order')).toBe(true);
    expect(h.agent.explainCurrentState('WHY_SELECTED').text).toContain('BTC-USDT');
    expect(h.agent.explainCurrentState('MCP_EVIDENCE').intent).toBe('MCP_EVIDENCE');
    expect(Object.isFrozen(judge)).toBe(true);
    expect(Object.isFrozen(judge?.functional.markets)).toBe(true);
    expect(h.agent.getJudgeSnapshot()?.reasoning.perSymbolOqs['BTC-USDT']).toBe(80);
    await h.agent.shutdown();
  });

  it('projects the existing JudgeSnapshot and audit events from one evaluated cycle', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aura-observe-'));
    const audit = await AuditLog.open(join(directory, 'audit.jsonl'));
    const statusPath = join(directory, 'status.json');
    let published: Promise<void> | null = null;
    let h!: ReturnType<typeof harness>;
    try {
      h = harness({ audit: event => audit.append(event).then(() => undefined),
        observer: () => {
          const snapshot = h.agent.getJudgeSnapshot();
          if (snapshot) published = publishJudgeSnapshot(statusPath, snapshot);
          return published ?? undefined;
        } });
      await h.agent.preflight(); h.agent.activate();
      expect((await h.agent.runSlowCycle()).status).toBe('SUBMITTED');
      if (published) await published;
      await audit.flush();
      const records = (await readFile(join(directory, 'audit.jsonl'), 'utf8')).trimEnd()
        .split('\n').map(line => JSON.parse(line));
      expect(records.map(record => record.eventType)).toContain('DECISION_PROVENANCE');
      expect(records.map(record => record.eventType)).toContain('MARKET_CRITIC_RESULT');
      expect(records.map(record => record.eventType)).toContain('RISK_CERTIFICATE');
      expect(records.map(record => record.eventType)).toContain('EXECUTION_RESULT');
      const status = await readJudgeSnapshot(statusPath);
      expect(status?.reasoning.selectedSymbol).toBe('BTC-USDT');
      expect(status?.atk.recentDecisions.at(-1)?.summary?.criticVerdict).toBe('AGREE');
      expect(status?.reasoning.riskCertificate?.verdict).toBe('ALLOW');
    } finally {
      if (h) await h.agent.shutdown();
      if (published) await published;
      await audit.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('skips overlapping slow cycles and shuts down without scheduling new work', async () => {
    let release!: () => void;
    const delay = new Promise<void>(resolve => { release = resolve; });
    const h = harness({ evaluationDelay: delay });
    await h.agent.preflight(); h.agent.activate();
    const first = h.agent.runSlowCycle();
    expect((await h.agent.runSlowCycle()).status).toBe('SKIPPED');
    release();
    await first;
    await h.agent.shutdown();
    expect((await h.agent.runSlowCycle()).status).toBe('SKIPPED');
    expect(h.connector.disconnect).toHaveBeenCalledTimes(1);
  });

  it('refuses demo smoke under a live profile without submitting an order', async () => {
    const h = harness();
    expect((await h.agent.demoSmoke()).passed).toBe(false);
    expect(h.execution.submitApprovedOrder).not.toHaveBeenCalled();
    await h.agent.shutdown();
  });

  it('refuses demo smoke when LIVE_TRADING_ARMED is true before any WRITE placement', async () => {
    const h = harness({ profile: 'demo', armed: true });
    expect((await h.agent.demoSmoke()).passed).toBe(false);
    expect(h.execution.start).not.toHaveBeenCalled();
    expect(h.execution.submitApprovedOrder).not.toHaveBeenCalled();
    await h.agent.shutdown();
  });

  it('refuses demo smoke when the resolved MCP server does not confirm demo mode', async () => {
    const h = harness({ profile: 'demo', armed: false });
    Object.defineProperty(h.connector, 'readOnly', { value: true });
    h.execution.verifyDemoRuntime = vi.fn(async () => false);
    h.execution.runDemoSmoke = vi.fn(async () => { throw new Error('must not execute'); });
    const result = await h.agent.demoSmoke();
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('demo=true');
    expect(h.execution.runDemoSmoke).not.toHaveBeenCalled();
    expect(h.execution.submitApprovedOrder).not.toHaveBeenCalled();
    await h.agent.shutdown();
  });

  it('routes an ETH infrastructure smoke through the isolated execution port without a strategy signal', async () => {
    const h = harness({ profile: 'demo', armed: false });
    Object.defineProperty(h.connector, 'readOnly', { value: true });
    h.snapshot.positions = [
      { symbol: 'BTC-USDT', quantity: 2, averageEntryPrice: 100, updatedAt: NOW },
      { symbol: 'ETH-USDT', quantity: 3, averageEntryPrice: 100, updatedAt: NOW },
    ];
    h.market.getOrderBook = vi.fn(async symbol => ({ symbol, timestamp: NOW,
      bids: [{ price: 99.99, size: 1 }], asks: [{ price: 100.01, size: 1 }] }));
    h.market.getInstrumentMeta = vi.fn(async symbol => ({ symbol, instrumentId: symbol,
      state: 'live', minOrderSize: 0.00001, quantityStep: 0.00001, tickSize: 0.01 }));
    h.execution.verifyDemoRuntime = vi.fn(async () => true);
    h.execution.runDemoSmoke = vi.fn(async request => ({ status: 'PASS' as const,
      entryState: 'CLOSED' as const, writeDiagnostic: null,
      reason: 'reconciled', symbol: request.symbol, clientOrderId: request.entryClientOrderId,
      orderId: 'entry', confirmedFilledQuantity: request.quantity, entryAverageFillPrice: 100,
      entryFeeAmount: 0, entryFeeCurrency: 'USDT', netOwnedBase: request.quantity,
      protectionTest: 'UNAVAILABLE' as const, protectionId: null, exitOrderId: 'exit',
      dustQuantity: 0, auraManagedActivePositionCount: 0 }));
    const notices: string[] = [];
    const agent = new AuraAgent(agentConfigFromEnv(env('demo', 'false')), {
      connector: h.connector, market: h.market, execution: h.execution, llm: h.llm,
      now: () => NOW, demoSmokeNotice: line => notices.push(line),
      smokeRecovery: { begin: vi.fn(async () => undefined), clear: vi.fn(async () => undefined) },
      startupContext: (snapshot, references) => ({ referencePrices: references,
        openedAtBySymbol: {}, protectionPlans: {}, protectionModes: {},
        managedPositions: [], unmanagedInventory: snapshot.positions }),
    });
    const result = await agent.demoSmoke();
    expect(result.passed).toBe(true);
    const request = vi.mocked(h.execution.runDemoSmoke).mock.calls[0]?.[0];
    expect(request?.symbol).toBe('ETH-USDT');
    expect(request?.entryClientOrderId).toMatch(/^AURASMOKE[0-9a-f]{22}$/);
    expect(request?.protectionClientOrderId).toMatch(/^AURAPROT[0-9a-f]{22}$/);
    expect(request?.exitClientOrderId).toMatch(/^AURAEXIT[0-9a-f]{22}$/);
    expect(new Set([request?.cycleId, request?.decisionId, request?.entryClientOrderId,
      request?.protectionClientOrderId, request?.exitClientOrderId]).size).toBe(5);
    expect(notices[0]).toContain('approximate_notional_usdt=');
    expect(h.llm.evaluateSelectedCandidate).not.toHaveBeenCalled();
    expect(h.execution.submitApprovedOrder).not.toHaveBeenCalled();
    expect(agent.getJudgeSnapshot()?.atk.latestProvenance?.summary?.setupType).toBe('DEMO_SMOKE');
    await agent.shutdown();
  });

  it('clears only a not-accepted smoke marker without creating a managed position', async () => {
    const h = harness({ profile: 'demo', armed: false });
    Object.defineProperty(h.connector, 'readOnly', { value: true });
    h.market.getOrderBook = vi.fn(async symbol => ({ symbol, timestamp: NOW,
      bids: [{ price: 99.99, size: 1 }], asks: [{ price: 100.01, size: 1 }] }));
    h.market.getInstrumentMeta = vi.fn(async symbol => ({ symbol, instrumentId: symbol,
      state: 'live', minOrderSize: 0.00001, quantityStep: 0.00001, tickSize: 0.01 }));
    h.execution.verifyDemoRuntime = vi.fn(async () => true);
    h.execution.runDemoSmoke = vi.fn(async request => ({ status: 'ENTRY_NOT_ACCEPTED' as const,
      entryState: 'NOT_FOUND' as const, writeDiagnostic: null,
      reason: 'No order or fill', symbol: request.symbol,
      clientOrderId: request.entryClientOrderId, orderId: null,
      confirmedFilledQuantity: 0, entryAverageFillPrice: null,
      entryFeeAmount: 0, entryFeeCurrency: null, netOwnedBase: 0,
      protectionTest: 'UNAVAILABLE' as const, protectionId: null, exitOrderId: null,
      dustQuantity: 0, auraManagedActivePositionCount: 0 }));
    const smokeRecovery = { begin: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined) };
    const agent = new AuraAgent(agentConfigFromEnv(env('demo', 'false')), {
      connector: h.connector, market: h.market, execution: h.execution, llm: h.llm,
      now: () => NOW, smokeRecovery,
      startupContext: (snapshot, references) => ({ referencePrices: references,
        openedAtBySymbol: {}, protectionPlans: {}, protectionModes: {},
        managedPositions: [], unmanagedInventory: snapshot.positions }),
    });
    const result = await agent.demoSmoke();
    expect(result.execution?.status).toBe('ENTRY_NOT_ACCEPTED');
    expect(result.execution?.auraManagedActivePositionCount).toBe(0);
    expect(smokeRecovery.begin).toHaveBeenCalledOnce();
    expect(smokeRecovery.clear).toHaveBeenCalledOnce();
    expect(agent.getJudgeSnapshot()?.safety.reconciliationPending).toBe(false);
    await agent.shutdown();
  });

  it('keeps calibration read-only and groups diagnostics by symbol', async () => {
    const h = harness();
    const report = await h.agent.calibrate();
    expect(report.diagnostics.combined.evaluated).toBe(2);
    expect(Object.keys(report.diagnostics.bySymbol)).toEqual(symbols);
    expect(h.execution.submitApprovedOrder).not.toHaveBeenCalled();
    await h.agent.shutdown();
  });

  it('accepts a fresh book beside closed candles and rejects a book older than 10 seconds', async () => {
    const h = harness();
    const evaluationTime = 1_789_213_220_000;
    h.market.getCandles = vi.fn(async symbol => Array.from({ length: 30 }, (_, index) => {
      const close = 100 + index;
      return { symbol, timestamp: evaluationTime - (30 - index) * 180_000,
        open: close, high: close + 1, low: close - 1, close, volume: 100 };
    }));
    h.market.getOrderBook = vi.fn(async symbol => ({ symbol,
      timestamp: evaluationTime - 1_000,
      bids: [{ price: 99, size: 2 }], asks: [{ price: 101, size: 3 }] }));
    const agent = new AuraAgent(agentConfigFromEnv({ ...env(), MAX_DATA_AGE_MS: '10000' }), {
      connector: h.connector, market: h.market, execution: h.execution, llm: h.llm,
      now: () => evaluationTime,
    });
    const evaluate = (agent as unknown as {
      evaluate(symbol: string, position: null): Promise<SymbolEvaluation>;
    }).evaluate.bind(agent);
    expect((await evaluate('BTC-USDT', null)).feature.dataAgeMs).toBe(1_000);
    h.market.getOrderBook = vi.fn(async symbol => ({ symbol,
      timestamp: evaluationTime - 10_001,
      bids: [{ price: 99, size: 2 }], asks: [{ price: 101, size: 3 }] }));
    await expect(evaluate('BTC-USDT', null)).rejects.toThrow('Stale order book for BTC-USDT');
    expect(h.execution.submitApprovedOrder).not.toHaveBeenCalled();
  });

  it('waits out realistic clock skew, while rejecting future and stale books', async () => {
    const h = harness();
    const evaluationTime = 1_789_213_220_000;
    h.market.getCandles = vi.fn(async symbol => Array.from({ length: 30 }, (_, index) => {
      const close = 100 + index;
      return { symbol, timestamp: evaluationTime - (30 - index) * 180_000,
        open: close, high: close + 1, low: close - 1, close, volume: 100 };
    }));
    h.market.getOrderBook = vi.fn(async symbol => ({ symbol,
      timestamp: evaluationTime + 1_250,
      bids: [{ price: 99, size: 2 }], asks: [{ price: 101, size: 3 }] }));
    let clockReads = 0;
    const agent = new AuraAgent(agentConfigFromEnv(env()), { connector: h.connector,
      market: h.market, execution: h.execution, llm: h.llm,
      now: () => ++clockReads === 1 ? evaluationTime : evaluationTime + 1_255 });
    const evaluate = (agent as unknown as {
      evaluate(symbol: string, position: null): Promise<SymbolEvaluation>;
    }).evaluate.bind(agent);
    expect((await evaluate('BTC-USDT', null)).feature.dataAgeMs).toBe(5);
    h.market.getOrderBook = vi.fn(async symbol => ({ symbol,
      timestamp: evaluationTime + 5_000,
      bids: [{ price: 99, size: 2 }], asks: [{ price: 101, size: 3 }] }));
    await expect(evaluate('BTC-USDT', null)).rejects.toThrow('Order book timestamp is in the future');
    h.market.getOrderBook = vi.fn(async symbol => ({ symbol,
      timestamp: evaluationTime - 10_001,
      bids: [{ price: 99, size: 2 }], asks: [{ price: 101, size: 3 }] }));
    await expect(evaluate('BTC-USDT', null)).rejects.toThrow('Stale order book for BTC-USDT');
    expect(h.execution.submitApprovedOrder).not.toHaveBeenCalled();
  });

  it('rejects unresolved startup holdings without explicit recovery metadata', async () => {
    const h = harness({ held: 'ETH-USDT' });
    const agent = new AuraAgent(agentConfigFromEnv(env()), {
      connector: h.connector, market: h.market, execution: h.execution, llm: h.llm, now: () => NOW });
    const report = await agent.preflight();
    expect(report.passed).toBe(false);
    expect(agent.activate()).toBe(false);
    await agent.shutdown();
  });

  it('passes preflight with seeded BTC and ETH inventory and exposes both in JudgeSnapshot', async () => {
    await withRecoveryAgent(async (agent, h) => {
      h.snapshot.positions = [
        { symbol: 'BTC-USDT', quantity: 2, averageEntryPrice: 100, updatedAt: NOW },
        { symbol: 'ETH-USDT', quantity: 3, averageEntryPrice: 100, updatedAt: NOW },
      ];
      const report = await agent.preflight();
      expect(report.passed).toBe(true);
      expect(report.positionSymbol).toBeNull();
      expect(report.checks.find(check => check.name === 'POSITION_OWNERSHIP')?.passed).toBe(true);
      expect(report.unmanagedInventory?.map(item => item.symbol)).toEqual(symbols);
      expect((await agent.positionMonitor?.getOpenPosition()) ?? null).toBeNull();
      expect(agent.getJudgeSnapshot()?.functional.unmanagedInventory?.map(item => item.symbol)).toEqual(symbols);
      expect(agent.activate()).toBe(true);
      expect((await agent.runSlowCycle()).status).toBe('HOLD');
      expect(h.execution.submitApprovedOrder).not.toHaveBeenCalled();
    }, 0);
  });

  it('restores AURA-owned ETH while keeping BTC inventory outside managed ownership', async () => {
    await withRecoveryAgent(async (agent, h, store) => {
      await saveOwnedPosition(store, 'ETH-USDT');
      h.snapshot.positions = [
        { symbol: 'BTC-USDT', quantity: 2, averageEntryPrice: 100, updatedAt: NOW },
        { symbol: 'ETH-USDT', quantity: 1, averageEntryPrice: 100, updatedAt: NOW },
      ];
      const report = await agent.preflight();
      expect(report.passed).toBe(true);
      expect(report.positionSymbol).toBe('ETH-USDT');
      expect(report.unmanagedInventory).toMatchObject([{ symbol: 'BTC-USDT', quantity: 2 }]);
      expect(agent.activate()).toBe(true);
      expect((await agent.runSlowCycle()).status).toBe('SUBMITTED');
      expect(vi.mocked(h.execution.submitApprovedOrder).mock.calls[0]?.[0]).toMatchObject({
        symbol: 'BTC-USDT', side: 'BUY',
      });
      expect(vi.mocked(h.execution.submitApprovedOrder).mock.calls
        .some(([plan]) => plan.side === 'SELL')).toBe(false);
    });
  });

  it('does not sell unmanaged ETH when managed ETH is missing at a protective exit', async () => {
    await withRecoveryAgent(async (agent, h, store) => {
      await saveOwnedPosition(store, 'ETH-USDT');
      h.snapshot.positions = [{ symbol: 'ETH-USDT', quantity: 1.5,
        averageEntryPrice: 100, updatedAt: NOW }];
      expect((await agent.preflight()).passed).toBe(true);
      expect(agent.activate()).toBe(true);
      h.snapshot.positions = [{ symbol: 'ETH-USDT', quantity: 0.5,
        averageEntryPrice: 100, updatedAt: NOW }];
      h.market.getTicker = vi.fn(async symbol => ({ symbol, bid: 79.99, ask: 80.01,
        last: 80, timestamp: NOW }));
      await agent.runSlowCycle();
      expect(h.execution.submitApprovedOrder).not.toHaveBeenCalled();
      expect(agent.state).toBe('DEGRADED');
    });
  });

  it('blocks a protective SELL when an external SELL fill appears despite replenished balance', async () => {
    await withRecoveryAgent(async (agent, h, store) => {
      await saveOwnedPosition(store, 'ETH-USDT');
      h.snapshot.positions = [{ symbol: 'ETH-USDT', quantity: 1.5,
        averageEntryPrice: 100, updatedAt: NOW }];
      expect((await agent.preflight()).passed).toBe(true);
      expect(agent.activate()).toBe(true);
      h.market.getTicker = vi.fn(async symbol => ({ symbol, bid: 79.99, ask: 80.01,
        last: 80, timestamp: NOW }));
      h.market.getRecentSpotFills = vi.fn(async symbol => [{ symbol, orderId: 'external',
        clientOrderId: null, fillId: 'external-fill', side: 'sell' as const,
        quantity: 0.5, price: 80, fee: 0, feeCurrency: 'USDT', timestamp: NOW }]);
      await agent.runSlowCycle();
      expect(h.execution.submitApprovedOrder).not.toHaveBeenCalled();
      expect(agent.state).toBe('DEGRADED');
    });
  });

  it('blocks preflight for two AURA-owned symbol claims', async () => {
    await withRecoveryAgent(async (agent, h, store) => {
      await saveOwnedPosition(store, 'ETH-USDT');
      h.snapshot.positions = [
        { symbol: 'BTC-USDT', quantity: 1, averageEntryPrice: 100, updatedAt: NOW },
        { symbol: 'ETH-USDT', quantity: 1, averageEntryPrice: 100, updatedAt: NOW },
      ];
      h.snapshot.recentFills = [{ symbol: 'BTC-USDT', orderId: 'btc-order',
        clientOrderId: 'aura900000_2', quantity: 1, price: 100, timestamp: NOW - 50 }];
      const report = await agent.preflight();
      expect(report.passed).toBe(false);
      expect(report.readiness).toBe('BLOCKED');
      expect(report.checks.find(check => check.name === 'EXCHANGE_PREFLIGHT')?.detail)
        .toContain('without a recovery checkpoint');
      expect(agent.activate()).toBe(false);
      expect(h.execution.submitApprovedOrder).not.toHaveBeenCalled();
    });
  });

  it('blocks ambiguous ownership without a checkpoint and requests reconciliation', async () => {
    await withRecoveryAgent(async (agent, h) => {
      h.snapshot.positions = [{ symbol: 'BTC-USDT', quantity: 1, averageEntryPrice: 100, updatedAt: NOW }];
      h.snapshot.recentFills = [{ symbol: 'BTC-USDT', orderId: 'btc-order',
        clientOrderId: 'aura900000_2', quantity: 1, price: 100, timestamp: NOW - 50 }];
      const report = await agent.preflight();
      expect(report.passed).toBe(false);
      expect(report.readiness).toBe('BLOCKED');
      expect(report.checks.find(check => check.name === 'EXCHANGE_PREFLIGHT')?.detail)
        .toContain('reconciliation required');
      expect(agent.getJudgeSnapshot()?.safety.reconciliationPending).toBe(true);
      expect(h.execution.submitApprovedOrder).not.toHaveBeenCalled();
    });
  });

  it('passes WRITE_CAPABILITIES when spot placement is present alongside a system tool', async () => {
    const h = harness();
    h.execution.getWriteToolNames = () => ['spot_place_order', 'system_get_capabilities'];
    h.execution.getCapabilities = () => ({ placeOrder: 'spot_place_order', getOrder: 'spot_get_order',
      getOrders: 'spot_get_orders', getFills: 'spot_get_fills', getAlgoOrders: null,
      placeAlgoOrder: null, algoClientOrderIdSupported: false,
      cancelOrder: null, cancelAlgoOrder: null,
      conditionalProtectionSupported: false, ocoProtectionSupported: false,
      getBalance: 'account_get_balance', getTradeFee: 'account_get_trade_fee',
      clientOrderIdSupported: true, attachedProtectionSupported: false });
    const report = await h.agent.preflight();
    expect(report.checks.find(check => check.name === 'WRITE_CAPABILITIES')).toMatchObject({
      passed: true, detail: 'Spot order placement discovered',
    });
    expect(report.checks.find(check => check.name === 'EXECUTION_CAPABILITY')?.passed).toBe(true);
    expect(report.passed).toBe(true);
    expect(h.execution.submitApprovedOrder).not.toHaveBeenCalled();
    await h.agent.shutdown();
  });

  it('reports a local BTC versus exchange ETH discrepancy before live activation', async () => {
    const h = harness({ held: 'BTC-USDT' });
    expect((await h.agent.preflight()).passed).toBe(true);
    h.snapshot.positions = [{ symbol: 'ETH-USDT', quantity: 1, averageEntryPrice: 100, updatedAt: NOW }];
    const report = await h.agent.preflight();
    expect(report.passed).toBe(false);
    expect(report.checks.find(check => check.name === 'MONITOR_RECONCILIATION')?.detail).toContain('differ');
    expect(h.agent.activate()).toBe(false);
    await h.agent.shutdown();
  });
});

describe('AURA exit ownership and quantity handling', () => {
  const lot = 0.00001;

  it('owns only the fee-net base quantity after a BUY and exits whole lots, writing off dust', async () => {
    const h = harness();
    const plans: ApprovedOrderPlan[] = [];
    const fills: RecentSpotFill[] = [];
    vi.mocked(h.execution.submitApprovedOrder).mockImplementation(async plan => {
      plans.push(plan);
      const orderId = `order-${plans.length}`;
      // OKX charges spot BUY fees in the base currency and SELL fees in the quote currency.
      fills.push({ symbol: plan.symbol, fillId: `fill-${orderId}`, orderId, clientOrderId: plan.clientOrderId,
        side: plan.side === 'BUY' ? 'buy' : 'sell', quantity: plan.quantity, price: plan.referencePrice,
        fee: plan.side === 'BUY' ? -plan.quantity * 0.001 : -plan.quantity * plan.referencePrice * 0.001,
        feeCurrency: plan.side === 'BUY' ? 'BTC' : 'USDT', timestamp: NOW });
      return { status: 'ACCEPTED' as const, symbol: plan.symbol, clientOrderId: plan.clientOrderId,
        cycleId: plan.cycleId, decisionId: plan.decisionId, accepted: true, exchangeOrderId: orderId,
        reason: null, timestamp: NOW, protectionMode: 'CLIENT_SIDE' as const, protectionVerified: false };
    });
    vi.mocked(h.execution.reconcile).mockImplementation(async request => ({ outcome: 'FILLED' as const,
      symbol: request.symbol, clientOrderId: request.clientOrderId, cycleId: request.cycleId,
      decisionId: request.decisionId, position: null, reconciled: true, reason: 'filled', timestamp: NOW,
      order: { symbol: request.symbol, clientOrderId: request.clientOrderId, cycleId: request.cycleId,
        decisionId: request.decisionId, exchangeOrderId: request.exchangeOrderId ?? null,
        state: 'FILLED' as const, requestedQuantity: request.quantity, filledQuantity: request.quantity,
        averageFillPrice: 100, updatedAt: NOW, fee: -0.001, feeCurrency: 'USDT', tradeId: `trade-${request.exchangeOrderId ?? request.clientOrderId}`, fillTime: NOW } }));
    vi.mocked(h.market.getRecentSpotFills).mockImplementation(async symbol => fills.filter(fill => fill.symbol === symbol));
    await h.agent.preflight(); h.agent.activate();
    expect((await h.agent.runSlowCycle()).status).toBe('SUBMITTED');
    const entry = plans[0]!;
    const owned = entry.quantity - entry.quantity * 0.001;
    const position = await h.agent.positionMonitor!.getOpenPosition();
    expect(position?.quantity).toBeCloseTo(owned, 12);
    expect(position!.quantity).toBeLessThan(entry.quantity);
    expect(h.agent.pendingOrderId).toBeNull();

    h.snapshot.positions = [{ symbol: 'BTC-USDT', quantity: owned, averageEntryPrice: 100, updatedAt: NOW }];
    vi.mocked(h.market.getTicker).mockResolvedValue({ symbol: 'BTC-USDT', bid: 79.99, ask: 80.01, last: 80, timestamp: NOW });
    await h.agent.runFastCycle();
    const exit = plans[1]!;
    expect(exit.side).toBe('SELL');
    expect(exit.quantity).toBeLessThanOrEqual(owned);
    expect(Math.abs(exit.quantity / lot - Math.round(exit.quantity / lot))).toBeLessThan(1e-6);
    expect(owned - exit.quantity).toBeLessThan(lot);
    expect(await h.agent.positionMonitor!.getOpenPosition()).toBeNull();
    expect(h.agent.pendingOrderId).toBeNull();
    expect(h.agent.state).toBe('LIVE');
    expect(h.agent.positionMonitor!.getRecentDecisionMemory()[0]?.resultCategory).toBe('CLOSED');
    await h.agent.shutdown();
  });

  it('reconciles an exchange-side exit from external sell fills instead of sending a second SELL', async () => {
    const h = harness({ held: 'BTC-USDT', tickerPrice: 80 });
    expect((await h.agent.preflight()).passed).toBe(true);
    h.agent.activate();
    h.snapshot.positions = [];
    vi.mocked(h.market.getRecentSpotFills).mockResolvedValue([{ symbol: 'BTC-USDT', fillId: 'fill-algo',
      orderId: 'algo-1', clientOrderId: null, side: 'sell', quantity: 1, price: 96, fee: -0.096,
      feeCurrency: 'USDT', timestamp: NOW - 10 }]);
    await h.agent.runFastCycle();
    expect(h.execution.submitApprovedOrder).not.toHaveBeenCalled();
    expect(await h.agent.positionMonitor!.getOpenPosition()).toBeNull();
    expect(h.agent.state).toBe('LIVE');
    await h.agent.shutdown();
  });

  it('fails closed when the managed quantity is missing without matching sell fills', async () => {
    const h = harness({ held: 'ETH-USDT', tickerPrice: 80 });
    expect((await h.agent.preflight()).passed).toBe(true);
    h.agent.activate();
    h.snapshot.positions = [];
    await h.agent.runFastCycle();
    expect(h.execution.submitApprovedOrder).not.toHaveBeenCalled();
    expect((await h.agent.positionMonitor!.getOpenPosition())?.symbol).toBe('ETH-USDT');
    expect(h.agent.state).toBe('DEGRADED');
    await h.agent.shutdown();
  });
});

describe('AURA attached protection lifecycle and observe mode', () => {
  function wireFilledExecution(h: ReturnType<typeof harness>, protectionIds: readonly string[] = []) {
    const plans: ApprovedOrderPlan[] = [];
    const fills: RecentSpotFill[] = [];
    vi.mocked(h.execution.submitApprovedOrder).mockImplementation(async plan => {
      plans.push(plan);
      const orderId = `order-${plans.length}`;
      fills.push({ symbol: plan.symbol, fillId: `fill-${orderId}`, orderId, clientOrderId: plan.clientOrderId,
        side: plan.side === 'BUY' ? 'buy' : 'sell', quantity: plan.quantity, price: plan.referencePrice,
        fee: plan.side === 'BUY' ? -plan.quantity * 0.001 : -plan.quantity * plan.referencePrice * 0.001,
        feeCurrency: plan.side === 'BUY' ? 'BTC' : 'USDT', timestamp: NOW });
      return { status: 'ACCEPTED' as const, symbol: plan.symbol, clientOrderId: plan.clientOrderId,
        cycleId: plan.cycleId, decisionId: plan.decisionId, accepted: true, exchangeOrderId: orderId,
        reason: null, timestamp: NOW, protectionMode: plan.side === 'BUY' && protectionIds.length
          ? 'EXCHANGE_SIDE' as const : 'CLIENT_SIDE' as const,
        protectionVerified: protectionIds.length > 0,
        ...(plan.side === 'BUY' ? { protectionIds: [...protectionIds] } : {}) };
    });
    vi.mocked(h.execution.reconcile).mockImplementation(async request => ({ outcome: 'FILLED' as const,
      symbol: request.symbol, clientOrderId: request.clientOrderId, cycleId: request.cycleId,
      decisionId: request.decisionId, position: null, reconciled: true, reason: 'filled', timestamp: NOW,
      order: { symbol: request.symbol, clientOrderId: request.clientOrderId, cycleId: request.cycleId,
        decisionId: request.decisionId, exchangeOrderId: request.exchangeOrderId ?? null,
        state: 'FILLED' as const, requestedQuantity: request.quantity, filledQuantity: request.quantity,
        averageFillPrice: 100, updatedAt: NOW, fee: -0.001, feeCurrency: 'USDT', tradeId: `trade-${request.exchangeOrderId ?? request.clientOrderId}`, fillTime: NOW } }));
    vi.mocked(h.market.getRecentSpotFills).mockImplementation(async symbol => fills.filter(fill => fill.symbol === symbol));
    return { plans, fills };
  }

  it('cancels the entry-linked attached protection after a client-side exit and keeps it away from the next same-symbol trade', async () => {
    const h = harness();
    const { plans } = wireFilledExecution(h, ['algo-1']);
    await h.agent.preflight(); h.agent.activate();
    expect((await h.agent.runSlowCycle()).status).toBe('SUBMITTED');
    const position = await h.agent.positionMonitor!.getOpenPosition();
    expect(position).toMatchObject({ entryOrderId: 'order-1', attachedProtectionIds: ['algo-1'], protectionMode: 'EXCHANGE_SIDE' });
    expect(h.execution.cancelAttachedProtection).not.toHaveBeenCalled();

    h.snapshot.positions = [{ symbol: 'BTC-USDT', quantity: position!.quantity, averageEntryPrice: 100, updatedAt: NOW }];
    vi.mocked(h.market.getTicker).mockResolvedValue({ symbol: 'BTC-USDT', bid: 79.99, ask: 80.01, last: 80, timestamp: NOW });
    await h.agent.runFastCycle();
    expect(plans[1]?.side).toBe('SELL');
    expect(await h.agent.positionMonitor!.getOpenPosition()).toBeNull();
    expect(h.execution.cancelAttachedProtection).toHaveBeenCalledTimes(1);
    expect(vi.mocked(h.execution.cancelAttachedProtection!).mock.calls[0]?.[0]).toMatchObject({
      symbol: 'BTC-USDT', entryOrderId: 'order-1', protectionIds: ['algo-1'] });
    expect(h.agent.state).toBe('LIVE');

    // A second trade in the same symbol starts from its own protection plan, not the old stop levels.
    h.snapshot.positions = [];
    vi.mocked(h.market.getTicker).mockResolvedValue({ symbol: 'BTC-USDT', bid: 99.99, ask: 100.01, last: 100, timestamp: NOW });
    expect((await h.agent.runSlowCycle()).status).toBe('SUBMITTED');
    const next = await h.agent.positionMonitor!.getOpenPosition();
    expect(next?.entryOrderId).toBe('order-3');
    expect(h.agent.getJudgeSnapshot()?.functional.position?.stopPrice).toBe(97);
    await h.agent.shutdown();
  });

  it('blocks new entries when attached protection cleanup is ambiguous', async () => {
    const h = harness();
    const { plans } = wireFilledExecution(h, ['algo-1']);
    vi.mocked(h.execution.cancelAttachedProtection!).mockResolvedValue({ status: 'AMBIGUOUS',
      protectionIds: ['algo-1'], reason: 'still pending' });
    await h.agent.preflight(); h.agent.activate();
    expect((await h.agent.runSlowCycle()).status).toBe('SUBMITTED');
    const position = await h.agent.positionMonitor!.getOpenPosition();
    h.snapshot.positions = [{ symbol: 'BTC-USDT', quantity: position!.quantity, averageEntryPrice: 100, updatedAt: NOW }];
    vi.mocked(h.market.getTicker).mockResolvedValue({ symbol: 'BTC-USDT', bid: 79.99, ask: 80.01, last: 80, timestamp: NOW });
    await h.agent.runFastCycle();
    expect(await h.agent.positionMonitor!.getOpenPosition()).toBeNull();
    expect(h.agent.state).toBe('DEGRADED');
    expect(h.agent.getJudgeSnapshot()?.safety.reconciliationPending).toBe(true);
    const submissions = plans.length;
    expect((await h.agent.runSlowCycle()).status).toBe('BLOCKED');
    expect(plans).toHaveLength(submissions);
    await h.agent.shutdown();
  });

  it('sells only the managed quantity when the exchange also holds unmanaged inventory', async () => {
    const h = harness({ held: 'BTC-USDT', tickerPrice: 80 });
    expect((await h.agent.preflight()).passed).toBe(true);
    h.agent.activate();
    h.snapshot.positions = [{ symbol: 'BTC-USDT', quantity: 2.5, averageEntryPrice: 100, updatedAt: NOW }];
    await h.agent.runFastCycle();
    expect(h.execution.submitApprovedOrder).toHaveBeenCalledTimes(1);
    expect(vi.mocked(h.execution.submitApprovedOrder).mock.calls[0]?.[0]).toMatchObject({ side: 'SELL', quantity: 1 });
    await h.agent.shutdown();
  });

  it('produces the Market Critic verdict and Risk Certificate in observe mode without any WRITE call', async () => {
    const snapshots: ObserverSnapshot[] = [];
    const h = harness({ profile: 'demo', observer: snapshot => { snapshots.push(snapshot); } });
    expect((await h.agent.preflight()).readiness).toBe('READY_FOR_DEMO');
    expect(h.agent.activate()).toBe(false);
    const result = await h.agent.runSlowCycle();
    expect(result).toMatchObject({ status: 'BLOCKED', selectedSymbol: 'BTC-USDT', reason: 'OBSERVE_ONLY_EXECUTION_WITHHELD' });
    expect(h.llm.evaluateSelectedCandidate).toHaveBeenCalledTimes(1);
    expect(h.execution.submitApprovedOrder).not.toHaveBeenCalled();
    expect(h.connector.callTool).not.toHaveBeenCalled();
    expect(h.execution.getWriteTraces?.()).toEqual([]);
    const judge = h.agent.getJudgeSnapshot()!;
    expect(judge.functional.state).toBe('OBSERVE_ONLY');
    expect(Object.keys(judge.functional.markets).sort()).toEqual(['BTC-USDT', 'ETH-USDT']);
    expect(judge.reasoning.criticVerdict).toBe('AGREE');
    expect(judge.reasoning.counterThesis).toBe('test');
    expect(judge.reasoning.riskCertificate?.verdict).toBe('ALLOW');
    expect(judge.reasoning.riskCertificate?.gates.length).toBeGreaterThan(20);
    expect(judge.atk.latestProvenance?.nodes.some(node => node.source === 'LLM')).toBe(true);
    expect(judge.atk.latestProvenance?.nodes.some(node => node.source === 'RISK')).toBe(true);
    expect(judge.atk.latestProvenance?.nodes.some(node => node.lane === 'WRITE')).toBe(false);
    expect(judge.atk.recentTraces.some(trace => trace.lane === 'WRITE')).toBe(false);
    expect(snapshots.at(-1)?.llm?.action).toBe('AGREE');
    expect(snapshots.at(-1)?.riskCertificate?.verdict).toBe('ALLOW');
    await h.agent.shutdown();
  });

  it('blocks readiness on pending algo protection that is not linked to the restored AURA trade', async () => {
    const h = harness();
    vi.mocked(h.execution.getPendingProtection!).mockImplementation(async symbol => symbol === 'ETH-USDT'
      ? [{ symbol, algoId: 'orphan-1', algoClientOrderId: null, orderId: null }] : []);
    const report = await h.agent.preflight();
    expect(report.readiness).toBe('BLOCKED');
    expect(report.checks.find(check => check.name === 'UNRESOLVED_PROTECTION')).toMatchObject({ passed: false });
    expect(report.checks.find(check => check.name === 'UNRESOLVED_PROTECTION')?.detail).toContain('ETH-USDT:orphan-1');
    expect(h.agent.activate()).toBe(false);
    await h.agent.shutdown();
  });

  it('accepts pending protection linked to the checkpoint-backed entry after a restart', async () => {
    await withRecoveryAgent(async (agent, h, store) => {
      await saveOwnedPosition(store, 'ETH-USDT');
      h.snapshot.positions = [{ symbol: 'ETH-USDT', quantity: 1, averageEntryPrice: 100, updatedAt: NOW }];
      vi.mocked(h.execution.getPendingProtection!).mockImplementation(async symbol => symbol === 'ETH-USDT'
        ? [{ symbol, algoId: 'algo-linked', algoClientOrderId: null, orderId: 'order-1' }] : []);
      const report = await agent.preflight();
      expect(report.checks.find(check => check.name === 'UNRESOLVED_PROTECTION')).toMatchObject({ passed: true });
      expect(report.positionSymbol).toBe('ETH-USDT');
      expect((await agent.positionMonitor!.getOpenPosition())?.entryOrderId).toBe('order-1');
    });
  });
});

describe('ATK profile credential and mode verification', () => {
  function withSystemCapabilities(h: ReturnType<typeof harness>, capabilities: Record<string, unknown>) {
    h.connector.getCapabilities = () => ({
      has: (capability: string) => capability === 'SYSTEM_CAPABILITIES' || capability !== 'NEVER',
      resolve: (capability: string) => capability === 'SYSTEM_CAPABILITIES' ? 'system_get_capabilities' : null,
      missing: () => [], names: () => toolNames, reverse: () => null, toolCount: toolNames.length,
    }) as unknown as ReturnType<NonNullable<OkxConnector['getCapabilities']>>;
    vi.mocked(h.connector.callTool).mockImplementation(async name => {
      if (name === 'system_get_capabilities') return { capabilities } as never;
      throw new Error('Unexpected real MCP call');
    });
  }

  it('fails closed when the ATK profile loaded no credentials', async () => {
    const h = harness();
    withSystemCapabilities(h, { readOnly: true, hasAuth: false, demo: false });
    const report = await h.agent.preflight();
    expect(report.readiness).toBe('BLOCKED');
    expect(report.checks.find(check => check.name === 'SERVER_AUTH')?.detail).toContain('[profiles.<name>]');
    expect(h.agent.activate()).toBe(false);
    await h.agent.shutdown();
  });

  it('fails closed when the ATK server mode contradicts the AURA profile', async () => {
    const h = harness({ profile: 'demo' });
    withSystemCapabilities(h, { readOnly: true, hasAuth: true, demo: false });
    const report = await h.agent.preflight();
    expect(report.checks.find(check => check.name === 'SERVER_MODE')?.passed).toBe(false);
    expect(report.readiness).toBe('BLOCKED');
    await h.agent.shutdown();
  });

  it('passes when credentials are loaded and the mode matches', async () => {
    const h = harness();
    withSystemCapabilities(h, { readOnly: true, hasAuth: true, demo: false });
    const report = await h.agent.preflight();
    expect(report.checks.find(check => check.name === 'SERVER_AUTH')?.passed).toBe(true);
    expect(report.checks.find(check => check.name === 'SERVER_MODE')?.passed).toBe(true);
    expect(report.passed).toBe(true);
    await h.agent.shutdown();
  });
});

describe('attached protection demo verifier (production entry path)', () => {
  type Ctx = { agent: AuraAgent; h: ReturnType<typeof harness>; plans: ApprovedOrderPlan[];
    marker: { begin: ReturnType<typeof vi.fn>; clear: ReturnType<typeof vi.fn> }; events: AuditEvent[] };
  async function verifier(options: { profile?: 'demo' | 'live'; armed?: boolean; verified?: boolean;
    cleanup?: 'CANCELLED' | 'AMBIGUOUS' | 'NONE'; fillsIndexLag?: boolean }, run: (ctx: Ctx) => Promise<void>): Promise<void> {
    const directory = await mkdtemp(join(tmpdir(), 'aura-attached-'));
    const profile = options.profile ?? 'demo';
    const armed = options.armed ?? false;
    const verified = options.verified !== false;
    const events: AuditEvent[] = [];
    const h = harness({ profile, armed });
    Object.defineProperty(h.connector, 'readOnly', { value: true });
    const store = new AgentRecoveryStore(join(directory, 'checkpoint.json'));
    const eth = { currency: 'ETH', equity: 1, available: 1 };
    h.snapshot.positions = [{ symbol: 'ETH-USDT', quantity: 1, averageEntryPrice: null, updatedAt: NOW }];
    h.snapshot.balances = [{ currency: 'USDT', equity: 10_000, available: 10_000 }, eth];
    h.execution.verifyDemoRuntime = vi.fn(async () => true);
    h.execution.getCapabilities = () => ({ placeOrder: 'spot_place_order', getOrder: 'spot_get_order',
      getOrders: 'spot_get_orders', getFills: 'spot_get_fills', getAlgoOrders: 'spot_get_algo_orders',
      placeAlgoOrder: 'spot_place_algo_order', algoClientOrderIdSupported: true, cancelOrder: null,
      cancelAlgoOrder: 'spot_cancel_algo_order', conditionalProtectionSupported: true, ocoProtectionSupported: true,
      getBalance: 'account_get_balance', getTradeFee: 'account_get_trade_fee', clientOrderIdSupported: true,
      attachedProtectionSupported: true });
    const plans: ApprovedOrderPlan[] = [];
    const fills: RecentSpotFill[] = [];
    let algoPending = false;
    vi.mocked(h.execution.submitApprovedOrder).mockImplementation(async plan => {
      plans.push(plan);
      const orderId = `order-${plans.length}`;
      if (plan.side === 'BUY') {
        const fee = plan.quantity * 0.001;
        fills.push({ symbol: plan.symbol, fillId: `fill-${orderId}`, orderId, clientOrderId: plan.clientOrderId,
          side: 'buy', quantity: plan.quantity, price: plan.referencePrice, fee: -fee, feeCurrency: 'ETH', timestamp: NOW });
        eth.equity = Number((eth.equity + plan.quantity - fee).toPrecision(15));
        algoPending = verified;
      } else {
        fills.push({ symbol: plan.symbol, fillId: `fill-${orderId}`, orderId, clientOrderId: plan.clientOrderId,
          side: 'sell', quantity: plan.quantity, price: plan.referencePrice,
          fee: -plan.quantity * plan.referencePrice * 0.001, feeCurrency: 'USDT', timestamp: NOW });
        eth.equity = Number((eth.equity - plan.quantity).toPrecision(15));
      }
      eth.available = eth.equity;
      h.snapshot.positions = [{ symbol: 'ETH-USDT', quantity: eth.equity, averageEntryPrice: null, updatedAt: NOW }];
      return { status: 'ACCEPTED' as const, symbol: plan.symbol, clientOrderId: plan.clientOrderId,
        cycleId: plan.cycleId, decisionId: plan.decisionId, accepted: true, exchangeOrderId: orderId, reason: null,
        timestamp: NOW, protectionMode: plan.side === 'BUY' ? (verified ? 'EXCHANGE_SIDE' as const : 'CLIENT_SIDE' as const) : null,
        protectionVerified: plan.side === 'BUY' && verified,
        protectionIds: plan.side === 'BUY' && verified ? ['parent-attach', 'oco-live'] : [] };
    });
    vi.mocked(h.execution.reconcile).mockImplementation(async request => ({ outcome: 'FILLED' as const,
      symbol: request.symbol, clientOrderId: request.clientOrderId, cycleId: request.cycleId,
      decisionId: request.decisionId, position: null, reconciled: true, reason: 'filled', timestamp: NOW,
      order: { symbol: request.symbol, clientOrderId: request.clientOrderId, cycleId: request.cycleId,
        decisionId: request.decisionId, exchangeOrderId: request.exchangeOrderId ?? null,
        state: 'FILLED' as const, requestedQuantity: request.quantity, filledQuantity: request.quantity,
        averageFillPrice: 100, updatedAt: NOW, fee: -0.001, feeCurrency: 'USDT', tradeId: `trade-${request.exchangeOrderId ?? request.clientOrderId}`, fillTime: NOW } }));
    vi.mocked(h.market.getRecentSpotFills).mockImplementation(async symbol => fills.filter(fill => fill.symbol === symbol
      && !(options.fillsIndexLag && fill.side === 'sell')));
    // Real OKX shape: the live OCO has its own algoId (not the parent attachAlgoId), no parent ordId, no client ID.
    vi.mocked(h.execution.getPendingProtection!).mockImplementation(async () => algoPending && plans[0]
      ? [{ symbol: 'ETH-USDT', algoId: 'oco-live', algoClientOrderId: null, orderId: null, side: 'sell', ordType: 'oco', state: 'live',
        quantity: Number((Math.floor((plans[0].quantity * 0.999) / 0.00001) * 0.00001).toPrecision(15)),
        slTriggerPx: plans[0].protection.initialStopPrice,
        tpTriggerPx: Number((Math.floor((plans[0].referencePrice + plans[0].protection.stopDistanceAbsolute * 2.5) / 0.01) * 0.01).toPrecision(15)),
        createdAt: NOW }] : []);
    vi.mocked(h.execution.cancelAttachedProtection!).mockImplementation(async link => {
      const status = options.cleanup ?? 'CANCELLED';
      if (status !== 'AMBIGUOUS') algoPending = false;
      return { status, protectionIds: [...link.protectionIds], reason: 'test' };
    });
    const marker = { begin: vi.fn(async () => undefined), clear: vi.fn(async () => undefined) };
    const agent = new AuraAgent(agentConfigFromEnv(env(profile, String(armed))), {
      connector: h.connector, market: h.market, execution: h.execution, llm: h.llm, now: () => NOW,
      audit: event => { events.push(event); }, evaluateSymbol: async symbol => evaluation(symbol, 80),
      startupContext: (snapshot, references) => store.context(snapshot, references),
      persistPosition: position => store.save(position), smokeRecovery: marker, demoSmokeNotice: () => undefined });
    try { await run({ agent, h, plans, marker, events }); }
    finally { await agent.shutdown(); await rm(directory, { recursive: true, force: true }); }
  }

  it('refuses a live profile before any submission', async () => {
    await verifier({ profile: 'live', armed: false }, async ({ agent, h, marker }) => {
      const result = await agent.attachedProtectionSmoke();
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('REFUSED');
      expect(h.execution.submitApprovedOrder).not.toHaveBeenCalled();
      expect(marker.begin).not.toHaveBeenCalled();
    });
  });

  it('refuses LIVE_TRADING_ARMED=true even on demo', async () => {
    await verifier({ profile: 'demo', armed: true }, async ({ agent, h }) => {
      const result = await agent.attachedProtectionSmoke();
      expect(result.reason).toContain('LIVE_TRADING_ARMED=false');
      expect(h.execution.submitApprovedOrder).not.toHaveBeenCalled();
    });
  });

  it('passes through the production path with attached TP/SL payload, net fee quantity, whole-lot exit, cleanup and intact inventory', async () => {
    await verifier({}, async ({ agent, h, plans, marker, events }) => {
      const result = await agent.attachedProtectionSmoke();
      expect(result.reason).not.toContain('MANUAL');
      expect(result.passed).toBe(true);
      expect(plans).toHaveLength(2);
      const [entry, exit] = plans as [ApprovedOrderPlan, ApprovedOrderPlan];
      expect(entry.side).toBe('BUY');
      expect(entry.tickSize).toBe(0.01);
      expect(entry.clientOrderId).toMatch(/^AURAENTRY[0-9a-f]{22}$/);
      expect(Math.abs(entry.protection.initialStopPrice / 0.01 - Math.round(entry.protection.initialStopPrice / 0.01))).toBeLessThan(1e-6);
      expect(entry.referencePrice - entry.protection.initialStopPrice).toBeCloseTo(entry.protection.stopDistanceAbsolute, 10);
      expect(entry.protection.takeProfitR).toBe(2.5);
      const netOwned = entry.quantity - entry.quantity * 0.001;
      expect(result.evidence.netOwnedBase).toBeCloseTo(netOwned, 12);
      expect(exit.side).toBe('SELL');
      expect(exit.quantity).toBeLessThanOrEqual(netOwned);
      expect(Math.abs(exit.quantity / 0.00001 - Math.round(exit.quantity / 0.00001))).toBeLessThan(1e-6);
      expect(result.evidence).toMatchObject({ protectionMode: 'EXCHANGE_SIDE', protectionVerified: true,
        protectionIds: ['parent-attach', 'oco-live'], linkedPendingProtection: 1, cleanupStatus: 'CANCELLED', entryOrderId: 'order-1', exitOrderId: 'order-2' });
      const cleanupLink = vi.mocked(h.execution.cancelAttachedProtection!).mock.calls[0]?.[0];
      expect(cleanupLink?.signature).toMatchObject({ slTriggerPx: entry.protection.initialStopPrice, quantity: result.evidence.netOwnedBase });
      expect(cleanupLink?.entryOrderId).toBe('order-1');
      expect(result.evidence.dustQuantity).toBeLessThan(0.00001);
      expect(h.execution.cancelAttachedProtection).toHaveBeenCalledTimes(1);
      expect(marker.begin).toHaveBeenCalledTimes(1);
      expect(marker.clear).toHaveBeenCalledTimes(1);
      expect(await agent.positionMonitor!.getOpenPosition()).toBeNull();
      expect(agent.state).not.toBe('DEGRADED');
      // Unmanaged inventory (1 ETH) untouched: the exchange holds inventory plus sub-lot dust only.
      expect(h.snapshot.positions[0]?.quantity).toBeGreaterThanOrEqual(1);
      expect(events.some(e => e.eventType === 'EXECUTION_RESULT'
        && (e.payload as { protectionMode?: string; protectionVerified?: boolean }).protectionMode === 'EXCHANGE_SIDE'
        && (e.payload as { protectionVerified?: boolean }).protectionVerified === true)).toBe(true);
      expect(events.some(e => e.eventType === 'PROTECTION'
        && (e.payload as { reason?: string }).reason === 'ATTACHED_CLEANUP_CANCELLED')).toBe(true);
      expect(events.some(e => e.eventType === 'DEMO_SMOKE'
        && (e.payload as { stage?: string }).stage === 'ATTACHED_FINAL_STATE')).toBe(true);
    });
  });

  it('flattens safely but does not claim PASS when exchange-side protection is not proven', async () => {
    await verifier({ verified: false }, async ({ agent, plans, marker }) => {
      const result = await agent.attachedProtectionSmoke();
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('ATTACHED_PROTECTION_UNVERIFIED');
      expect(plans.map(plan => plan.side)).toEqual(['BUY', 'SELL']);
      expect(await agent.positionMonitor!.getOpenPosition()).toBeNull();
      expect(marker.clear).toHaveBeenCalledTimes(1);
    });
  });

  it('fails closed on ambiguous protection cleanup: marker kept, DEGRADED, no further orders', async () => {
    await verifier({ cleanup: 'AMBIGUOUS' }, async ({ agent, plans, marker }) => {
      const result = await agent.attachedProtectionSmoke();
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('MANUAL_RECONCILIATION_REQUIRED');
      expect(plans).toHaveLength(2);
      expect(marker.clear).not.toHaveBeenCalled();
      expect(agent.state).toBe('DEGRADED');
      expect((await agent.runSlowCycle()).status).toBe('BLOCKED');
      expect(plans).toHaveLength(2);
    });
  });

  it('reconciles the exit from the exact order record when the fills index lags, then passes', async () => {
    await verifier({ fillsIndexLag: true }, async ({ agent, h, plans, marker }) => {
      const result = await agent.attachedProtectionSmoke();
      expect(result.reason).not.toContain('MANUAL');
      expect(result.passed).toBe(true);
      expect(plans.map(plan => plan.side)).toEqual(['BUY', 'SELL']);
      expect(await agent.positionMonitor!.getOpenPosition()).toBeNull();
      expect(agent.pendingOrderId).toBeNull();
      expect(marker.clear).toHaveBeenCalledTimes(1);
      expect(h.execution.submitApprovedOrder).toHaveBeenCalledTimes(2);
    });
  });
});

describe('LIVE_ENTRY_PROTECTION_VERIFIED attestation', () => {
  it('defaults to false, accepts only true/false, and gates live readiness', async () => {
    expect(agentConfigFromEnv(env()).liveEntryProtectionVerified).toBe(false);
    expect(agentConfigFromEnv({ ...env(), LIVE_ENTRY_PROTECTION_VERIFIED: 'true' }).liveEntryProtectionVerified).toBe(true);
    expect(() => agentConfigFromEnv({ ...env(), LIVE_ENTRY_PROTECTION_VERIFIED: 'yes' })).toThrow('LIVE_ENTRY_PROTECTION_VERIFIED');
    const blocked = harness();
    blocked.execution.liveEntryProtectionReady = () => false;
    expect((await blocked.agent.preflight()).readiness).toBe('BLOCKED');
    await blocked.agent.shutdown();
    const attested = harness();
    attested.execution.liveEntryProtectionReady = () => true;
    const report = await attested.agent.preflight();
    expect(report.checks.find(check => check.name === 'LIVE_ENTRY_PROTECTION')?.passed).toBe(true);
    expect(report.readiness).toBe('READY_FOR_LIVE');
    await attested.agent.shutdown();
  });
});

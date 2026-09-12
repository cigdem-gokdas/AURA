import { describe, expect, it, vi } from 'vitest';
import { AuraAgent, type AgentDependencies, type ObserverSnapshot, type SymbolEvaluation } from '../../src/agent/agent.js';
import { agentConfigFromEnv, parseSymbols } from '../../src/agent/config.js';
import type { ExecutionEngine, StartupExchangeSnapshot } from '../../src/execution/types.js';
import type { FeatureSnapshot } from '../../src/features/types.js';
import type { LlmClient } from '../../src/llm/types.js';
import type { MarketAdapter } from '../../src/market/types.js';
import type { OkxConnector } from '../../src/okx/connector.js';
import type { ProtectionPlan } from '../../src/risk/types.js';
import type { CandidateSignal } from '../../src/signal/types.js';
import { createProductionAgent } from '../../src/main.js';

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
  llmFailure?: boolean; ambiguous?: boolean; evaluationDelay?: Promise<void>; tickerPrice?: number } = {}) {
  const profile = options.profile ?? 'live';
  let connected = false;
  const connector: OkxConnector = {
    profile, connect: vi.fn(async () => { connected = true; }),
    disconnect: vi.fn(async () => { connected = false; }), isConnected: () => connected,
    healthCheck: vi.fn(async () => ({ connected, profile, status: connected ? 'HEALTHY' as const : 'UNAVAILABLE' as const,
      reason: null, timestamp: NOW })),
    listTools: vi.fn(async () => toolNames.map(name => ({ name, description: null, inputSchema: {} }))),
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
    start: vi.fn(async () => { await connector.connect(); }),
    submitApprovedOrder: vi.fn(async plan => ({ status: options.ambiguous ? 'RECONCILE_REQUIRED' as const : 'ACCEPTED' as const,
      symbol: plan.symbol, clientOrderId: plan.clientOrderId, cycleId: plan.cycleId, decisionId: plan.decisionId,
      accepted: !options.ambiguous, exchangeOrderId: options.ambiguous ? null : 'order-1', reason: null,
      timestamp: NOW, protectionMode: 'CLIENT_SIDE' as const, protectionVerified: false })),
    getOrderStatus: vi.fn(async () => { throw new Error('unused'); }),
    reconcile: vi.fn(async request => ({ outcome: 'NOT_FOUND' as const, symbol: request.symbol,
      clientOrderId: request.clientOrderId, cycleId: request.cycleId, decisionId: request.decisionId,
      order: null, position: null, reconciled: false, reason: 'not found', timestamp: NOW })),
    getStartupSnapshot: vi.fn(async () => snapshot),
  };
  const llm: LlmClient = { evaluateSelectedCandidate: vi.fn(async () => options.llmFailure
    ? { status: 'TIMEOUT' as const } : { status: 'SUCCESS' as const,
      decision: { action: 'AGREE' as const, confidence: 0.8, regime_confirmation: 'TRENDING_UP' as const,
        setup_quality: 'A' as const, risk_flag: 'LOW' as const, reason: 'test', counter_thesis: 'test',
        memory_signal: 'NONE' as const }, latencyMs: 1,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, estimatedCostUsd: 0 } }) };
  const evaluated: string[] = [];
  const deps: AgentDependencies = { connector, market, execution, llm, now: () => NOW,
    evaluateSymbol: vi.fn(async symbol => { evaluated.push(symbol);
      if (options.evaluationDelay) await options.evaluationDelay;
      return evaluation(symbol, options.scores?.[symbol] ?? 80, options.edges?.[symbol] ?? 3); }),
    startupContext: (snap, references) => options.held ? { referencePrices: references,
      openedAtBySymbol: { [options.held]: NOW - 100 }, protectionPlans: { [options.held]: protection(options.held) },
      protectionModes: { [options.held]: 'CLIENT_SIDE' } } :
      { referencePrices: references, openedAtBySymbol: {}, protectionPlans: {}, protectionModes: {} },
  };
  if (options.observer) deps.observer = options.observer;
  const agent = new AuraAgent(agentConfigFromEnv(env(profile, String(options.armed ?? true))), deps);
  return { agent, connector, market, execution, llm, evaluated, snapshot };
}

describe('AURA orchestration', () => {
  it('parses an ordered unique symbol universe and rejects duplicates', () => {
    expect(parseSymbols(' ETH-USDT , BTC-USDT ')).toEqual(['ETH-USDT', 'BTC-USDT']);
    expect(() => parseSymbols('BTC-USDT,BTC-USDT')).toThrow();
    expect(() => parseSymbols('')).toThrow();
  });

  it('constructs one inert connector shared by market and execution', () => {
    const production = createProductionAgent({ ...env(), OKX_LIVE_PROFILE: 'competition' });
    const deps = (production as unknown as { deps: AgentDependencies }).deps;
    expect((deps.market as unknown as { connector: OkxConnector }).connector).toBe(deps.connector);
    expect((deps.execution as unknown as { connector: OkxConnector }).connector).toBe(deps.connector);
    expect(deps.connector.isConnected()).toBe(false);
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
    await h.agent.shutdown();
  });

  it('uses edge/cost after an OQS tie', async () => {
    const h = harness({ scores: { 'BTC-USDT': 80, 'ETH-USDT': 80 },
      edges: { 'BTC-USDT': 2, 'ETH-USDT': 4 } });
    await h.agent.preflight(); h.agent.activate();
    expect((await h.agent.runSlowCycle()).selectedSymbol).toBe('ETH-USDT');
    await h.agent.shutdown();
  });

  it('publishes HOLD without LLM or order, and ignores observer failure', async () => {
    const observer = vi.fn(() => { throw new Error('observer failure'); });
    const h = harness({ scores: { 'BTC-USDT': 0, 'ETH-USDT': 0 }, observer });
    await h.agent.preflight(); h.agent.activate();
    expect((await h.agent.runSlowCycle()).status).toBe('HOLD');
    expect(observer).toHaveBeenCalledTimes(1);
    expect(h.llm.evaluateSelectedCandidate).not.toHaveBeenCalled();
    expect(h.execution.submitApprovedOrder).not.toHaveBeenCalled();
    await h.agent.shutdown();
  });

  it.each(symbols)('reconstructs an exchange %s position and bypasses entry ranking and critic', async held => {
    const h = harness({ held });
    const report = await h.agent.preflight();
    expect(report.positionSymbol).toBe(held);
    expect(report.passed).toBe(true);
    h.agent.activate();
    expect((await h.agent.runSlowCycle()).status).toBe('MONITORING');
    expect(h.evaluated).toEqual([held]);
    expect(h.llm.evaluateSelectedCandidate).not.toHaveBeenCalled();
    expect(h.execution.submitApprovedOrder).not.toHaveBeenCalled();
    await h.agent.runFastCycle();
    expect(h.llm.evaluateSelectedCandidate).not.toHaveBeenCalled();
    await h.agent.shutdown();
  });

  it('executes a BTC hard-stop path on the fast loop even when the critic is unavailable', async () => {
    const h = harness({ held: 'BTC-USDT', llmFailure: true, tickerPrice: 80 });
    expect((await h.agent.preflight()).passed).toBe(true);
    h.agent.activate();
    await h.agent.runFastCycle();
    expect(h.execution.submitApprovedOrder).toHaveBeenCalledTimes(1);
    expect(vi.mocked(h.execution.submitApprovedOrder).mock.calls[0]?.[0].side).toBe('SELL');
    expect(h.llm.evaluateSelectedCandidate).not.toHaveBeenCalled();
    await h.agent.runFastCycle();
    expect(h.execution.submitApprovedOrder).toHaveBeenCalledTimes(1);
    await h.agent.shutdown();
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

  it('publishes a rejected entry with certificate and sanitized performance', async () => {
    const snapshots: ObserverSnapshot[] = [];
    const h = harness({ llmFailure: true, observer: snapshot => { snapshots.push(snapshot); } });
    await h.agent.preflight(); h.agent.activate();
    expect((await h.agent.runSlowCycle()).status).toBe('REJECTED');
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.selectedSymbol).toBe('BTC-USDT');
    expect(snapshots[0]?.selectedOQS).toBe(80);
    expect(snapshots[0]?.llm?.status).toBe('TIMEOUT');
    expect(snapshots[0]?.riskCertificate?.verdict).toBe('REJECT');
    expect(snapshots[0]?.equity?.starting).toBe(10_000);
    expect(h.execution.submitApprovedOrder).not.toHaveBeenCalled();
    await h.agent.shutdown();
  });

  it('publishes an accepted order cycle with its risk certificate', async () => {
    const snapshots: ObserverSnapshot[] = [];
    const h = harness({ observer: snapshot => { snapshots.push(snapshot); } });
    await h.agent.preflight(); h.agent.activate();
    expect((await h.agent.runSlowCycle()).status).toBe('SUBMITTED');
    expect(snapshots[0]?.riskCertificate?.verdict).toBe('ALLOW');
    expect(snapshots[0]?.llm?.action).toBe('AGREE');
    expect(snapshots[0]?.equity?.current).toBe(10_000);
    await h.agent.shutdown();
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

  it('keeps calibration read-only and groups diagnostics by symbol', async () => {
    const h = harness();
    const report = await h.agent.calibrate();
    expect(report.diagnostics.combined.evaluated).toBe(2);
    expect(Object.keys(report.diagnostics.bySymbol)).toEqual(symbols);
    expect(h.execution.submitApprovedOrder).not.toHaveBeenCalled();
    await h.agent.shutdown();
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

  it('reports a local BTC versus exchange ETH discrepancy before live activation', async () => {
    const h = harness({ held: 'BTC-USDT' });
    expect((await h.agent.preflight()).passed).toBe(true);
    h.snapshot.positions = [{ symbol: 'ETH-USDT', quantity: 1, averageEntryPrice: 100, updatedAt: NOW }];
    const report = await h.agent.preflight();
    expect(report.passed).toBe(false);
    expect(report.checks.find(check => check.name === 'MONITOR_RECONCILIATION')?.detail).toContain('differs');
    expect(h.agent.activate()).toBe(false);
    await h.agent.shutdown();
  });
});

import { describe, expect, it } from 'vitest';
import type { OkxConnector } from '../../src/okx/connector.js';
import { OkxConnectorError, type OkxToolDefinition } from '../../src/okx/types.js';
import type { ApprovedOrderPlan } from '../../src/risk/types.js';
import { OkxExecutionEngine } from '../../src/execution/engine.js';
import type { OrderRequest } from '../../src/execution/types.js';

const tool = (name: string, fields: string[]): OkxToolDefinition => ({
  name, description: name, inputSchema: { type: 'object', properties: Object.fromEntries(fields.map(field => [field, {
    type: 'string',
    ...(field === 'tdMode' ? { enum: ['cash', 'cross', 'isolated'] } : {}),
    ...(field === 'side' ? { enum: ['buy', 'sell'] } : {}),
    ...(field === 'ordType' ? { enum: name === 'spot_place_algo_order' ? ['conditional', 'oco'] : ['market', 'limit'] } : {}),
    ...(field === 'tgtCcy' ? { enum: ['base_ccy', 'quote_ccy'] } : {}),
  }])) },
});
const definitions = [
  tool('spot_place_order', ['instId', 'tdMode', 'side', 'ordType', 'sz', 'tgtCcy', 'clOrdId', 'tpTriggerPx', 'tpOrdPx', 'slTriggerPx', 'slOrdPx']),
  tool('spot_get_order', ['instId', 'ordId', 'clOrdId']),
  tool('spot_get_orders', ['status', 'instId']),
  tool('spot_get_fills', ['instId', 'archive']),
  tool('spot_get_algo_orders', ['status', 'instId']),
  tool('spot_place_algo_order', ['instId', 'side', 'ordType', 'sz', 'tpTriggerPx', 'tpOrdPx', 'slTriggerPx', 'slOrdPx']),
  tool('spot_cancel_algo_order', ['instId', 'algoId']),
  tool('account_get_balance', ['ccy']),
  tool('account_get_trade_fee', ['instType', 'instId']),
];
const envelope = (data: unknown[]) => ({ endpoint: '/api/v5/example', requestTime: '2026-09-12T00:00:00Z', data });

function plan(symbol = 'BTC-USDT', side: 'BUY' | 'SELL' = 'BUY'): ApprovedOrderPlan {
  return {
    symbol, side, quantity: 1.25, estimatedNotional: 125, referencePrice: 100,
    protection: { symbol, initialStopPrice: 97, stopDistanceFraction: 0.03,
      stopDistanceAbsolute: 3, breakEvenTriggerR: 1, trailingActivationR: 1.5,
      takeProfitR: 2.5, protectionMode: 'EXCHANGE_SIDE' },
    clientOrderId: 'client1', cycleId: 'cycle1', decisionId: 'decision1',
  };
}

class FakeConnector implements OkxConnector {
  readonly calls: { name: string; args: Record<string, unknown> }[] = [];
  connected = false;
  tools = [...definitions];
  placeResponse: unknown = envelope([{ ordId: 'order1', clOrdId: 'client1', sCode: '0' }]);
  placeError: Error | null = null;
  queryError: Error | null = null;
  lookupRows: Record<string, unknown>[] = [];
  verificationRows: Record<string, unknown>[] = [];
  algoRows: Record<string, unknown>[] = [];
  cancelSticky = false;
  cancelError: Error | null = null;
  openRows: Record<string, unknown>[] = [];
  historyRows: Record<string, unknown>[] = [];
  fillRows: Record<string, unknown>[] = [];
  balanceRows: Record<string, unknown>[] = [{
    totalEq: '1000', uTime: '1000', details: [
      { ccy: 'USDT', eq: '1000', availBal: '1000' },
      { ccy: 'BTC', eq: '2', availBal: '2', avgPx: '90' },
      { ccy: 'ETH', eq: '3', availBal: '3', avgPx: '190' },
    ],
  }];
  constructor(readonly profile: 'demo' | 'live' = 'demo') {}
  async connect() { this.connected = true; }
  async disconnect() { this.connected = false; }
  isConnected() { return this.connected; }
  async healthCheck() {
    return { connected: this.connected, profile: this.profile,
      status: this.connected ? 'HEALTHY' as const : 'UNAVAILABLE' as const,
      reason: null, timestamp: 1000 };
  }
  async listTools() { return this.tools; }
  async callTool<T>(name: string, args: Record<string, unknown>): Promise<T> {
    this.calls.push({ name, args });
    if (!this.connected) throw new OkxConnectorError('CONNECTOR_NOT_CONNECTED', 'Disconnected');
    if (name === 'spot_place_order') {
      if (this.placeError) throw this.placeError;
      return this.placeResponse as T;
    }
    if (name === 'spot_get_order') return envelope(args.ordId ? this.verificationRows : this.lookupRows) as T;
    if (name === 'spot_get_orders' && this.queryError) throw this.queryError;
    if (name === 'spot_get_orders') return envelope((args.status === 'history' ? this.historyRows : this.openRows)
      .filter(row => row.instId === args.instId)) as T;
    if (name === 'spot_get_fills') return envelope(this.fillRows.filter(row => row.instId === args.instId)) as T;
    if (name === 'spot_get_algo_orders') return envelope(this.algoRows.filter(row => row.instId === args.instId)) as T;
    if (name === 'spot_cancel_algo_order') {
      if (this.cancelError) throw this.cancelError;
      if (!this.cancelSticky) this.algoRows = this.algoRows.filter(row => row.algoId !== args.algoId);
      return envelope([{ algoId: args.algoId, sCode: '0' }]) as T;
    }
    if (name === 'account_get_balance') return envelope(this.balanceRows) as T;
    if (name === 'account_get_trade_fee') return envelope([{ maker: '-0.001', taker: '-0.0012', instId: args.instId }]) as T;
    throw new Error(`Unexpected tool: ${name}`);
  }
}

function request(symbol = 'BTC-USDT'): OrderRequest {
  return { symbol, clientOrderId: 'client1', cycleId: 'cycle1', decisionId: 'decision1',
    side: 'BUY', kind: 'MARKET', quantity: 1.25, limitPrice: null };
}
function orderRow(state: string, symbol = 'BTC-USDT') {
  return { instId: symbol, clOrdId: 'client1', ordId: 'order1', state,
    sz: '1.25', accFillSz: state === 'filled' ? '1.25' : '0', avgPx: state === 'filled' ? '100' : '', uTime: '1000' };
}

describe('OkxExecutionEngine through fake official MCP connector', () => {
  it('blocks unverified live BUY protection before placement while retaining live SELL exits', async () => {
    const connector = new FakeConnector('live');
    const engine = new OkxExecutionEngine(connector);
    await engine.start();
    expect(engine.liveEntryProtectionReady()).toBe(false);
    expect((await engine.submitApprovedOrder(plan())).status).toBe('REJECTED');
    expect(connector.calls.some(call => call.name === 'spot_place_order')).toBe(false);
    expect((await engine.submitApprovedOrder(plan('BTC-USDT', 'SELL'))).status).toBe('ACCEPTED');
    expect(connector.calls.filter(call => call.name === 'spot_place_order')).toHaveLength(1);
  });

  it('discovers actual tool schemas at explicit startup without calling a state-changing tool', async () => {
    const connector = new FakeConnector();
    const engine = new OkxExecutionEngine(connector);
    expect(connector.connected).toBe(false);
    await engine.start();
    expect(connector.calls).toEqual([]);
    expect(engine.getCapabilities()).toMatchObject({ placeOrder: 'spot_place_order',
      getOrder: 'spot_get_order', getOrders: 'spot_get_orders', getFills: 'spot_get_fills',
      getBalance: 'account_get_balance', getTradeFee: 'account_get_trade_fee',
      attachedProtectionSupported: true, placeAlgoOrder: 'spot_place_algo_order',
      conditionalProtectionSupported: true, ocoProtectionSupported: true });
  });

  it('maps BUY exactly to cash spot base quantity, client ID, and deterministic attached TP/SL', async () => {
    const connector = new FakeConnector();
    connector.verificationRows = [{ ...orderRow('live'), attachAlgoOrds: [{ attachAlgoId: 'parent-attach', slTriggerPx: '97', tpTriggerPx: '107.5' }] }];
    // OKX materializes the attached TP/SL as a live OCO whose algoId differs from attachAlgoId.
    connector.algoRows = [{ instId: 'BTC-USDT', algoId: 'oco-live', ordId: '', algoClOrdId: '', ordType: 'oco', side: 'sell', state: 'live', sz: '1.25', slTriggerPx: '97', tpTriggerPx: '107.5', cTime: '1000' }];
    const engine = new OkxExecutionEngine(connector);
    await engine.start();
    const result = await engine.submitApprovedOrder(plan());
    expect(result).toMatchObject({ status: 'ACCEPTED', accepted: true, symbol: 'BTC-USDT',
      clientOrderId: 'client1', exchangeOrderId: 'order1', protectionMode: 'EXCHANGE_SIDE', protectionVerified: true });
    expect(connector.calls.find(call => call.name === 'spot_place_order')).toEqual({ name: 'spot_place_order', args: {
      instId: 'BTC-USDT', tdMode: 'cash', side: 'buy', ordType: 'market',
      sz: '1.25', tgtCcy: 'base_ccy', clOrdId: 'client1',
      slTriggerPx: '97', slOrdPx: '-1', tpTriggerPx: '107.5', tpOrdPx: '-1',
    } });
    expect(connector.calls.find(call => call.name === 'spot_get_order' && 'ordId' in call.args)).toEqual({
      name: 'spot_get_order', args: { instId: 'BTC-USDT', ordId: 'order1' },
    });
    expect(connector.calls.filter(call => call.name === 'spot_place_order')).toHaveLength(1);
  });

  it('rejects punctuation in an exchange client ID before any order call', async () => {
    const connector = new FakeConnector();
    const engine = new OkxExecutionEngine(connector);
    await engine.start();
    const unsafe = plan(); unsafe.clientOrderId = 'aura100_1';
    expect((await engine.submitApprovedOrder(unsafe)).status).toBe('INVALID_PLAN');
    expect(connector.calls.some(call => call.name === 'spot_place_order')).toBe(false);
  });

  it('maps SELL to owned spot reduction, preserving quantity and symbol without attached entry protection', async () => {
    const connector = new FakeConnector();
    const engine = new OkxExecutionEngine(connector);
    await engine.start();
    const result = await engine.submitApprovedOrder(plan('BTC-USDT', 'SELL'));
    expect(result.status).toBe('ACCEPTED');
    expect(connector.calls.find(call => call.name === 'account_get_balance')).toEqual({ name: 'account_get_balance', args: {} });
    expect(connector.calls.find(call => call.name === 'spot_place_order')).toEqual({ name: 'spot_place_order', args: {
      instId: 'BTC-USDT', tdMode: 'cash', side: 'sell', ordType: 'market',
      sz: '1.25', tgtCcy: 'base_ccy', clOrdId: 'client1',
    } });
    const tooLarge = plan('ETH-USDT', 'SELL'); tooLarge.quantity = 4; tooLarge.estimatedNotional = 400;
    tooLarge.clientOrderId = 'client2';
    expect((await engine.submitApprovedOrder(tooLarge)).status).toBe('REJECTED');
    expect(connector.calls.filter(call => call.name === 'spot_place_order')).toHaveLength(1);
  });

  it('prevents duplicate client IDs and never resubmits after ambiguous failure', async () => {
    const connector = new FakeConnector();
    connector.placeError = new OkxConnectorError('TOOL_CALL_FAILED', 'MCP transport or tool failure');
    const engine = new OkxExecutionEngine(connector);
    await engine.start();
    expect((await engine.submitApprovedOrder(plan())).status).toBe('RECONCILE_REQUIRED');
    expect((await engine.submitApprovedOrder(plan())).status).toBe('DUPLICATE');
    expect(connector.calls.filter(call => call.name === 'spot_place_order')).toHaveLength(1);
  });

  it('prevents an exchange-known client ID after restart before any placement', async () => {
    const connector = new FakeConnector(); connector.lookupRows = [orderRow('live')];
    const engine = new OkxExecutionEngine(connector); await engine.start();
    expect((await engine.submitApprovedOrder(plan())).status).toBe('DUPLICATE');
    expect(connector.calls.filter(call => call.name === 'spot_place_order')).toEqual([]);
  });

  it('rejects inconsistent approved sizing and protection before any connector call', async () => {
    const connector = new FakeConnector(); const engine = new OkxExecutionEngine(connector); await engine.start();
    const inconsistent = plan(); inconsistent.estimatedNotional = 100;
    expect((await engine.submitApprovedOrder(inconsistent)).status).toBe('INVALID_PLAN');
    const wrongStop = plan(); wrongStop.protection = { ...wrongStop.protection, symbol: 'ETH-USDT' };
    expect((await engine.submitApprovedOrder(wrongStop)).status).toBe('INVALID_PLAN');
    expect(connector.calls).toEqual([]);
  });

  it('fails startup discovery when the installed spot schema cannot preserve base quantity', async () => {
    const connector = new FakeConnector();
    connector.tools = connector.tools.map(item => item.name === 'spot_place_order'
      ? tool('spot_place_order', ['instId', 'tdMode', 'side', 'ordType', 'sz', 'clOrdId']) : item);
    const engine = new OkxExecutionEngine(connector);
    await expect(engine.start()).rejects.toMatchObject({ category: 'TOOL_NOT_AVAILABLE' });
    expect(connector.calls).toEqual([]);
  });

  it('distinguishes explicit exchange rejection, malformed acknowledgement, and connector outage', async () => {
    const rejected = new FakeConnector();
    rejected.placeResponse = envelope([{ sCode: '51008', sMsg: 'insufficient balance', clOrdId: 'client1' }]);
    const engine1 = new OkxExecutionEngine(rejected); await engine1.start();
    expect((await engine1.submitApprovedOrder(plan())).status).toBe('REJECTED');
    const malformed = new FakeConnector(); malformed.placeResponse = envelope([]);
    const engine2 = new OkxExecutionEngine(malformed); await engine2.start();
    expect((await engine2.submitApprovedOrder(plan())).status).toBe('RECONCILE_REQUIRED');
    const disconnected = new FakeConnector(); const engine3 = new OkxExecutionEngine(disconnected);
    await engine3.start(); disconnected.connected = false;
    expect((await engine3.submitApprovedOrder(plan())).status).toBe('CONNECTOR_FAILURE');
    expect(disconnected.calls).toEqual([]);
  });

  it('uses CLIENT_SIDE fallback when attachment or verification capability is missing', async () => {
    const absent = new FakeConnector();
    absent.tools = absent.tools.map(item => item.name === 'spot_place_order'
      ? tool('spot_place_order', ['instId', 'tdMode', 'side', 'ordType', 'sz', 'tgtCcy', 'clOrdId']) : item);
    const engine1 = new OkxExecutionEngine(absent); await engine1.start();
    const result1 = await engine1.submitApprovedOrder(plan());
    expect(result1).toMatchObject({ status: 'ACCEPTED', protectionMode: 'CLIENT_SIDE', protectionVerified: false });
    expect(absent.calls.find(call => call.name === 'spot_place_order')?.args).not.toHaveProperty('slTriggerPx');
    const unverified = new FakeConnector(); const engine2 = new OkxExecutionEngine(unverified);
    await engine2.start();
    expect(await engine2.submitApprovedOrder(plan())).toMatchObject({
      status: 'ACCEPTED', protectionMode: 'CLIENT_SIDE', protectionVerified: false,
    });
  });

  it('verifies attached protection through the dedicated algo-order query when direct order details omit it', async () => {
    const connector = new FakeConnector();
    connector.algoRows = [{ instId: 'BTC-USDT', ordId: 'order1', slTriggerPx: '97', tpTriggerPx: '107.5' }];
    const engine = new OkxExecutionEngine(connector); await engine.start();
    expect(await engine.submitApprovedOrder(plan())).toMatchObject({
      status: 'ACCEPTED', protectionMode: 'EXCHANGE_SIDE', protectionVerified: true,
    });
    expect(connector.calls.some(call => call.name === 'spot_get_algo_orders')).toBe(true);
  });

  it.each([['filled', 'FILLED'], ['live', 'OPEN']])('reconciles %s orders as %s', async (state, expected) => {
    const connector = new FakeConnector(); connector.lookupRows = [orderRow(state)];
    const engine = new OkxExecutionEngine(connector); await engine.start();
    const result = await engine.reconcile(request());
    expect(result.outcome).toBe(expected);
    expect(result.reconciled).toBe(true);
    expect(connector.calls.every(call => call.name !== 'spot_place_order')).toBe(true);
  });

  it('uses order history and fills for reconciliation, and reports NOT_FOUND only after successful queries', async () => {
    const connector = new FakeConnector();
    const engine = new OkxExecutionEngine(connector); await engine.start();
    expect(await engine.reconcile(request())).toMatchObject({ outcome: 'NOT_FOUND', reconciled: false });
    connector.historyRows = [orderRow('filled')];
    expect((await engine.reconcile(request())).outcome).toBe('FILLED');
    connector.historyRows = [];
    connector.fillRows = [{ instId: 'BTC-USDT', clOrdId: 'client1', ordId: 'order1',
      tradeId: 'trade1', fillSz: '1.25', fillPx: '100', ts: '1000' }];
    expect((await engine.reconcile(request())).outcome).toBe('FILLED');
    connector.fillRows = [{ ...connector.fillRows[0], tradeId: undefined, billId: 'bill1' }];
    expect((await engine.reconcile(request())).outcome).toBe('FILLED');
    connector.fillRows = [{ ...connector.fillRows[0], billId: undefined }];
    expect((await engine.reconcile(request())).outcome).toBe('UNKNOWN');
  });

  it('reconciles by exchange order ID and treats failed queries as UNKNOWN', async () => {
    const connector = new FakeConnector();
    connector.verificationRows = [orderRow('filled')];
    const engine = new OkxExecutionEngine(connector); await engine.start();
    expect((await engine.reconcile({ ...request(), exchangeOrderId: 'order1' })).outcome).toBe('FILLED');
    connector.verificationRows = [];
    connector.queryError = new OkxConnectorError('TOOL_CALL_FAILED', 'Query failed');
    expect((await engine.reconcile(request())).outcome).toBe('UNKNOWN');
  });

  it('returns UNKNOWN on disconnected reconciliation without placing another order', async () => {
    const connector = new FakeConnector(); const engine = new OkxExecutionEngine(connector);
    await engine.start(); connector.connected = false;
    expect((await engine.reconcile(request())).outcome).toBe('UNKNOWN');
    expect(connector.calls).toEqual([]);
  });

  it('builds startup BTC/ETH holdings, open orders, recent fills, balances, fees, and lookup capability', async () => {
    const connector = new FakeConnector('demo');
    connector.openRows = [orderRow('live')];
    connector.fillRows = [{ instId: 'ETH-USDT', ordId: 'filled2', clOrdId: 'client2',
      tradeId: 'trade2', side: 'buy', fillSz: '0.5', fillPx: '200', fee: '-0.001',
      feeCcy: 'ETH', fillTime: '1789217747000' }];
    const engine = new OkxExecutionEngine(connector);
    await engine.start();
    const snapshot = await engine.getStartupSnapshot();
    expect(snapshot.profile).toBe('demo');
    expect(snapshot.totalEquityUsd).toBe(1000);
    expect(snapshot.positions).toEqual([
      { symbol: 'BTC-USDT', quantity: 2, averageEntryPrice: 90, updatedAt: 1000 },
      { symbol: 'ETH-USDT', quantity: 3, averageEntryPrice: 190, updatedAt: 1000 },
    ]);
    expect(snapshot.openOrders).toHaveLength(1);
    expect(snapshot.recentFills).toMatchObject([{ symbol: 'ETH-USDT', clientOrderId: 'client2', quantity: 0.5 }]);
    expect(snapshot.feeRates).toHaveLength(2);
    expect(snapshot.balances).toHaveLength(3);
    expect(snapshot.orderLookupSupported).toBe(true);
    expect(connector.calls.some(call => call.name === 'spot_get_order' && call.args.clOrdId === 'client1')).toBe(true);
    expect(connector.calls.every(call => call.name !== 'spot_place_order')).toBe(true);
  });

  it('ignores extraneous confidence fields and never invokes CLI or an arbitrary tool', async () => {
    const connector = new FakeConnector();
    const engine = new OkxExecutionEngine(connector); await engine.start();
    const injected = { ...plan(), confidence: 0.99, arbitraryMcpArguments: { side: 'sell' } };
    expect((await engine.submitApprovedOrder(injected)).status).toBe('ACCEPTED');
    expect(JSON.stringify(connector.calls)).not.toContain('confidence');
    expect(JSON.stringify(connector.calls)).not.toContain('arbitraryMcpArguments');
    expect(connector.calls.every(call => connector.tools.some(tool => tool.name === call.name))).toBe(true);
  });
});

describe('attached protection ownership and cleanup', () => {
  const algo = (algoId: string, ordId: string | null, instId = 'BTC-USDT') =>
    ({ instId, algoId, ordId: ordId ?? '', algoClOrdId: '', state: 'live', slTriggerPx: '97', tpTriggerPx: '107.5' });

  it('reports the attached algo IDs discovered while verifying entry protection', async () => {
    const connector = new FakeConnector();
    connector.verificationRows = [{ ...orderRow('live'), attachAlgoOrds: [{ attachAlgoId: 'algo-9', slTriggerPx: '97', tpTriggerPx: '107.5' }] }];
    connector.algoRows = [{ instId: 'BTC-USDT', algoId: 'oco-9', ordId: '', algoClOrdId: '', ordType: 'oco', side: 'sell', state: 'live', sz: '1.25', slTriggerPx: '97', tpTriggerPx: '107.5', cTime: '1000' }];
    const engine = new OkxExecutionEngine(connector); await engine.start();
    const result = await engine.submitApprovedOrder(plan());
    expect(result).toMatchObject({ status: 'ACCEPTED', protectionMode: 'EXCHANGE_SIDE', protectionVerified: true });
    expect([...(result.protectionIds ?? [])].sort()).toEqual(['algo-9', 'oco-9']);
  });

  it('cancels only protection linked to the entry and leaves unrelated algo orders untouched', async () => {
    const connector = new FakeConnector();
    connector.algoRows = [algo('algo-1', 'order1'), algo('foreign', 'someone-else'), algo('eth-algo', 'order1', 'ETH-USDT')];
    const engine = new OkxExecutionEngine(connector); await engine.start();
    expect(await engine.getPendingProtection('BTC-USDT')).toMatchObject([
      { symbol: 'BTC-USDT', algoId: 'algo-1', algoClientOrderId: null, orderId: 'order1', slTriggerPx: 97, tpTriggerPx: 107.5 },
      { symbol: 'BTC-USDT', algoId: 'foreign', algoClientOrderId: null, orderId: 'someone-else' }]);
    const result = await engine.cancelAttachedProtection({ symbol: 'BTC-USDT', entryOrderId: 'order1',
      entryClientOrderId: 'client1', protectionIds: [] });
    expect(result).toMatchObject({ status: 'CANCELLED', protectionIds: ['algo-1'] });
    const cancels = connector.calls.filter(call => call.name === 'spot_cancel_algo_order');
    expect(cancels).toEqual([{ name: 'spot_cancel_algo_order', args: { instId: 'BTC-USDT', algoId: 'algo-1' } }]);
    expect(connector.algoRows.map(row => row.algoId)).toEqual(['foreign', 'eth-algo']);
    expect(connector.calls.some(call => call.name === 'spot_place_order')).toBe(false);
  });

  it('cancels by known attached IDs, reports NONE when nothing is linked, and never retries an ambiguous cancellation', async () => {
    const connector = new FakeConnector();
    connector.algoRows = [algo('algo-2', null)];
    const engine = new OkxExecutionEngine(connector); await engine.start();
    expect((await engine.cancelAttachedProtection({ symbol: 'BTC-USDT', entryOrderId: 'order-none',
      entryClientOrderId: null, protectionIds: [] })).status).toBe('NONE');
    expect(connector.calls.filter(call => call.name === 'spot_cancel_algo_order')).toHaveLength(0);
    connector.cancelSticky = true;
    const sticky = await engine.cancelAttachedProtection({ symbol: 'BTC-USDT', entryOrderId: null,
      entryClientOrderId: null, protectionIds: ['algo-2'] });
    expect(sticky).toMatchObject({ status: 'AMBIGUOUS', protectionIds: ['algo-2'] });
    expect(connector.calls.filter(call => call.name === 'spot_cancel_algo_order')).toHaveLength(1);
    connector.cancelSticky = false;
    connector.cancelError = new Error('write lane hiccup');
    const failed = await engine.cancelAttachedProtection({ symbol: 'BTC-USDT', entryOrderId: null,
      entryClientOrderId: null, protectionIds: ['algo-2'] });
    expect(failed.status).toBe('AMBIGUOUS');
    expect(connector.calls.filter(call => call.name === 'spot_cancel_algo_order')).toHaveLength(2);
  });
});

describe('live entry attestation and tick-aligned attached payload', () => {
  it('admits a live BUY only with LIVE_ENTRY_PROTECTION_VERIFIED=true, using the same attached payload', async () => {
    const connector = new FakeConnector('live');
    connector.verificationRows = [{ ...orderRow('live'), attachAlgoOrds: [{ attachAlgoId: 'a1', slTriggerPx: '97', tpTriggerPx: '107.5' }] }];
    connector.algoRows = [{ instId: 'BTC-USDT', algoId: 'oco-a1', ordId: '', algoClOrdId: '', ordType: 'oco', side: 'sell', state: 'live', sz: '1.25', slTriggerPx: '97', tpTriggerPx: '107.5', cTime: '1000' }];
    const engine = new OkxExecutionEngine(connector, undefined, undefined, undefined, false, true);
    await engine.start();
    expect(engine.liveEntryProtectionReady()).toBe(true);
    expect(await engine.submitApprovedOrder(plan())).toMatchObject({ status: 'ACCEPTED', protectionMode: 'EXCHANGE_SIDE',
      protectionVerified: true, protectionIds: expect.arrayContaining(['a1', 'oco-a1']) });
    expect(connector.calls.find(call => call.name === 'spot_place_order')?.args).toMatchObject({
      slTriggerPx: '97', slOrdPx: '-1', tpTriggerPx: '107.5', tpOrdPx: '-1', clOrdId: 'client1' });
    expect(new OkxExecutionEngine(new FakeConnector('live')).liveEntryProtectionReady()).toBe(false);
  });

  it('aligns the take-profit trigger to the instrument tick and verifies against the same value', async () => {
    const connector = new FakeConnector();
    connector.verificationRows = [{ ...orderRow('live'), attachAlgoOrds: [{ attachAlgoId: 'a2', slTriggerPx: '97', tpTriggerPx: '107' }] }];
    connector.algoRows = [{ instId: 'BTC-USDT', algoId: 'oco-a2', ordId: '', algoClOrdId: '', ordType: 'oco', side: 'sell', state: 'live', sz: '1.25', slTriggerPx: '97', tpTriggerPx: '107', cTime: '1000' }];
    const engine = new OkxExecutionEngine(connector); await engine.start();
    const result = await engine.submitApprovedOrder({ ...plan(), tickSize: 1 });
    expect(result).toMatchObject({ status: 'ACCEPTED', protectionMode: 'EXCHANGE_SIDE', protectionVerified: true, protectionIds: expect.arrayContaining(['a2', 'oco-a2']) });
    expect(connector.calls.find(call => call.name === 'spot_place_order')?.args).toMatchObject({ tpTriggerPx: '107', slTriggerPx: '97' });
  });
});

describe('real OKX attached protection identity: parent attachAlgoId differs from the live OCO algoId', () => {
  const realPlan = (): ApprovedOrderPlan => ({ symbol: 'ETH-USDT', side: 'BUY', quantity: 0.000732,
    estimatedNotional: 0.000732 * 2539.97, referencePrice: 2539.97, tickSize: 0.01,
    protection: { symbol: 'ETH-USDT', initialStopPrice: 2489.17, stopDistanceAbsolute: 50.8,
      stopDistanceFraction: 50.8 / 2539.97, breakEvenTriggerR: 1, trailingActivationR: 1.5, takeProfitR: 2.5, protectionMode: 'CLIENT_SIDE' },
    clientOrderId: 'AURAENTRY88de408926c6b5047868cd', cycleId: 'c', decisionId: 'd' });
  const realOco = (algoId: string, overrides: Record<string, unknown> = {}) => ({ instId: 'ETH-USDT', algoId, ordId: '', algoClOrdId: '',
    ordType: 'oco', side: 'sell', state: 'live', sz: '0.000731', slTriggerPx: '2489.17', tpTriggerPx: '2666.97', cTime: '1789225410400', ...overrides });
  function realConnector() {
    const connector = new FakeConnector();
    connector.placeResponse = envelope([{ ordId: '3916574313651851264', clOrdId: 'AURAENTRY88de408926c6b5047868cd', sCode: '0' }]);
    connector.verificationRows = [{ instId: 'ETH-USDT', ordId: '3916574313651851264', clOrdId: 'AURAENTRY88de408926c6b5047868cd',
      state: 'filled', sz: '0.000732', accFillSz: '0.000732', avgPx: '2539.97', uTime: '1789225410350',
      attachAlgoOrds: [{ attachAlgoId: '3916574313628999680', slTriggerPx: '2489.17', tpTriggerPx: '2666.97', slOrdPx: '-1', tpOrdPx: '-1' }] }];
    return connector;
  }

  it('verifies through the live OCO by signature and records the ACTUAL pending algoId', async () => {
    const connector = realConnector();
    connector.algoRows = [realOco('3916574313662554112')];
    const engine = new OkxExecutionEngine(connector); await engine.start();
    const result = await engine.submitApprovedOrder(realPlan());
    expect(result).toMatchObject({ status: 'ACCEPTED', protectionMode: 'EXCHANGE_SIDE', protectionVerified: true });
    expect(result.protectionIds).toContain('3916574313662554112');
    expect(connector.calls.find(call => call.name === 'spot_place_order')?.args).toMatchObject({ slTriggerPx: '2489.17', tpTriggerPx: '2666.97' });
  });

  it('does not treat the parent attachAlgoOrds echo alone as a live protection', async () => {
    const connector = realConnector();
    const engine = new OkxExecutionEngine(connector); await engine.start();
    const result = await engine.submitApprovedOrder(realPlan());
    expect(result).toMatchObject({ status: 'ACCEPTED', protectionMode: 'CLIENT_SIDE', protectionVerified: false });
    expect(result.protectionIds).toEqual(['3916574313628999680']);
  });

  it('cancels the ACTUAL pending OCO, not the parent attachAlgoId, and leaves foreign algos alone', async () => {
    const connector = realConnector();
    connector.algoRows = [realOco('3916574313662554112'), realOco('foreign-oco', { slTriggerPx: '2400', tpTriggerPx: '2700' })];
    const engine = new OkxExecutionEngine(connector); await engine.start();
    const result = await engine.cancelAttachedProtection({ symbol: 'ETH-USDT', entryOrderId: '3916574313651851264',
      entryClientOrderId: 'AURAENTRY88de408926c6b5047868cd', protectionIds: ['3916574313628999680'],
      signature: { slTriggerPx: 2489.17, tpTriggerPx: 2666.97, quantity: 0.000731268, notBefore: 1789225410350 - 60_000 } });
    expect(result).toMatchObject({ status: 'CANCELLED', protectionIds: ['3916574313662554112'] });
    expect(connector.calls.filter(call => call.name === 'spot_cancel_algo_order').map(call => call.args))
      .toEqual([{ instId: 'ETH-USDT', algoId: '3916574313662554112' }]);
    expect(connector.algoRows.map(row => row.algoId)).toEqual(['foreign-oco']);
  });

  it('fails closed without cancelling when two live algos share the exact signature', async () => {
    const connector = realConnector();
    connector.algoRows = [realOco('oco-a'), realOco('oco-b')];
    const engine = new OkxExecutionEngine(connector); await engine.start();
    const verify = await engine.submitApprovedOrder(realPlan());
    expect(verify).toMatchObject({ protectionMode: 'CLIENT_SIDE', protectionVerified: false });
    const result = await engine.cancelAttachedProtection({ symbol: 'ETH-USDT', entryOrderId: '3916574313651851264',
      entryClientOrderId: 'AURAENTRY88de408926c6b5047868cd', protectionIds: [],
      signature: { slTriggerPx: 2489.17, tpTriggerPx: 2666.97, quantity: 0.000731268, notBefore: null } });
    expect(result.status).toBe('AMBIGUOUS');
    expect(connector.calls.some(call => call.name === 'spot_cancel_algo_order')).toBe(false);
  });

  it('exposes the authoritative order-record fill details for exact exit reconciliation', async () => {
    const connector = new FakeConnector();
    connector.lookupRows = [{ instId: 'BTC-USDT', clOrdId: 'client1', ordId: 'order1', state: 'filled', sz: '1.25', accFillSz: '1.25',
      avgPx: '100', uTime: '1000', fee: '-0.125', feeCcy: 'USDT', tradeId: '830772447', fillTime: '999' }];
    const engine = new OkxExecutionEngine(connector); await engine.start();
    const status = await engine.getOrderStatus('BTC-USDT', 'client1');
    expect(status).toMatchObject({ state: 'FILLED', filledQuantity: 1.25, averageFillPrice: 100, fee: -0.125, feeCurrency: 'USDT', tradeId: '830772447', fillTime: 999 });
  });
});

import { describe, expect, it } from 'vitest';
import { OkxExecutionEngine } from '../../src/execution/engine.js';
import { minimumDemoSmokeQuantity, roundSmokeExitDown } from '../../src/execution/smoke-size.js';
import type { DemoSmokeRequest } from '../../src/execution/types.js';
import type { OkxConnector } from '../../src/okx/connector.js';
import type { OkxToolDefinition } from '../../src/okx/types.js';

type Row = Record<string, unknown>;
const now = 1_789_213_220_000;
const envelope = (data: readonly unknown[]) => ({ endpoint: '/api/v5/demo',
  requestTime: '2026-09-12T00:00:00Z', data });
function tool(name: string, fields: string[]): OkxToolDefinition {
  return { name, description: null, inputSchema: { type: 'object', properties: Object.fromEntries(
    fields.map(field => [field, { type: 'string',
      ...(field === 'tdMode' ? { enum: ['cash'] } : {}),
      ...(field === 'side' ? { enum: ['buy', 'sell'] } : {}),
      ...(field === 'ordType' ? { enum: name === 'spot_place_algo_order'
        ? ['conditional', 'oco'] : ['market'] } : {}),
      ...(field === 'tgtCcy' ? { enum: ['base_ccy'] } : {}),
    }])) } };
}
const readTools = [tool('system_get_capabilities', []),
  tool('spot_get_order', ['instId', 'clOrdId', 'ordId']),
  tool('spot_get_orders', ['status', 'instId']),
  tool('spot_get_fills', ['instId', 'ordId', 'archive']),
  tool('spot_get_algo_orders', ['status', 'instId']),
  tool('account_get_balance', ['ccy']),
  tool('account_get_trade_fee', ['instType', 'instId'])];
const writeTools = [tool('system_get_capabilities', []),
  tool('spot_place_order', ['instId', 'tdMode', 'side', 'ordType', 'sz', 'tgtCcy', 'clOrdId']),
  tool('spot_place_algo_order', ['instId', 'tdMode', 'side', 'ordType', 'sz',
    'slTriggerPx', 'slOrdPx', 'algoClOrdId']),
  tool('spot_cancel_algo_order', ['instId', 'algoId'])];

class FakeVenue {
  eth = 3;
  btc = 2;
  usdt = 1000;
  price = 2500;
  entryOrderId = 'entry-1';
  entryFeeCurrency: 'ETH' | 'USDT' = 'USDT';
  entryAmbiguous = false;
  entryUnknown = false;
  entryRejected = false;
  entryFillOnly = false;
  entryOrderHistoryOnly = false;
  entryDirectMissing = false;
  entryFillDelayed = false;
  entryFillReadCount = 0;
  entryCreated = false;
  entryMultipleFills = false;
  entryFillNoClientId = false;
  entryFillWrongClientId = false;
  entryFillNoTradeId = false;
  entryOrderFillPxMissing = false;
  entryContradictory = false;
  exitAmbiguous = false;
  exitUnknown = false;
  protectionSupported = true;
  algoHistoryUnavailable = false;
  cancelAckMissing = false;
  algoCancelIneffective = false;
  writeServerDemo = true;
  orders = new Map<string, Row>();
  fills: Row[] = [];
  algos: Row[] = [];
  writeCalls: { name: string; args: Record<string, unknown> }[] = [];
}

class FakeLane implements OkxConnector {
  connected = false;
  readonly readOnly: boolean;
  constructor(readonly venue: FakeVenue, readonly lane: 'READ' | 'WRITE',
    readonly profile: 'demo' | 'live' = 'demo') { this.readOnly = lane === 'READ'; }
  async connect() { this.connected = true; }
  async disconnect() { this.connected = false; }
  isConnected() { return this.connected; }
  async healthCheck() { return { connected: this.connected, profile: this.profile,
    status: this.connected ? 'HEALTHY' as const : 'UNAVAILABLE' as const,
    reason: null, timestamp: now }; }
  async listTools() { return this.lane === 'READ' ? readTools :
    this.venue.protectionSupported ? writeTools : writeTools.filter(item =>
      item.name !== 'spot_place_algo_order' && item.name !== 'spot_cancel_algo_order'); }
  async callTool<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const venue = this.venue;
    if (name === 'system_get_capabilities') return { capabilities: {
      demo: this.lane === 'READ' ? this.profile === 'demo' : venue.writeServerDemo,
      readOnly: this.readOnly,
    } } as T;
    if (this.lane === 'READ') {
      if (name === 'account_get_balance') return envelope([{ totalEq: '1000', uTime: String(now), details: [
        { ccy: 'USDT', eq: String(venue.usdt), availBal: String(venue.usdt) },
        { ccy: 'BTC', eq: String(venue.btc), availBal: String(venue.btc), avgPx: '77000' },
        { ccy: 'ETH', eq: String(venue.eth), availBal: String(venue.eth), avgPx: '2500' },
      ] }]) as T;
      if (name === 'account_get_trade_fee') return envelope([{ instId: args.instId,
        maker: '-0.0008', taker: '-0.001' }]) as T;
      if (name === 'spot_get_order') return envelope([...venue.orders.values()].filter(row =>
        !(venue.entryDirectMissing && row.ordId === venue.entryOrderId) &&
        row.instId === args.instId && (row.clOrdId === args.clOrdId || row.ordId === args.ordId))) as T;
      if (name === 'spot_get_orders') return envelope([...venue.orders.values()].filter(row =>
        row.instId === args.instId && (args.status === 'history' || row.state === 'live'))) as T;
      if (name === 'spot_get_fills') {
        if (venue.entryCreated && venue.entryFillDelayed && venue.entryFillReadCount++ === 0) {
          return envelope([]) as T;
        }
        return envelope(venue.fills.filter(row =>
          row.instId === args.instId && (!args.ordId || row.ordId === args.ordId))) as T;
      }
      // Mirrors ATK: history defaults to state=effective, so cancelled rows appear only with state=canceled.
      if (name === 'spot_get_algo_orders') return envelope((args.status === 'history' && venue.algoHistoryUnavailable
        ? [] : venue.algos).filter(row =>
        row.instId === args.instId && (args.status === 'pending' ? row.state === 'live'
          : row.state === (args.state ?? 'effective')))) as T;
      throw new Error('Unexpected READ tool');
    }
    venue.writeCalls.push({ name, args });
    if (name === 'spot_place_order') {
      const side = args.side as 'buy' | 'sell';
      if (side === 'buy' && venue.entryRejected) return envelope([{ sCode: '51008',
        sMsg: 'Insufficient USDT balance', clOrdId: args.clOrdId }]) as T;
      if (side === 'buy' && venue.entryContradictory) {
        venue.eth += 0.001;
        throw new Error('Unknown entry outcome');
      }
      if (side === 'buy' && venue.entryUnknown) throw new Error('Unknown entry outcome');
      if (side === 'sell' && venue.exitUnknown) throw new Error('Unknown exit outcome');
      const quantity = Number(args.sz);
      const orderId = side === 'buy' ? venue.entryOrderId : 'exit-1';
      const feeCurrency = side === 'buy' ? venue.entryFeeCurrency : 'USDT';
      const fee = side === 'buy' && feeCurrency === 'ETH' ? -quantity * 0.001 : -0.001;
      const parts = side === 'buy' && venue.entryMultipleFills ? [quantity / 2, quantity / 2] : [quantity];
      const lastPart = parts.at(-1)!;
      const lastFee = fee * lastPart / quantity;
      const tradeId = side === 'buy' ? 'trade-buy-1' : 'trade-sell-1';
      if (!(side === 'buy' && venue.entryFillOnly)) venue.orders.set(String(args.clOrdId), {
        instId: args.instId, clOrdId: args.clOrdId, ordId: orderId,
        state: 'filled', side, sz: args.sz, accFillSz: args.sz,
        fillSz: String(lastPart), avgPx: String(venue.price),
        fillPx: side === 'buy' && venue.entryOrderFillPxMissing ? '' : String(venue.price),
        fee: String(lastFee), feeCcy: feeCurrency,
        ...(venue.entryFillNoTradeId && side === 'buy' ? { billId: 'bill-buy-1' } : { tradeId }),
        fillTime: String(now), uTime: String(now) });
      if (!(side === 'buy' && venue.entryOrderHistoryOnly)) {
        for (const [index, part] of parts.entries()) venue.fills.push({
          instId: args.instId,
          ...(side === 'buy' && venue.entryFillNoClientId ? {}
            : { clOrdId: side === 'buy' && venue.entryFillWrongClientId ? 'OTHERCLIENT' : args.clOrdId }),
          ordId: orderId, side, fillSz: String(part), fillPx: String(venue.price),
          fee: String(fee * part / quantity), feeCcy: feeCurrency,
          ...(venue.entryFillNoTradeId && side === 'buy' ? { billId: `bill-buy-${index}` } : { tradeId: `${tradeId}-${index}` }),
          fillTime: String(now + index), ts: String(now + index),
        });
      }
      if (side === 'buy') venue.entryCreated = true;
      if (side === 'buy') { venue.eth += quantity - (feeCurrency === 'ETH' ? Math.abs(fee) : 0);
        venue.usdt -= quantity * venue.price + (feeCurrency === 'USDT' ? Math.abs(fee) : 0); }
      else { venue.eth -= quantity; venue.usdt += quantity * venue.price - Math.abs(fee); }
      if ((side === 'buy' && (venue.entryAmbiguous || venue.entryFillOnly))
        || (side === 'sell' && venue.exitAmbiguous))
        throw new Error('Ambiguous MCP response after placement');
      return envelope([{ ordId: orderId, clOrdId: args.clOrdId, sCode: '0' }]) as T;
    }
    if (name === 'spot_place_algo_order') {
      venue.algos.push({ instId: args.instId, algoId: 'algo-1',
        algoClOrdId: args.algoClOrdId, sz: args.sz, state: 'live' });
      return envelope([{ algoId: 'algo-1', algoClOrdId: args.algoClOrdId, sCode: '0' }]) as T;
    }
    if (name === 'spot_cancel_algo_order') {
      const algo = venue.algos.find(row => row.algoId === args.algoId);
      if (!algo) throw new Error('Unknown protection');
      if (!venue.algoCancelIneffective) algo.state = 'canceled';
      return envelope([{ ...(venue.cancelAckMissing ? {} : { algoId: args.algoId }), sCode: '0' }]) as T;
    }
    throw new Error('Unexpected WRITE tool');
  }
}

async function setup(venue = new FakeVenue(), profile: 'demo' | 'live' = 'demo', armOff = true) {
  const read = new FakeLane(venue, 'READ', profile);
  const write = new FakeLane(venue, 'WRITE', profile);
  const engine = new OkxExecutionEngine(write, ['BTC-USDT', 'ETH-USDT'], () => now, read, armOff);
  await engine.start();
  const baseline = await engine.getStartupSnapshot();
  const token = 'abcdef0123456789abcdef';
  const meta = { symbol: 'ETH-USDT', instrumentId: 'ETH-USDT',
    minOrderSize: 0.00073, quantityStep: 0.000001, tickSize: 0.01 };
  const request: DemoSmokeRequest = { symbol: 'ETH-USDT', quantity: minimumDemoSmokeQuantity(meta, 0.001, venue.price, 1000)!,
    quantityStep: meta.quantityStep, minOrderSize: meta.minOrderSize, tickSize: meta.tickSize,
    referencePrice: venue.price, feeRate: 0.001,
    cycleId: `AURA-SMOKE-${token}C`, decisionId: `AURA-SMOKE-${token}D`,
    entryClientOrderId: `AURASMOKE${token}`, protectionClientOrderId: `AURAPROT${token}`,
    exitClientOrderId: `AURAEXIT${token}`, baseline };
  return { engine, venue, request };
}

describe('dedicated demo smoke execution with fake MCP transports', () => {
  it('parses the observed tradeId-only startup fill without a WRITE call', async () => {
    const venue = new FakeVenue();
    venue.fills.push({ instId: 'ETH-USDT', ordId: '3916317316499066880',
      clOrdId: 'AURASMOKE67112bd034b5c6a9d4152c', tradeId: '830754418',
      side: 'buy', fillSz: '0.000732', fillPx: '2533.11',
      fee: '-0.000000732', feeCcy: 'ETH', fillTime: String(now) });
    const { engine } = await setup(venue);
    const snapshot = await engine.getStartupSnapshot();
    expect(snapshot.recentFills).toMatchObject([{ symbol: 'ETH-USDT',
      fillId: '830754418', tradeId: '830754418', billId: null,
      orderId: '3916317316499066880', side: 'buy', quantity: 0.000732,
      price: 2533.11, fee: -0.000000732, feeCurrency: 'ETH' }]);
    expect(venue.writeCalls).toEqual([]);
  });

  it('rejects a startup fill with no fillId, tradeId, or billId', async () => {
    const venue = new FakeVenue();
    const { engine } = await setup(venue);
    venue.fills.push({ instId: 'ETH-USDT', ordId: 'o', side: 'buy',
      fillSz: '0.000732', fillPx: '2533.11', fee: '0', feeCcy: 'ETH',
      fillTime: String(now) });
    await expect(engine.getStartupSnapshot()).rejects.toThrow('Missing or invalid fill ID');
    expect(venue.writeCalls).toEqual([]);
  });

  it('refuses live and non-demo server sessions before any WRITE order call', async () => {
    const live = await setup(new FakeVenue(), 'live');
    expect((await live.engine.runDemoSmoke(live.request)).status).toBe('REFUSED');
    expect(live.venue.writeCalls).toEqual([]);
    const wrongServer = new FakeVenue(); wrongServer.writeServerDemo = false;
    const mismatch = await setup(wrongServer);
    expect((await mismatch.engine.runDemoSmoke(mismatch.request)).status).toBe('REFUSED');
    expect(wrongServer.writeCalls).toEqual([]);
    const armed = await setup(new FakeVenue(), 'demo', false);
    expect((await armed.engine.runDemoSmoke(armed.request)).status).toBe('REFUSED');
    expect(armed.venue.writeCalls).toEqual([]);
  });

  it('refuses the legacy hyphenated smoke ID before any WRITE order call', async () => {
    const { engine, venue, request } = await setup();
    const legacy = { ...request, entryClientOrderId: 'AURA-SMOKE-abcdef0123456789B' };
    expect((await engine.runDemoSmoke(legacy)).status).toBe('REFUSED');
    expect(venue.writeCalls).toEqual([]);
  });

  it('refuses if unrelated BTC inventory changes after the ownership baseline', async () => {
    const { engine, venue, request } = await setup();
    venue.btc += 0.01;
    expect((await engine.runDemoSmoke(request)).status).toBe('REFUSED');
    expect(venue.writeCalls).toEqual([]);
  });

  it.each(['USDT', 'ETH'] as const)('verifies %s entry fees, protection, one owned SELL, and inventory preservation', async feeCurrency => {
    const venue = new FakeVenue(); venue.entryFeeCurrency = feeCurrency;
    const { engine, request } = await setup(venue);
    const stages: string[] = [];
    const result = await engine.runDemoSmoke(request, stage => stages.push(stage.stage));
    expect(result.status).toBe('PASS');
    expect(result.protectionTest).toBe('PASS');
    expect(result.protectionId).toBe('algo-1');
    expect(result.entryFeeCurrency).toBe(feeCurrency);
    expect(result.confirmedFilledQuantity).toBe(request.quantity);
    expect(result.netOwnedBase).toBeCloseTo(request.quantity - (feeCurrency === 'ETH' ? request.quantity * 0.001 : 0));
    expect(result.entryAverageFillPrice).toBe(2500);
    expect(result.auraManagedActivePositionCount).toBe(0);
    expect(result.dustQuantity).toBeGreaterThanOrEqual(0);
    expect(result.dustQuantity).toBeLessThan(request.minOrderSize);
    expect(venue.eth).toBeCloseTo(3 + result.dustQuantity);
    expect(venue.btc).toBe(2);
    expect(venue.writeCalls.filter(call => call.name === 'spot_place_order')).toHaveLength(2);
    const ownedExit = roundSmokeExitDown(result.netOwnedBase, request.quantityStep);
    expect(venue.writeCalls.filter(call => call.name === 'spot_place_order' && call.args.side === 'sell')[0]?.args.sz)
      .toBe(String(ownedExit));
    expect(venue.writeCalls.find(call => call.name === 'spot_place_algo_order')?.args.sz)
      .toBe(String(ownedExit));
    expect(venue.writeCalls.find(call => call.name === 'spot_place_algo_order')?.args.algoClOrdId)
      .toMatch(/^AURAPROT[0-9a-f]{22}$/);
    for (const call of venue.writeCalls.filter(call => call.name === 'spot_place_order')) {
      expect(call.args.clOrdId).toMatch(/^[A-Za-z0-9]{1,32}$/);
    }
    expect(stages).toContain('PROTECTION_CANCELLED');
    expect(stages.at(-1)).toBe('PASS');
  });

  it('reconciles the real single-fill ETH evidence and sells only 0.000731 whole lots', async () => {
    const venue = new FakeVenue();
    venue.price = 2533.11;
    venue.entryOrderId = '3916317316499066880';
    venue.entryFeeCurrency = 'ETH';
    const { engine, request } = await setup(venue);
    const result = await engine.runDemoSmoke(request);
    expect(result.status).toBe('PASS');
    expect(result.confirmedFilledQuantity).toBe(0.000732);
    expect(result.entryFeeAmount).toBeCloseTo(0.000000732, 12);
    expect(result.entryFeeCurrency).toBe('ETH');
    expect(result.entryAverageFillPrice).toBe(2533.11);
    expect(result.netOwnedBase).toBeCloseTo(0.000731268, 12);
    expect(roundSmokeExitDown(result.netOwnedBase, 0.000001)).toBe(0.000731);
    const sell = venue.writeCalls.find(call => call.name === 'spot_place_order' && call.args.side === 'sell');
    expect(sell?.args.sz).toBe('0.000731');
    expect(Number(sell!.args.sz)).toBeLessThanOrEqual(result.netOwnedBase);
    expect(result.auraManagedActivePositionCount).toBe(0);
  });

  it('uses a matching filled order-history row when the fills endpoint has not indexed it', async () => {
    const venue = new FakeVenue();
    venue.entryFeeCurrency = 'ETH';
    venue.entryOrderHistoryOnly = true;
    venue.entryDirectMissing = true;
    venue.entryFillNoTradeId = true;
    venue.entryOrderFillPxMissing = true;
    const { engine, request } = await setup(venue);
    const result = await engine.runDemoSmoke(request);
    expect(result.status).toBe('PASS');
    expect(result.confirmedFilledQuantity).toBe(0.000732);
    expect(result.netOwnedBase).toBeCloseTo(0.000731268, 12);
    expect(venue.fills.filter(fill => fill.side === 'buy')).toHaveLength(0);
    expect(venue.writeCalls.filter(call => call.name === 'spot_place_order' && call.args.side === 'buy'))
      .toHaveLength(1);
  });

  it('waits for a matching fill that appears on the second bounded read', async () => {
    const venue = new FakeVenue(); venue.entryFillDelayed = true;
    const { engine, request } = await setup(venue);
    expect((await engine.runDemoSmoke(request)).status).toBe('PASS');
    expect(venue.entryFillReadCount).toBeGreaterThanOrEqual(2);
    expect(venue.writeCalls.filter(call => call.name === 'spot_place_order' && call.args.side === 'buy'))
      .toHaveLength(1);
  });

  it('matches the order ID when a fill omits client ID and aggregates partial fills', async () => {
    const venue = new FakeVenue(); venue.entryFillNoClientId = true;
    venue.entryMultipleFills = true; venue.entryFeeCurrency = 'ETH';
    const { engine, request } = await setup(venue);
    const result = await engine.runDemoSmoke(request);
    expect(result.status).toBe('PASS');
    expect(venue.fills.filter(fill => fill.side === 'buy')).toHaveLength(2);
    expect(result.confirmedFilledQuantity).toBe(0.000732);
    expect(result.entryFeeAmount).toBeCloseTo(0.000000732, 12);
    expect(result.netOwnedBase).toBeCloseTo(0.000731268, 12);
    const sell = venue.writeCalls.find(call => call.name === 'spot_place_order' && call.args.side === 'sell');
    expect(Number(sell?.args.sz)).toBeLessThanOrEqual(result.netOwnedBase);
  });

  it('matches by client ID without an order lookup and preserves confirmed fill ownership', async () => {
    const venue = new FakeVenue(); venue.entryFillOnly = true;
    venue.entryFillNoTradeId = true;
    const { engine, request } = await setup(venue);
    const result = await engine.runDemoSmoke(request);
    expect(result.status).toBe('RECONCILE_REQUIRED');
    expect(result.confirmedFilledQuantity).toBe(request.quantity);
    expect(result.auraManagedActivePositionCount).toBe(1);
    expect(venue.writeCalls.filter(call => call.name === 'spot_place_order' && call.args.side === 'sell'))
      .toHaveLength(0);
  });

  it('blocks cleanup when matching order ID carries a contradictory fill client ID', async () => {
    const venue = new FakeVenue(); venue.entryFillWrongClientId = true;
    const { engine, request } = await setup(venue);
    const result = await engine.runDemoSmoke(request);
    expect(result.status).toBe('MANUAL_RECONCILIATION_REQUIRED');
    expect(venue.writeCalls.filter(call => call.name === 'spot_place_order' && call.args.side === 'sell'))
      .toHaveLength(0);
  });

  it('reconciles an ambiguous entry and ambiguous exit without duplicate placement', async () => {
    const venue = new FakeVenue(); venue.entryAmbiguous = true; venue.exitAmbiguous = true;
    const { engine, request } = await setup(venue);
    const result = await engine.runDemoSmoke(request);
    expect(result.status).toBe('PASS');
    expect(venue.writeCalls.filter(call => call.name === 'spot_place_order' && call.args.side === 'buy')).toHaveLength(1);
    expect(venue.writeCalls.filter(call => call.name === 'spot_place_order' && call.args.side === 'sell')).toHaveLength(1);
  });

  it('classifies a missing ambiguous entry as not accepted with no phantom position or SELL', async () => {
    const venue = new FakeVenue(); venue.entryUnknown = true;
    const { engine, request } = await setup(venue);
    const result = await engine.runDemoSmoke(request);
    expect(result.status).toBe('ENTRY_NOT_ACCEPTED');
    expect(result.entryState).toBe('NOT_FOUND');
    expect(result.auraManagedActivePositionCount).toBe(0);
    expect(result.clientOrderId).toBe(request.entryClientOrderId);
    expect(venue.writeCalls.filter(call => call.name === 'spot_place_order' && call.args.side === 'buy')).toHaveLength(1);
    expect(venue.writeCalls.some(call => call.name === 'spot_place_order' && call.args.side === 'sell')).toBe(false);
    expect(venue.eth).toBe(3);
  });

  it('classifies explicit exchange rejection without provisional ownership or cleanup', async () => {
    const venue = new FakeVenue(); venue.entryRejected = true;
    const { engine, request } = await setup(venue);
    const result = await engine.runDemoSmoke(request);
    expect(result.status).toBe('REJECTED');
    expect(result.entryState).toBe('REJECTED');
    expect(result.writeDiagnostic).toMatchObject({ toolName: 'spot_place_order',
      exchangeCode: '51008', exchangeMessage: 'Insufficient USDT balance', schemaParsed: true });
    expect(result.auraManagedActivePositionCount).toBe(0);
    expect(venue.writeCalls.filter(call => call.name === 'spot_place_order')).toHaveLength(1);
  });

  it('reconciles a matching client order ID after a lost acknowledgement without another BUY', async () => {
    const venue = new FakeVenue(); venue.entryAmbiguous = true;
    const { engine, request } = await setup(venue);
    expect((await engine.runDemoSmoke(request)).status).toBe('PASS');
    expect(venue.orders.has(request.entryClientOrderId)).toBe(true);
    expect(venue.writeCalls.filter(call => call.name === 'spot_place_order' && call.args.side === 'buy'))
      .toHaveLength(1);
  });

  it('establishes ownership from a matching fill when the order lookup is absent', async () => {
    const venue = new FakeVenue(); venue.entryFillOnly = true;
    const { engine, request } = await setup(venue);
    const result = await engine.runDemoSmoke(request);
    expect(result.status).toBe('RECONCILE_REQUIRED');
    expect(result.confirmedFilledQuantity).toBe(request.quantity);
    expect(result.auraManagedActivePositionCount).toBe(1);
    expect(venue.writeCalls.filter(call => call.name === 'spot_place_order' && call.args.side === 'sell'))
      .toHaveLength(0);
  });

  it('reserves manual reconciliation for contradictory balance evidence', async () => {
    const venue = new FakeVenue(); venue.entryContradictory = true;
    const { engine, request } = await setup(venue);
    const result = await engine.runDemoSmoke(request);
    expect(result.status).toBe('MANUAL_RECONCILIATION_REQUIRED');
    expect(result.auraManagedActivePositionCount).toBe(0);
    expect(venue.writeCalls.filter(call => call.name === 'spot_place_order' && call.args.side === 'sell'))
      .toHaveLength(0);
  });

  it('accepts an exact cancel acknowledgement plus repeated empty pending queries when history omits cancellation', async () => {
    const venue = new FakeVenue(); venue.algoHistoryUnavailable = true;
    const { engine, request } = await setup(venue);
    const result = await engine.runDemoSmoke(request);
    expect(result.status).toBe('PASS');
    expect(result.protectionTest).toBe('PASS');
    expect(venue.writeCalls.filter(call => call.name === 'spot_cancel_algo_order')).toHaveLength(1);
    expect(venue.writeCalls.filter(call => call.name === 'spot_place_order' && call.args.side === 'sell'))
      .toHaveLength(1);
  });

  it('does not clean up on empty history without an exact cancel acknowledgement', async () => {
    const venue = new FakeVenue(); venue.algoHistoryUnavailable = true;
    venue.cancelAckMissing = true;
    const { engine, request } = await setup(venue);
    expect((await engine.runDemoSmoke(request)).status).toBe('MANUAL_RECONCILIATION_REQUIRED');
    expect(venue.writeCalls.filter(call => call.name === 'spot_place_order' && call.args.side === 'sell'))
      .toHaveLength(0);
  });

  it('does not clean up while the protection remains pending despite a cancel acknowledgement', async () => {
    const venue = new FakeVenue(); venue.algoHistoryUnavailable = true;
    venue.algoCancelIneffective = true;
    const { engine, request } = await setup(venue);
    expect((await engine.runDemoSmoke(request)).status).toBe('MANUAL_RECONCILIATION_REQUIRED');
    expect(venue.writeCalls.filter(call => call.name === 'spot_place_order' && call.args.side === 'sell'))
      .toHaveLength(0);
  });

  it('reports unsupported protection honestly and still cleans only smoke-owned base', async () => {
    const venue = new FakeVenue(); venue.protectionSupported = false;
    const { engine, request } = await setup(venue);
    const result = await engine.runDemoSmoke(request);
    expect(result.status).toBe('PASS');
    expect(result.protectionTest).toBe('UNAVAILABLE');
    expect(venue.writeCalls.some(call => call.name === 'spot_place_algo_order')).toBe(false);
    expect(venue.eth).toBeCloseTo(3 + result.dustQuantity);
  });

  it('stops after one ambiguous unresolved cleanup SELL and returns manual identifiers', async () => {
    const venue = new FakeVenue(); venue.exitUnknown = true;
    const { engine, request } = await setup(venue);
    const result = await engine.runDemoSmoke(request);
    expect(result.status).toBe('MANUAL_RECONCILIATION_REQUIRED');
    expect(result.clientOrderId).toBe(request.entryClientOrderId);
    expect(result.orderId).toBe('entry-1');
    expect(result.confirmedFilledQuantity).toBe(request.quantity);
    expect(venue.writeCalls.filter(call => call.name === 'spot_place_order' && call.args.side === 'sell')).toHaveLength(1);
    expect(venue.eth).toBeGreaterThan(3);
  });
});

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AgentRecoveryStore } from '../../src/agent/recovery.js';
import type { ExchangePositionSnapshot, StartupExchangeSnapshot } from '../../src/execution/types.js';
import { InMemoryPositionMonitor } from '../../src/monitor/monitor.js';
import { createOkxClientId } from '../../src/okx/client-id.js';

const holding = (symbol: string, quantity = 1): ExchangePositionSnapshot =>
  ({ symbol, quantity, averageEntryPrice: 100, updatedAt: 200 });
const plan = (symbol: string) => ({ symbol, initialStopPrice: 90,
  stopDistanceAbsolute: 10, stopDistanceFraction: 0.1, breakEvenTriggerR: 1,
  trailingActivationR: 1.5, takeProfitR: 2.5, protectionMode: 'CLIENT_SIDE' as const });
function snapshot(...positions: ExchangePositionSnapshot[]): StartupExchangeSnapshot {
  return { profile: 'live', totalEquityUsd: 10_000, positions, openOrders: [],
    balances: [{ currency: 'USDT', equity: 9_900, available: 9_900 }], recentFills: [],
    feeRates: ['BTC-USDT', 'ETH-USDT'].map(symbol => ({ symbol, makerRate: 0.001, takerRate: 0.001 })),
    orderLookupSupported: true, timestamp: 200 };
}
async function savedPosition(store: AgentRecoveryStore, symbol: string): Promise<void> {
  const monitor = new InMemoryPositionMonitor(10_000, 0);
  const plan = { symbol, initialStopPrice: 90, stopDistanceAbsolute: 10, stopDistanceFraction: 0.1,
    breakEvenTriggerR: 1, trailingActivationR: 1.5, takeProfitR: 2.5,
    protectionMode: 'CLIENT_SIDE' as const };
  expect(monitor.processFill({ symbol, clientOrderId: 'aura100_1', exchangeOrderId: 'o', fillId: 'f',
    side: 'BUY', quantity: 1, price: 100, fee: 0, timestamp: 100 },
  { allowSameSymbolIncrease: false, protectionPlan: plan, protectionMode: 'CLIENT_SIDE' }).status).toBe('APPLIED');
  const position = (await monitor.getOpenPosition())!;
  await store.save({ ...position, protection: { ...position.protection, currentStopPrice: 105 } });
}
async function withStore(run: (store: AgentRecoveryStore) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'aura-recovery-'));
  try { await run(new AgentRecoveryStore(join(directory, 'position.json'))); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

describe('AURA restart ownership classification', () => {
  it('persists and reconstructs two independently protected managed positions', async () => {
    await withStore(async store => {
      const monitor = new InMemoryPositionMonitor(10_000, 0, 10_000, 3);
      for (const [symbol, timestamp] of [['BTC-USDT', 100], ['ETH-USDT', 101]] as const) {
        const p = plan(symbol);
        expect(monitor.processFill({ symbol, clientOrderId: `aura${timestamp}_1`,
          exchangeOrderId: `order-${symbol}`, fillId: `fill-${symbol}`, side: 'BUY',
          quantity: 1, price: 100, fee: 0, timestamp },
        { allowSameSymbolIncrease: false, protectionPlan: p, protectionMode: p.protectionMode }).status).toBe('APPLIED');
      }
      await store.savePositions(await monitor.getOpenPositions());
      const exchange = snapshot(holding('BTC-USDT'), holding('ETH-USDT'));
      const context = await store.context(exchange, { 'BTC-USDT': 101, 'ETH-USDT': 102 });
      expect(context.managedPositions?.map(item => item.symbol)).toEqual(['BTC-USDT', 'ETH-USDT']);
      expect(context.unmanagedInventory).toEqual([]);
      const restored = new InMemoryPositionMonitor(10_000, 0, 10_000, 3);
      expect(restored.reconcileStartup({ ...exchange, positions: context.managedPositions! }, context).status)
        .toBe('RESTORED');
      expect((await restored.getOpenPositions()).map(item => item.protectionPlan.symbol))
        .toEqual(['BTC-USDT', 'ETH-USDT']);
    });
  });

  it.each(['BTC-USDT', 'ETH-USDT'])('restores only the checkpoint-backed %s trade', async symbol => {
    await withStore(async store => {
      await savedPosition(store, symbol);
      const context = await store.context(snapshot(holding(symbol)), { [symbol]: 101 });
      expect(context.managedPositions).toMatchObject([{ symbol, quantity: 1, averageEntryPrice: 100 }]);
      expect(context.unmanagedInventory).toEqual([]);
      expect(context.protectionPlans[symbol]?.initialStopPrice).toBe(105);
      expect(context.openedAtBySymbol[symbol]).toBe(100);
      const opposite = symbol === 'BTC-USDT' ? 'ETH-USDT' : 'BTC-USDT';
      await expect(store.context(snapshot(holding(opposite)), { [opposite]: 101 })).rejects.toThrow('mismatched');
      await store.save(null);
      const flat = await store.context(snapshot(holding(symbol)), { [symbol]: 101 });
      expect(flat.managedPositions).toEqual([]);
      expect(flat.unmanagedInventory).toMatchObject([{ symbol, quantity: 1 }]);
    });
  });

  it('treats seeded BTC and ETH spot balances without AURA evidence as unmanaged inventory', async () => {
    await withStore(async store => {
      const context = await store.context(snapshot(holding('BTC-USDT', 2), holding('ETH-USDT', 3)),
        { 'BTC-USDT': 101, 'ETH-USDT': 102 });
      expect(context.managedPositions).toEqual([]);
      expect(context.unmanagedInventory?.map(item => item.symbol)).toEqual(['BTC-USDT', 'ETH-USDT']);
    });
  });

  it('keeps a completed smoke BUY and cleanup SELL plus rounding dust out of managed positions', async () => {
    await withStore(async store => {
      const exchange = snapshot(holding('BTC-USDT', 2), holding('ETH-USDT', 1.000000268));
      exchange.recentFills = [
        { symbol: 'ETH-USDT', orderId: '3916317316499066880',
          clientOrderId: 'AURASMOKE67112bd034b5c6a9d4152c', fillId: '830754418',
          tradeId: '830754418', side: 'buy', quantity: 0.000732, price: 2533.11,
          fee: -0.000000732, feeCurrency: 'ETH', timestamp: 150 },
        { symbol: 'ETH-USDT', orderId: '3916344772480159744',
          clientOrderId: 'AURACLEANUP1789218568', fillId: '830756888',
          tradeId: '830756888', side: 'sell', quantity: 0.000731, price: 2533.11,
          fee: 0, feeCurrency: 'USDT', timestamp: 160 },
      ];
      const context = await store.context(exchange, { 'BTC-USDT': 100, 'ETH-USDT': 2533.11 });
      expect(context.managedPositions).toEqual([]);
      expect(context.unmanagedInventory).toMatchObject([
        { symbol: 'BTC-USDT', quantity: 2 },
        { symbol: 'ETH-USDT', quantity: 1.000000268 },
      ]);
    });
  });

  it('keeps checkpoint-backed ETH active while BTC and excess ETH remain unmanaged', async () => {
    await withStore(async store => {
      await savedPosition(store, 'ETH-USDT');
      const context = await store.context(snapshot(holding('BTC-USDT', 2), holding('ETH-USDT', 1.5)),
        { 'BTC-USDT': 101, 'ETH-USDT': 102 });
      expect(context.managedPositions).toMatchObject([{ symbol: 'ETH-USDT', quantity: 1 }]);
      expect(context.unmanagedInventory).toMatchObject([
        { symbol: 'BTC-USDT', quantity: 2 }, { symbol: 'ETH-USDT', quantity: 0.5, averageEntryPrice: null },
      ]);
    });
  });

  it('blocks a second AURA ownership claim instead of classifying two active trades as inventory', async () => {
    await withStore(async store => {
      await savedPosition(store, 'ETH-USDT');
      const exchange = snapshot(holding('BTC-USDT'), holding('ETH-USDT'));
      exchange.recentFills = [{ symbol: 'BTC-USDT', orderId: 'o2', clientOrderId: 'aura150_2',
        quantity: 1, price: 100, timestamp: 150 }];
      await expect(store.context(exchange, {})).rejects.toThrow('without a recovery checkpoint');
    });
  });

  it('blocks ambiguous AURA fills without a checkpoint and requires reconciliation', async () => {
    await withStore(async store => {
      const exchange = snapshot(holding('BTC-USDT'), holding('ETH-USDT'));
      exchange.recentFills = [{ symbol: 'ETH-USDT', orderId: 'o2', clientOrderId: 'aura150_2',
        quantity: 1, price: 100, timestamp: 150 }];
      await expect(store.context(exchange, {})).rejects.toThrow('reconciliation required');
    });
  });

  it.each(['ENTRY', 'EXIT'] as const)('recognizes new %s IDs as production ownership evidence', async kind => {
    await withStore(async store => {
      const exchange = snapshot(holding('ETH-USDT'));
      exchange.recentFills = [{ symbol: 'ETH-USDT', orderId: 'o2',
        clientOrderId: createOkxClientId(kind), quantity: 1, price: 100, timestamp: 150 }];
      await expect(store.context(exchange, {})).rejects.toThrow('reconciliation required');
    });
  });
});

describe('attached protection links survive the checkpoint', () => {
  it('round-trips entry order, client ID, and attached algo IDs into the startup context', async () => {
    await withStore(async store => {
      const monitor = new InMemoryPositionMonitor(10_000, 0);
      const plan = { symbol: 'BTC-USDT', initialStopPrice: 90, stopDistanceAbsolute: 10, stopDistanceFraction: 0.1,
        breakEvenTriggerR: 1, trailingActivationR: 1.5, takeProfitR: 2.5, protectionMode: 'EXCHANGE_SIDE' as const };
      const entryClientOrderId = createOkxClientId('ENTRY');
      expect(monitor.processFill({ symbol: 'BTC-USDT', clientOrderId: entryClientOrderId, exchangeOrderId: 'ord-1', fillId: 'f1',
        side: 'BUY', quantity: 1, price: 100, fee: 0, timestamp: 100 },
      { allowSameSymbolIncrease: false, protectionPlan: plan, protectionMode: 'EXCHANGE_SIDE', entryProtectionIds: ['algo-1', 'algo-2'] }).status).toBe('APPLIED');
      await store.save((await monitor.getOpenPosition())!);
      const context = await store.context(snapshot(holding('BTC-USDT')), { 'BTC-USDT': 101 });
      expect(context.exchangeLinks).toEqual({ 'BTC-USDT': { entryOrderId: 'ord-1', entryClientOrderId, attachedProtectionIds: ['algo-1', 'algo-2'] } });
      const restored = new InMemoryPositionMonitor(10_000, 0).reconcileStartup(
        { ...snapshot(holding('BTC-USDT')), positions: context.managedPositions! }, context);
      expect(restored.position).toMatchObject({ entryOrderId: 'ord-1', attachedProtectionIds: ['algo-1', 'algo-2'] });
    });
  });
});

describe('completed AURA round trips do not block restart', () => {
  const fillOf = (symbol: string, clientOrderId: string, side: 'buy' | 'sell', quantity: number, timestamp: number) =>
    ({ symbol, orderId: `o-${timestamp}`, clientOrderId, side, quantity, price: 100, timestamp });

  it('treats ENTRY buy followed by EXIT sell (fee and dust remainder) as closed inventory', async () => {
    await withStore(async store => {
      const exchange = snapshot(holding('ETH-USDT', 1.000000268));
      exchange.recentFills = [
        fillOf('ETH-USDT', createOkxClientId('ENTRY'), 'buy', 0.000732, 150),
        fillOf('ETH-USDT', createOkxClientId('EXIT'), 'sell', 0.000731, 160),
      ];
      const context = await store.context(exchange, { 'ETH-USDT': 100 });
      expect(context.managedPositions).toEqual([]);
      expect(context.unmanagedInventory).toMatchObject([{ symbol: 'ETH-USDT', quantity: 1.000000268 }]);
    });
  });

  it('treats a smoke cleanup EXIT sell without a production buy as no ownership claim', async () => {
    await withStore(async store => {
      const exchange = snapshot(holding('ETH-USDT', 1.000731804));
      exchange.recentFills = [
        fillOf('ETH-USDT', createOkxClientId('SMOKE'), 'buy', 0.000732, 150),
        fillOf('ETH-USDT', createOkxClientId('EXIT'), 'sell', 0.000731, 160),
      ];
      const context = await store.context(exchange, { 'ETH-USDT': 100 });
      expect(context.managedPositions).toEqual([]);
    });
  });

  it('still blocks when AURA bought and only partially sold without a checkpoint', async () => {
    await withStore(async store => {
      const exchange = snapshot(holding('BTC-USDT', 2));
      exchange.recentFills = [
        fillOf('BTC-USDT', createOkxClientId('ENTRY'), 'buy', 1, 150),
        fillOf('BTC-USDT', createOkxClientId('EXIT'), 'sell', 0.4, 160),
      ];
      await expect(store.context(exchange, { 'BTC-USDT': 100 })).rejects.toThrow('reconciliation required');
      exchange.recentFills = [fillOf('BTC-USDT', createOkxClientId('ENTRY'), 'buy', 1, 170)];
      await expect(store.context(exchange, { 'BTC-USDT': 100 })).rejects.toThrow('reconciliation required');
    });
  });
});

describe('stale checkpoint after an AURA exit', () => {
  it('refuses to restore a checkpointed position that AURA already sold, instead of turning inventory into a phantom position', async () => {
    await withStore(async store => {
      await savedPosition(store, 'ETH-USDT');
      const exchange = snapshot(holding('ETH-USDT', 1.000731));
      exchange.recentFills = [
        { symbol: 'ETH-USDT', orderId: 'entry', clientOrderId: createOkxClientId('ENTRY'), side: 'buy', quantity: 1, price: 100, timestamp: 100 },
        { symbol: 'ETH-USDT', orderId: 'exit', clientOrderId: createOkxClientId('EXIT'), side: 'sell', quantity: 1, price: 101, timestamp: 150 },
      ];
      await expect(store.context(exchange, { 'ETH-USDT': 101 })).rejects.toThrow('stale checkpoint');
    });
  });

  it('clears an exchange-protected checkpoint after exact stop fills leave only sub-ppm dust', async () => {
    await withStore(async store => {
      const monitor = new InMemoryPositionMonitor(10_000, 0);
      const symbol = 'XLM-USDT';
      const protection = { ...plan(symbol), protectionMode: 'EXCHANGE_SIDE' as const };
      const clientOrderId = createOkxClientId('ENTRY');
      expect(monitor.processFill({ symbol, clientOrderId, exchangeOrderId: 'entry-order', fillId: 'entry-1',
        side: 'BUY', quantity: 19.794807378, price: 0.19253, fee: 0, timestamp: 100 },
      { allowSameSymbolIncrease: false, protectionPlan: protection, protectionMode: 'EXCHANGE_SIDE',
        entryProtectionIds: ['attached-sl', 'attached-tp'] }).status).toBe('APPLIED');
      await store.save((await monitor.getOpenPosition(symbol))!);

      const exchange = snapshot(holding(symbol, 0.000000378));
      exchange.timestamp = 300;
      exchange.recentFills = [
        { symbol, orderId: 'entry-order', clientOrderId, fillId: 'buy-1', side: 'buy',
          quantity: 19.814622, price: 0.19253, fee: -0.019814622,
          feeCurrency: 'XLM', timestamp: 100 },
        { symbol, orderId: 'stop-order', clientOrderId: 'O3925642606444655616', fillId: 'sell-1',
          side: 'sell', quantity: 19.794807, price: 0.19144, fee: -0.003,
          feeCurrency: 'USDT', timestamp: 200 },
      ];
      const context = await store.context(exchange, { [symbol]: 0.19144 });
      expect(context.managedPositions).toEqual([]);
      expect(context.unmanagedInventory).toMatchObject([{ symbol, quantity: 0.000000378 }]);
      expect(await store.ownedSymbols()).toEqual([]);
      const secondStartup = await store.context(exchange, { [symbol]: 0.19144 });
      expect(secondStartup.managedPositions).toEqual([]);
      expect(secondStartup.unmanagedInventory).toMatchObject([{ symbol, quantity: 0.000000378 }]);
    });
  });

  it('recognizes an exact attached-stop round trip after its checkpoint is already absent', async () => {
    await withStore(async store => {
      const symbol = 'XLM-USDT';
      const clientOrderId = createOkxClientId('ENTRY');
      const exchange = snapshot(holding(symbol, 0.000000378));
      exchange.timestamp = 300;
      exchange.recentFills = [
        { symbol, orderId: 'entry-order', clientOrderId, side: 'buy', quantity: 19.814622,
          price: 0.19253, fee: -0.019814622, feeCurrency: 'XLM', timestamp: 100 },
        { symbol, orderId: 'stop-order', clientOrderId: 'O3925642606444655616', side: 'sell',
          quantity: 19.794807, price: 0.19144, fee: -0.003, feeCurrency: 'USDT', timestamp: 200 },
      ];
      const context = await store.context(exchange, { [symbol]: 0.19144 });
      expect(context.managedPositions).toEqual([]);
      expect(context.unmanagedInventory).toMatchObject([{ symbol, quantity: 0.000000378 }]);
    });
  });

  it('does not clear an exchange-protected checkpoint when quantity conservation is ambiguous', async () => {
    await withStore(async store => {
      const monitor = new InMemoryPositionMonitor(10_000, 0);
      const symbol = 'XLM-USDT';
      const protection = { ...plan(symbol), protectionMode: 'EXCHANGE_SIDE' as const };
      const clientOrderId = createOkxClientId('ENTRY');
      monitor.processFill({ symbol, clientOrderId, exchangeOrderId: 'entry-order', fillId: 'entry-1',
        side: 'BUY', quantity: 1, price: 0.2, fee: 0, timestamp: 100 },
      { allowSameSymbolIncrease: false, protectionPlan: protection, protectionMode: 'EXCHANGE_SIDE',
        entryProtectionIds: ['attached-sl'] });
      await store.save((await monitor.getOpenPosition(symbol))!);
      const exchange = snapshot(holding(symbol, 0.2));
      exchange.timestamp = 300;
      exchange.recentFills = [
        { symbol, orderId: 'entry-order', clientOrderId, side: 'buy', quantity: 1,
          price: 0.2, fee: 0, feeCurrency: 'XLM', timestamp: 100 },
        { symbol, orderId: 'unknown-sell', clientOrderId: null, side: 'sell', quantity: 0.7,
          price: 0.19, fee: 0, feeCurrency: 'USDT', timestamp: 200 },
      ];
      await expect(store.context(exchange, { [symbol]: 0.19 })).rejects.toThrow('mismatched');
      expect(await store.ownedSymbols()).toEqual([symbol]);
    });
  });
});

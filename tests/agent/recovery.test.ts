import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AgentRecoveryStore } from '../../src/agent/recovery.js';
import type { ExchangePositionSnapshot, StartupExchangeSnapshot } from '../../src/execution/types.js';
import { InMemoryPositionMonitor } from '../../src/monitor/monitor.js';

const holding = (symbol: string, quantity = 1): ExchangePositionSnapshot =>
  ({ symbol, quantity, averageEntryPrice: 100, updatedAt: 200 });
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
      await expect(store.context(exchange, {})).rejects.toThrow('Multiple AURA ownership claims');
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
});

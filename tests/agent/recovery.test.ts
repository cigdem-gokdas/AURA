import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AgentRecoveryStore } from '../../src/agent/recovery.js';
import type { StartupExchangeSnapshot } from '../../src/execution/types.js';
import { InMemoryPositionMonitor } from '../../src/monitor/monitor.js';

function snapshot(symbol: string): StartupExchangeSnapshot {
  return { profile: 'live', totalEquityUsd: 10_000,
    positions: [{ symbol, quantity: 1, averageEntryPrice: 100, updatedAt: 200 }], openOrders: [],
    balances: [{ currency: 'USDT', equity: 9_900, available: 9_900 }], recentFills: [],
    feeRates: [{ symbol, makerRate: 0.001, takerRate: 0.001 }],
    orderLookupSupported: true, timestamp: 200 };
}

describe('AURA restart checkpoint', () => {
  it.each(['BTC-USDT', 'ETH-USDT'])('restores an explicit %s protection context and rejects a mismatched holding', async symbol => {
    const directory = await mkdtemp(join(tmpdir(), 'aura-recovery-'));
    try {
      const store = new AgentRecoveryStore(join(directory, 'position.json'));
      const monitor = new InMemoryPositionMonitor(10_000, 0);
      const plan = { symbol, initialStopPrice: 90, stopDistanceAbsolute: 10, stopDistanceFraction: 0.1,
        breakEvenTriggerR: 1, trailingActivationR: 1.5, takeProfitR: 2.5,
        protectionMode: 'CLIENT_SIDE' as const };
      expect(monitor.processFill({ symbol, clientOrderId: 'c', exchangeOrderId: 'o', fillId: 'f',
        side: 'BUY', quantity: 1, price: 100, fee: 0, timestamp: 100 },
      { allowSameSymbolIncrease: false, protectionPlan: plan, protectionMode: 'CLIENT_SIDE' }).status).toBe('APPLIED');
      const position = (await monitor.getOpenPosition())!;
      await store.save({ ...position, protection: { ...position.protection, currentStopPrice: 105 } });
      const context = await store.context(snapshot(symbol), { [symbol]: 101 });
      expect(context.protectionPlans[symbol]?.symbol).toBe(symbol);
      expect(context.protectionPlans[symbol]?.initialStopPrice).toBe(105);
      expect(context.openedAtBySymbol[symbol]).toBe(100);
      const opposite = symbol === 'BTC-USDT' ? 'ETH-USDT' : 'BTC-USDT';
      await expect(store.context(snapshot(opposite), { [opposite]: 101 })).rejects.toThrow('mismatched');
      await store.save(null);
      await expect(store.context(snapshot(symbol), { [symbol]: 101 })).rejects.toThrow('Missing');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});

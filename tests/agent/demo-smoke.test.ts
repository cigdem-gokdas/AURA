import { describe, expect, it, vi } from 'vitest';
import { minimumDemoSmokeQuantity, roundSmokeExitDown } from '../../src/execution/smoke-size.js';
import { selectDemoSmokeMarket } from '../../src/agent/demo-smoke.js';
import type { MarketAdapter } from '../../src/market/types.js';

const now = 1_789_213_220_000;
function market(ethSpread = 0.01, ethAge = 100, btcSpread = 100): MarketAdapter {
  return {
    getInstrumentMeta: vi.fn(async symbol => ({ symbol, instrumentId: symbol, state: 'live',
      minOrderSize: symbol === 'ETH-USDT' ? 0.00073 : 0.00001,
      quantityStep: symbol === 'ETH-USDT' ? 0.000001 : 0.00000001, tickSize: 0.01 })),
    getTicker: vi.fn(async symbol => ({ symbol, bid: 2500, ask: 2500.01,
      last: 2500, timestamp: now - 100 })),
    getOrderBook: vi.fn(async symbol => ({ symbol, timestamp: now - (symbol === 'ETH-USDT' ? ethAge : 100),
      bids: [{ price: symbol === 'ETH-USDT' ? 2500 : 77_000, size: 1 }],
      asks: [{ price: symbol === 'ETH-USDT' ? 2500 + ethSpread : 77_000 + btcSpread, size: 1 }] })),
    getSpotFeeRate: vi.fn(async symbol => ({ symbol, makerRate: -0.0008, takerRate: -0.001 })),
    getCandles: vi.fn(async () => []), getTradingBalanceSnapshot: vi.fn(async () => {
      throw new Error('unused');
    }),
    getOpenSpotOrders: vi.fn(async () => []), getRecentSpotFills: vi.fn(async () => []),
    checkConnectorAvailable: vi.fn(async () => true), checkMarketReachable: vi.fn(async () => true),
  };
}

describe('demo smoke market selection and size', () => {
  it('selects fresh, tight ETH ahead of wide BTC without strategy inputs', async () => {
    const selected = await selectDemoSmokeMarket(['BTC-USDT', 'ETH-USDT'], market(),
      1000, 10_000, 5, () => now);
    expect(selected).toMatchObject({ symbol: 'ETH-USDT', quantity: 0.000732,
      minOrderSize: 0.00073, quantityStep: 0.000001 });
    expect(selected!.approximateNotional).toBeCloseTo(1.83000732);
  });

  it('requires freshness and configured spread for every fallback symbol', async () => {
    expect((await selectDemoSmokeMarket(['BTC-USDT', 'ETH-USDT'], market(0.01, 10_001, 0.01),
      1000, 10_000, 5, () => now))?.symbol).toBe('BTC-USDT');
    expect(await selectDemoSmokeMarket(['BTC-USDT', 'ETH-USDT'], market(0.01, 10_001, 100),
      1000, 10_000, 5, () => now)).toBeNull();
    expect(await selectDemoSmokeMarket(['ETH-USDT'], market(), 1000, 10_000, null, () => now)).toBeNull();
  });

  it('uses only the minimum whole lots needed to survive base-denominated entry and exit fees', () => {
    const meta = { symbol: 'ETH-USDT', instrumentId: 'ETH-USDT', minOrderSize: 0.00073,
      quantityStep: 0.000001, tickSize: 0.01 };
    const quantity = minimumDemoSmokeQuantity(meta, 0.001, 2500.01, 1000);
    expect(quantity).toBe(0.000732);
    const netBase = quantity! * (1 - 0.001);
    expect(roundSmokeExitDown(netBase, meta.quantityStep)).toBe(0.000731);
    expect(minimumDemoSmokeQuantity(meta, 0.001, 2500.01, 1)).toBeNull();
    expect(roundSmokeExitDown(0.000729, meta.quantityStep)).toBeLessThan(meta.minOrderSize);
  });
});

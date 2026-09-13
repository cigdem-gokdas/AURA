import { describe, expect, it } from 'vitest';
import { selectLiquidUniverse } from '../../src/market/universe.js';

const now = 1_800_000_000_000;
const tickers = [
  { symbol: 'BTC-USDT', quoteVolume24h: 500_000_000, timestamp: now },
  { symbol: 'ETH-USDT', quoteVolume24h: 300_000_000, timestamp: now },
  { symbol: 'SOL-USDT', quoteVolume24h: 90_000_000, timestamp: now },
  { symbol: 'MEME-USDT', quoteVolume24h: 9_000, timestamp: now },
  { symbol: 'MICRO-USDT', quoteVolume24h: 500, timestamp: now },
  { symbol: 'DELIST-USDT', quoteVolume24h: 600_000_000, timestamp: now },
  { symbol: 'STALE-USDT', quoteVolume24h: 700_000_000, timestamp: now - 20_000 },
  { symbol: 'BTC-USDC', quoteVolume24h: 800_000_000, timestamp: now },
];
const instruments = tickers.map(item => ({ symbol: item.symbol,
  state: item.symbol === 'DELIST-USDT' ? 'suspend' : 'live' }));

describe('daily liquid universe', () => {
  it('ranks fresh live USDT pairs by quote volume and excludes illiquid fixtures', () => {
    const result = selectLiquidUniverse(tickers, instruments, 12, 10_000_000, now, 10_000);
    expect(result.selected.map(item => item.symbol)).toEqual(['BTC-USDT', 'ETH-USDT', 'SOL-USDT']);
    expect(result.excludedForLiquidity).toBe(2);
    expect(result.excludedForStatus).toBe(1);
    expect(result.excludedForStaleness).toBe(1);
    expect(result.minimumQuoteVolume24h).toBe(10_000_000);
  });

  it('does not fill top-N slots with subthreshold markets', () => {
    const result = selectLiquidUniverse(tickers, instruments, 5, 100_000_000, now, 10_000);
    expect(result.selected.map(item => item.symbol)).toEqual(['BTC-USDT', 'ETH-USDT']);
    expect(result.selected).toHaveLength(2);
  });

  it('fails closed on duplicate ticker identities', () => {
    expect(() => selectLiquidUniverse([...tickers, tickers[0]!], instruments, 12,
      10_000_000, now, 10_000)).toThrow('Duplicate ticker');
  });
});

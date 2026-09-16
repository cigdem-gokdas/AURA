import type { SpotInstrumentListing, SpotTicker24h } from './types.js';

export interface UniverseSelection {
  selected: readonly { symbol: string; quoteVolume24h: number }[];
  minimumQuoteVolume24h: number;
  excludedForLiquidity: number;
  excludedForStatus: number;
  excludedForStaleness: number;
  excludedStablecoinPairs: number;
  evaluatedAt: number;
}

/** Pure selection. An absent/invalid quote-volume or stale ticker is never eligible. */
export function selectLiquidUniverse(tickers: readonly SpotTicker24h[],
  instruments: readonly SpotInstrumentListing[], topN: number, minimumQuoteVolume24h: number,
  evaluatedAt: number, maxDataAgeMs: number): UniverseSelection {
  if (!Number.isSafeInteger(topN) || topN < 1 || !Number.isFinite(minimumQuoteVolume24h)
    || minimumQuoteVolume24h <= 0 || !Number.isSafeInteger(evaluatedAt) || evaluatedAt < 0
    || !Number.isFinite(maxDataAgeMs) || maxDataAgeMs <= 0) throw new RangeError('Invalid universe policy');
  const listed = new Map(instruments.map(item => [item.symbol, item.state]));
  const seen = new Set<string>();
  const eligible: { symbol: string; quoteVolume24h: number }[] = [];
  const stablecoinBases = new Set(['USDC', 'DAI', 'FDUSD', 'TUSD', 'USDP', 'PYUSD', 'USDG', 'USDE', 'USDS']);
  let excludedForLiquidity = 0, excludedForStatus = 0, excludedForStaleness = 0, excludedStablecoinPairs = 0;
  for (const ticker of tickers) {
    if (!/^[A-Z0-9]+-USDT$/.test(ticker.symbol)) continue;
    if (seen.has(ticker.symbol)) throw new Error(`Duplicate ticker ${ticker.symbol}`);
    seen.add(ticker.symbol);
    if (stablecoinBases.has(ticker.symbol.split('-')[0]!)) { excludedStablecoinPairs++; continue; }
    if (listed.get(ticker.symbol) !== 'live') { excludedForStatus++; continue; }
    if (!Number.isSafeInteger(ticker.timestamp) || ticker.timestamp > evaluatedAt
      || evaluatedAt - ticker.timestamp > maxDataAgeMs) { excludedForStaleness++; continue; }
    if (!Number.isFinite(ticker.quoteVolume24h) || ticker.quoteVolume24h < minimumQuoteVolume24h) {
      excludedForLiquidity++; continue;
    }
    eligible.push({ symbol: ticker.symbol, quoteVolume24h: ticker.quoteVolume24h });
  }
  eligible.sort((a,b) => b.quoteVolume24h - a.quoteVolume24h || a.symbol.localeCompare(b.symbol));
  return { selected: eligible.slice(0,topN), minimumQuoteVolume24h,
    excludedForLiquidity, excludedForStatus, excludedForStaleness, excludedStablecoinPairs, evaluatedAt };
}

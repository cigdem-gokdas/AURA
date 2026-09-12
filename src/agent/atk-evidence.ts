import type { FeatureSnapshot } from '../features/types.js';
import type { OkxConnector } from '../okx/connector.js';

export interface AtkIndicatorCrossCheck {
  symbol: string;
  indicator: 'EMA9' | 'ATR14' | 'ADX14';
  localValue: number;
  atkValue: number | null;
  difference: number | null;
  status: 'MATCH' | 'MINOR_DIVERGENCE' | 'LARGE_DIVERGENCE' | 'UNAVAILABLE';
}

export interface AtkCrossMarketContext {
  symbols: readonly [string, string];
  status: 'AVAILABLE' | 'UNAVAILABLE';
  spread: number | null;
  timestamp: number;
}

export interface AtkContextPulse {
  timestamp: number;
  newsShock: 'NONE' | 'WATCH' | 'HIGH' | 'UNAVAILABLE';
  sentiment: 'BEARISH' | 'NEUTRAL' | 'BULLISH' | 'UNAVAILABLE';
  macroEventSoon: boolean | null;
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
function numericEvidence(value: unknown, depth = 0): number | null {
  if (depth > 5) return null;
  if (finite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  if (Array.isArray(value)) return value.length ? numericEvidence(value[0], depth + 1) : null;
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  for (const key of ['value', 'latest', 'result', 'ema', 'atr', 'adx', 'spread', 'spreadPct', 'data']) {
    if (key in row) { const found = numericEvidence(row[key], depth + 1); if (found !== null) return found; }
  }
  return null;
}

export function compareIndicator(symbol: string, indicator: AtkIndicatorCrossCheck['indicator'],
  localValue: number, atkValue: number | null): AtkIndicatorCrossCheck {
  if (!finite(localValue) || !finite(atkValue)) return { symbol, indicator, localValue,
    atkValue: null, difference: null, status: 'UNAVAILABLE' };
  const difference = Math.abs(localValue - atkValue);
  const relative = difference / Math.max(Math.abs(localValue), 1);
  return { symbol, indicator, localValue, atkValue, difference,
    status: relative <= 0.005 ? 'MATCH' : relative <= 0.02 ? 'MINOR_DIVERGENCE' : 'LARGE_DIVERGENCE' };
}

async function bounded<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Optional ATK evidence timeout')), milliseconds);
  })]); }
  finally { if (timer) clearTimeout(timer); }
}

/** Optional independent evidence; no strategy/risk threshold is changed. */
export async function crossCheckIndicators(connector: OkxConnector, feature: FeatureSnapshot,
  timeoutMs = 1_000): Promise<AtkIndicatorCrossCheck[]> {
  const probes = [
    { indicator: 'EMA9' as const, atk: 'ema', params: [9], local: feature.emaFast },
    { indicator: 'ATR14' as const, atk: 'atr', params: [14], local: feature.atr },
    { indicator: 'ADX14' as const, atk: 'adx', params: [14], local: feature.adx },
  ];
  if (!connector.getCapabilities?.().has('MARKET_INDICATOR'))
    return probes.map(probe => compareIndicator(feature.symbol, probe.indicator, probe.local, null));
  return Promise.all(probes.map(async probe => {
    try {
      const name = connector.getCapabilities!().resolve('MARKET_INDICATOR')!;
      const result = await bounded(connector.callTool<unknown>(name, {
        instId: feature.symbol, indicator: probe.atk, bar: '3m', params: probe.params,
      }), timeoutMs);
      return compareIndicator(feature.symbol, probe.indicator, probe.local, numericEvidence(result));
    } catch { return compareIndicator(feature.symbol, probe.indicator, probe.local, null); }
  }));
}

export async function fetchPairEvidence(connector: OkxConnector, selected: string, other: string,
  now: number, timeoutMs = 1_000): Promise<AtkCrossMarketContext> {
  const unavailable: AtkCrossMarketContext = { symbols: [selected, other], status: 'UNAVAILABLE', spread: null, timestamp: now };
  const name = connector.getCapabilities?.().resolve('MARKET_PAIR_SPREAD');
  if (!name) return unavailable;
  try {
    const result = await bounded(connector.callTool<unknown>(name,
      { instIdA: selected, instIdB: other, bar: '5m' }), timeoutMs);
    const spread = numericEvidence(result);
    return spread === null ? unavailable : { symbols: [selected, other], status: 'AVAILABLE', spread, timestamp: now };
  } catch { return unavailable; }
}

/** Cached read-only news context; unavailable data never changes a decision. */
export class ContextPulseCache {
  private current: AtkContextPulse | null = null;
  constructor(private readonly enabled: boolean, private readonly intervalMs = 900_000) {}

  async get(connector: OkxConnector, symbols: readonly string[], now: number): Promise<AtkContextPulse | null> {
    if (!this.enabled) return null;
    if (this.current && now - this.current.timestamp < this.intervalMs) return { ...this.current };
    const unavailable: AtkContextPulse = { timestamp: now, newsShock: 'UNAVAILABLE',
      sentiment: 'UNAVAILABLE', macroEventSoon: null };
    const registry = connector.getCapabilities?.();
    if (!registry?.has('NEWS_LATEST') && !registry?.has('NEWS_SENTIMENT') && !registry?.has('NEWS_CALENDAR')) {
      this.current = unavailable; return { ...unavailable };
    }
    const coins = symbols.map(symbol => symbol.split('-')[0]).join(',');
    let newsShock: AtkContextPulse['newsShock'] = 'UNAVAILABLE';
    let sentiment: AtkContextPulse['sentiment'] = 'UNAVAILABLE';
    let macroEventSoon: boolean | null = null;
    try {
      const name = registry.resolve('NEWS_LATEST');
      if (name) {
        const result = await bounded(connector.callTool<unknown>(name,
          { coins, importance: 'high', detailLvl: 'brief', limit: 5 }), 1_000);
        const rows = (result as { data?: unknown })?.data;
        if (Array.isArray(rows)) newsShock = rows.length > 0 ? 'WATCH' : 'NONE';
      }
    } catch { /* Optional source. */ }
    try {
      const name = registry.resolve('NEWS_SENTIMENT');
      if (name) {
        const result = await bounded(connector.callTool<unknown>(name, { coins, period: '24h' }), 1_000);
        const score = numericEvidence(result);
        if (score !== null && score >= 0 && score <= 1)
          sentiment = score > 0.6 ? 'BULLISH' : score < 0.4 ? 'BEARISH' : 'NEUTRAL';
      }
    } catch { /* Optional source. */ }
    try {
      const name = registry.resolve('NEWS_CALENDAR');
      if (name) {
        const result = await bounded(connector.callTool<unknown>(name,
          { importance: '3', before: String(now), after: String(now + 3_600_000), limit: 10 }), 1_000);
        const rows = (result as { data?: unknown })?.data;
        if (Array.isArray(rows)) macroEventSoon = rows.length > 0;
      }
    } catch { /* Optional source. */ }
    this.current = { timestamp: now, newsShock, sentiment, macroEventSoon };
    return { ...this.current };
  }
}

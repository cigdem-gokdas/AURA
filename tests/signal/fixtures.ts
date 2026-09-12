import type { FeatureSnapshot } from '../../src/features/types.js';
import type { RegimeDecision, MarketRegime } from '../../src/regime/types.js';
import type { CostContext, PositionContext } from '../../src/signal/types.js';

export function features(
  symbol: string,
  overrides: Partial<FeatureSnapshot> = {},
): FeatureSnapshot {
  return {
    symbol,
    timestamp: 1_000_000,
    close: 100,
    bestBid: 99,
    bestAsk: 101,
    midPrice: 100,
    emaFast: 102,
    emaSlow: 100,
    adx: 30,
    atr: 2,
    atrPct: 0.02,
    atrPctPercentile: 0.5,
    volume: 150,
    volumeSma20: 100,
    return5: 0.01,
    zScore20: -1.5,
    obiTop5: 0,
    spreadBps: 2,
    microprice: 100,
    micropriceLeanBps: 0,
    dataAgeMs: 0,
    ...overrides,
  };
}

export function regime(
  symbol: string,
  stableRegime: MarketRegime = 'TRENDING_UP',
): RegimeDecision {
  return {
    symbol,
    stableRegime,
    rawProposedRegime: stableRegime,
    transitioned: false,
    reason: 'test fixture',
  };
}

export const flat: PositionContext = { openLong: null };
export const costs: CostContext = {
  feeBpsPerSide: 2,
  estimatedSlippageBpsPerSide: 1,
};

export type MarketRegime =
  'TRENDING_UP' | 'TRENDING_DOWN' | 'RANGE' | 'HIGH_VOLATILITY' | 'UNCERTAIN';

export interface RegimeDecision {
  symbol: string;
  stableRegime: MarketRegime;
  rawProposedRegime: MarketRegime;
  transitioned: boolean;
  reason: string;
}

export type MarketRegime =
  'TRENDING_UP' | 'TRENDING_DOWN' | 'RANGE' | 'HIGH_VOLATILITY' | 'UNCERTAIN';

export interface RegimeDecision {
  symbol: string;
  stableRegime: MarketRegime;
  rawProposedRegime: MarketRegime;
  transitioned: boolean;
  reason: string;
}

/** The caller owns one independent value per symbol. */
export interface RegimeHysteresisState {
  symbol: string;
  stableRegime: MarketRegime;
  pendingRegime: MarketRegime | null;
  pendingCount: 0 | 1;
}

export interface RegimeTransition {
  decision: RegimeDecision;
  nextState: RegimeHysteresisState;
}

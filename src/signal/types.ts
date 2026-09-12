import type { MarketRegime } from '../regime/types.js';

export type SignalAction = 'BUY' | 'SELL' | 'HOLD';
export type SignalIntent = 'OPEN_LONG' | 'CLOSE_LONG' | 'NONE';
export type SetupType =
  'TREND_CONTINUATION' | 'RANGE_MEAN_REVERSION' | 'DETERMINISTIC_EXIT' | 'NONE';

export interface OpportunityScoreBreakdown {
  regimeStructure: number;
  momentumOrReversion: number;
  volumeQuality: number;
  orderBookImbalance: number;
  micropriceQuality: number;
  spreadQuality: number;
  dataQuality: number;
  total: number;
}

export interface CandidateSignal {
  symbol: string;
  action: SignalAction;
  intent: SignalIntent;
  setupType: SetupType;
  regime: MarketRegime;
  opportunityScore: number;
  scoreBreakdown: OpportunityScoreBreakdown;
  estimatedMoveBps: number;
  estimatedRoundTripCostBps: number;
  edgeToCostRatio: number;
  clearsEstimatedCosts: boolean;
  bullEvidence: readonly string[];
  bearEvidence: readonly string[];
  reasons: readonly string[];
  timestamp: number;
}

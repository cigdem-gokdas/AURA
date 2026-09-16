import type { MarketRegime } from '../regime/types.js';

export interface PositionContext {
  openLong: { symbol: string; quantity: number } | null;
}

export interface CostContext {
  feeBpsPerSide: number;
  estimatedSlippageBpsPerSide: number;
}

export interface SignalConfig {
  opportunityScoreThreshold: number;
  minEdgeCostRatio: number;
  maxDataAgeMs: number;
  initialStopAtrMultiplier: number;
  takeProfitR: number;
}

export type SignalRejectionCategory =
  | 'NO_SETUP'
  | 'ALREADY_LONG'
  | 'ADVERSE_MICROSTRUCTURE'
  | 'COST_GATE'
  | 'SCORE_GATE';

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
  rejectionCategories: readonly SignalRejectionCategory[];
  timestamp: number;
}

export interface SignalCalibrationSummary {
  symbol: string | null;
  evaluated: number;
  buyProposals: number;
  sellProposals: number;
  holdCount: number;
  /** Sorted samples retain the full empirical distributions. */
  oqsDistribution: readonly number[];
  edgeCostDistribution: readonly number[];
  rejectionHistogram: Readonly<Record<SignalRejectionCategory, number>>;
  adverseMicrostructureRejects: number;
  costGateRejects: number;
  scoreGateRejects: number;
  eligibleEntries: number;
}

export interface SignalCalibrationDiagnostics {
  combined: SignalCalibrationSummary;
  bySymbol: Readonly<Record<string, SignalCalibrationSummary>>;
}

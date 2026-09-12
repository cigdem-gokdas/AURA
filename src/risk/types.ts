import type { CandidateSignal } from '../signal/types.js';

export type RiskMode = 'NORMAL' | 'CAUTION' | 'DEFENSIVE' | 'LOCKDOWN';
export type ProtectionMode = 'EXCHANGE_SIDE' | 'CLIENT_SIDE' | 'UNAVAILABLE';

export interface RiskConfig {
  /** The initial policy allows one position across all tracked symbols. */
  maxConcurrentPositions: number;
  maxTotalExposurePct: number;
  riskPerTradePct: number;
  maxRiskPerTradePct: number;
  maxPositionPct: number;
  softDrawdownPct: number;
  defensiveDrawdownPct: number;
  hardDailyLossPct: number;
  hardPeakDrawdownPct: number;
  consecutiveLossPauseMinutes: number;
  maxDataAgeMs: number;
  maxSpreadBps: number | null;
  maxAtrPercentile: number;
  opportunityScoreThreshold: number;
  minEdgeCostRatio: number;
  initialStopAtrMultiplier: number;
  breakEvenTriggerR: number;
  trailingActivationR: number;
  takeProfitR: number;
}

export interface RiskOpenPosition {
  symbol: string;
  quantity: number;
  notional: number;
  exposurePct: number;
}

export interface RiskAccountState {
  equity: number;
  availableQuoteBalance: number;
  dayStartEquity: number;
  peakEquity: number;
  consecutiveLosses: number;
  /** Includes positions from every tracked symbol, not only the candidate market. */
  openPositions: readonly RiskOpenPosition[];
  timestamp: number;
}

export interface RiskMarketState {
  symbol: string;
  referencePrice: number;
  spreadBps: number;
  atr: number;
  atrPctPercentile: number;
  dataAgeMs: number;
  timestamp: number;
}

export interface RiskDecision {
  approved: boolean;
  mode: RiskMode;
  reason: string;
  rejectionCategory: string | null;
}

export interface ProtectionPlan {
  initialStopPrice: number;
  stopDistanceFraction: number;
  stopDistanceAbsolute: number;
  breakEvenTriggerR: number;
  trailingActivationR: number;
  takeProfitR: number;
  protectionMode: ProtectionMode;
}

export interface PreTradeRiskInput {
  candidate: CandidateSignal;
  account: RiskAccountState;
  market: RiskMarketState;
  config: RiskConfig;
  timestamp: number;
}

export interface ApprovedOrderPlan {
  symbol: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  estimatedNotional: number;
  referencePrice: number;
  protection: ProtectionPlan;
  cycleId: string;
  decisionId: string;
}

export type RiskGateResult =
  | { decision: RiskDecision & { approved: true }; plan: ApprovedOrderPlan }
  | { decision: RiskDecision & { approved: false }; plan?: never };

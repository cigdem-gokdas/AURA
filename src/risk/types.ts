import type { CandidateSignal } from '../signal/types.js';
import type { LlmDecisionResult } from '../llm/types.js';

export type RiskMode = 'NORMAL' | 'CAUTION' | 'DEFENSIVE' | 'LOCKDOWN';
export type ProtectionMode = 'EXCHANGE_SIDE' | 'CLIENT_SIDE' | 'UNAVAILABLE';

export interface RiskConfig {
  /** Maximum number of independently protected AURA-managed spot positions. */
  maxConcurrentPositions: number;
  minTradeNotionalUsd: number;
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
  /** Timestamp of the most recent loss; required while a loss pause is active. */
  lastLossTimestamp: number | null;
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
  symbol: string;
  initialStopPrice: number;
  stopDistanceFraction: number;
  stopDistanceAbsolute: number;
  breakEvenTriggerR: number;
  trailingActivationR: number;
  takeProfitR: number;
  protectionMode: ProtectionMode;
}

export interface PreTradeRiskInput {
  candidate: CandidateSignal | null;
  account: RiskAccountState;
  market: RiskMarketState;
  config: RiskConfig;
  timestamp: number;
  /** Revalidated at the risk boundary, even if the adapter already parsed it. */
  llmResult: LlmDecisionResult | unknown;
  clientOrderId: string;
  knownClientOrderIds: readonly string[];
  cycleId: string;
  decisionId: string;
  killSwitchActive: boolean;
  cooldownUntil: number | null;
  /** Optional execution request; if supplied, it must not exceed deterministic sizing. */
  requestedNotional?: number;
  /** Exchange lot increment for validating the smallest round-up above the floor. */
  quantityStep?: number;
  protectionMode: ProtectionMode;
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
  clientOrderId: string;
  /** Instrument tick size, supplied by the agent so exchange trigger prices can be aligned. Formatting only. */
  tickSize?: number;
}

export type RiskGateName =
  | 'CONFIG_VALID' | 'INPUT_VALID' | 'DATA_FRESH' | 'CANDIDATE_EXISTS'
  | 'OPPORTUNITY_SCORE' | 'EDGE_COST' | 'LLM_REACHABLE' | 'LLM_SCHEMA'
  | 'LLM_AGREE' | 'LLM_RISK' | 'SPREAD' | 'VOLATILITY' | 'COOLDOWN'
  | 'SINGLE_POSITION_CAP' | 'CROSS_SYMBOL_POSITION_CAP' | 'TOTAL_EXPOSURE_CAP'
  | 'DAILY_LOSS' | 'PEAK_DRAWDOWN' | 'SYMBOL_MATCH' | 'NO_AVERAGE_DOWN'
  | 'AVAILABLE_BALANCE' | 'PROTECTION_VALID' | 'DUPLICATE_CLIENT_ORDER_ID'
  | 'KILL_SWITCH' | 'RISK_MODE' | 'MIN_TRADE_NOTIONAL';

export interface RiskGate {
  name: RiskGateName;
  status: 'PASS' | 'FAIL';
  reason: string;
}

export interface RiskCertificate {
  requestedSymbol: string;
  existingOpenPositionSymbols: readonly string[];
  gates: readonly RiskGate[];
  verdict: 'ALLOW' | 'REJECT';
  riskMode: RiskMode;
  calculatedNotional: number | null;
  protectionPlan: ProtectionPlan | null;
}

export type RiskGateResult =
  | { decision: RiskDecision & { approved: true }; plan: ApprovedOrderPlan; certificate: RiskCertificate }
  | { decision: RiskDecision & { approved: false }; plan?: never; certificate: RiskCertificate };

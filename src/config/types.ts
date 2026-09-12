import type { MarketProfile } from '../market/types.js';

/** Values after future environment parsing. SYMBOLS will be comma-separated in .env. */
export interface RuntimeConfig {
  okxProfile: MarketProfile;
  okxAuthMode: string;
  okxLiveProfile: string | null;
  okxDemoProfile: string | null;
  symbols: string[];
  /** One position across the entire tracked universe in the initial configuration. */
  maxConcurrentPositions: number;
  maxTotalExposurePct: number;
  liveTradingArmed: boolean;
  primaryBar: string;
  safetyLoopMs: number;
  llmProvider: string;
  llmModel: string;
  openaiApiKey: string | null;
  llmTimeoutMs: number;
  llmMaxOutputTokens: number;
  llmMaxCallsPerHour: number;
  llmMaxCallsPerDay: number;
  llmMaxDailyCostUsd: number;
  llmInputUsdPerMtok: number;
  llmOutputUsdPerMtok: number;
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

import type { RiskConfig } from './types.js';

function envNumber(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const value = env[key];
  return value === undefined || value.trim() === '' ? fallback : Number(value);
}

/** Defaults mirror the risk ticket; validation remains the entry engine's responsibility. */
export function riskConfigFromEnv(env: NodeJS.ProcessEnv = process.env): RiskConfig {
  const spread = env.MAX_SPREAD_BPS;
  return {
    maxConcurrentPositions: envNumber(env, 'MAX_CONCURRENT_POSITIONS', 1),
    maxTotalExposurePct: envNumber(env, 'MAX_TOTAL_EXPOSURE_PCT', 0.25),
    riskPerTradePct: envNumber(env, 'RISK_PER_TRADE_PCT', 0.005),
    maxRiskPerTradePct: envNumber(env, 'MAX_RISK_PER_TRADE_PCT', 0.0075),
    maxPositionPct: envNumber(env, 'MAX_POSITION_PCT', 0.25),
    softDrawdownPct: envNumber(env, 'SOFT_DRAWDOWN_PCT', 0.01),
    defensiveDrawdownPct: envNumber(env, 'DEFENSIVE_DRAWDOWN_PCT', 0.015),
    hardDailyLossPct: envNumber(env, 'HARD_DAILY_LOSS_PCT', 0.03),
    hardPeakDrawdownPct: envNumber(env, 'HARD_PEAK_DRAWDOWN_PCT', 0.04),
    consecutiveLossPauseMinutes: envNumber(env, 'CONSECUTIVE_LOSS_PAUSE_MINUTES', 20),
    maxDataAgeMs: envNumber(env, 'MAX_DATA_AGE_MS', 10_000),
    maxSpreadBps: spread === undefined || spread.trim() === '' ? null : Number(spread),
    maxAtrPercentile: envNumber(env, 'MAX_ATR_PERCENTILE', 0.95),
    opportunityScoreThreshold: envNumber(env, 'OPPORTUNITY_SCORE_THRESHOLD', 65),
    minEdgeCostRatio: envNumber(env, 'MIN_EDGE_COST_RATIO', 1.8),
    initialStopAtrMultiplier: envNumber(env, 'INITIAL_STOP_ATR_MULTIPLIER', 1.5),
    breakEvenTriggerR: envNumber(env, 'BREAK_EVEN_TRIGGER_R', 1),
    trailingActivationR: envNumber(env, 'TRAILING_ACTIVATION_R', 1.5),
    takeProfitR: envNumber(env, 'TAKE_PROFIT_R', 2.5),
  };
}

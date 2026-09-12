import type { FeatureSnapshot } from '../features/types.js';
import type { RegimeDecision } from '../regime/types.js';
import type {
  CandidateSignal,
  CostContext,
  OpportunityScoreBreakdown,
  PositionContext,
  SetupType,
  SignalConfig,
  SignalRejectionCategory,
} from './types.js';

export const DEFAULT_SIGNAL_CONFIG: Readonly<SignalConfig> = Object.freeze({
  opportunityScoreThreshold: 65,
  minEdgeCostRatio: 1.8,
  maxDataAgeMs: 10_000,
});

export class SignalGenerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SignalGenerationError';
  }
}

function requireCondition(
  condition: unknown,
  message: string,
): asserts condition {
  if (!condition) throw new SignalGenerationError(message);
}

function finite(value: number, label: string, minimum = -Infinity): number {
  requireCondition(
    Number.isFinite(value) && value >= minimum,
    `Invalid ${label}`,
  );
  return value;
}

function bounded(value: number, lower: number, upper: number): number {
  return Math.min(upper, Math.max(lower, finite(value, 'score input')));
}

function validate(
  symbol: string,
  features: FeatureSnapshot,
  regime: RegimeDecision,
  position: PositionContext,
  cost: CostContext,
  config: SignalConfig,
): void {
  requireCondition(
    typeof symbol === 'string' && symbol.trim().length > 0,
    'Missing symbol',
  );
  requireCondition(features.symbol === symbol, 'Feature symbol mismatch');
  requireCondition(regime.symbol === symbol, 'Regime symbol mismatch');
  requireCondition(
    Number.isSafeInteger(features.timestamp) && features.timestamp >= 0,
    'Invalid feature timestamp',
  );
  requireCondition(
    Number.isFinite(features.close) && features.close > 0,
    'Invalid close',
  );
  requireCondition(
    Number.isFinite(features.emaFast) && features.emaFast > 0,
    'Invalid fast EMA',
  );
  requireCondition(
    Number.isFinite(features.emaSlow) && features.emaSlow > 0,
    'Invalid slow EMA',
  );
  finite(features.atr, 'ATR', 0);
  finite(features.atrPct, 'ATR percent', 0);
  finite(features.return5, 'five-bar return');
  requireCondition(features.return5 > -1, 'Invalid five-bar return');
  finite(features.zScore20, 'z-score');
  finite(features.volume, 'volume', 0);
  finite(features.volumeSma20, 'volume average', 0);
  requireCondition(
    Number.isFinite(features.obiTop5) &&
      features.obiTop5 >= -1 &&
      features.obiTop5 <= 1,
    'Invalid OBI',
  );
  finite(features.micropriceLeanBps, 'microprice lean');
  finite(features.spreadBps, 'spread', 0);
  finite(features.dataAgeMs, 'data age', 0);
  finite(cost.feeBpsPerSide, 'fee', 0);
  finite(cost.estimatedSlippageBpsPerSide, 'slippage', 0);
  requireCondition(
    Number.isFinite(config.opportunityScoreThreshold) &&
      config.opportunityScoreThreshold >= 0 &&
      config.opportunityScoreThreshold <= 100,
    'Invalid score threshold',
  );
  requireCondition(
    Number.isFinite(config.minEdgeCostRatio) && config.minEdgeCostRatio > 0,
    'Invalid edge threshold',
  );
  requireCondition(
    Number.isFinite(config.maxDataAgeMs) && config.maxDataAgeMs > 0,
    'Invalid data-age horizon',
  );
  if (position.openLong !== null) {
    requireCondition(
      typeof position.openLong.symbol === 'string' &&
        !!position.openLong.symbol.trim(),
      'Invalid position symbol',
    );
    requireCondition(
      Number.isFinite(position.openLong.quantity) &&
        position.openLong.quantity > 0,
      'Invalid long quantity',
    );
  }
}

function score(
  features: FeatureSnapshot,
  stableRegime: RegimeDecision['stableRegime'],
  config: SignalConfig,
): OpportunityScoreBreakdown {
  const regimeStructure =
    stableRegime === 'TRENDING_UP' ? 30 : stableRegime === 'RANGE' ? 26 : 0;
  const momentumOrReversion =
    stableRegime === 'TRENDING_UP'
      ? bounded(
          10 + finite(features.return5 * 10_000, 'return basis points') / 20,
          0,
          20,
        )
      : stableRegime === 'RANGE'
        ? bounded(10 + (-features.zScore20 - 1.25) * 10, 0, 20)
        : 0;
  const volumeRatio =
    features.volumeSma20 === 0
      ? 0
      : finite(features.volume / features.volumeSma20, 'relative volume', 0);
  const volumeQuality = bounded((volumeRatio - 0.5) * 10, 0, 10);
  const orderBookImbalance = bounded(5 + 10 * features.obiTop5, 0, 10);
  const micropriceQuality = bounded(5 + features.micropriceLeanBps / 2, 0, 10);
  const spreadQuality = bounded(10 - features.spreadBps / 2, 0, 10);
  const dataQuality = bounded(
    10 * (1 - features.dataAgeMs / config.maxDataAgeMs),
    0,
    10,
  );
  const total = finite(
    regimeStructure +
      momentumOrReversion +
      volumeQuality +
      orderBookImbalance +
      micropriceQuality +
      spreadQuality +
      dataQuality,
    'opportunity score',
    0,
  );
  requireCondition(total <= 100, 'Opportunity score exceeds 100');
  return {
    regimeStructure,
    momentumOrReversion,
    volumeQuality,
    orderBookImbalance,
    micropriceQuality,
    spreadQuality,
    dataQuality,
    total,
  };
}

/**
 * Conservative deterministic move estimate:
 * trend = min(0.5 ATR bps, 0.5 positive five-bar return bps);
 * range = min(0.5 ATR bps, 0.25 |negative z-score| ATR bps).
 * Exits and non-setups have no estimated entry move.
 */
function estimatedEntryMoveBps(
  features: FeatureSnapshot,
  setupType: SetupType,
): number {
  const atrBps = finite(features.atrPct * 10_000, 'ATR basis points', 0);
  if (setupType === 'TREND_CONTINUATION') {
    return finite(
      Math.min(0.5 * atrBps, 0.5 * Math.max(0, features.return5 * 10_000)),
      'trend move',
      0,
    );
  }
  if (setupType === 'RANGE_MEAN_REVERSION') {
    return finite(
      Math.min(0.5 * atrBps, 0.25 * Math.max(0, -features.zScore20) * atrBps),
      'range move',
      0,
    );
  }
  return 0;
}

/** Pure, per-symbol FLAT ↔ LONG signal proposal. Portfolio limits are external. */
export function generateCandidate(
  symbol: string,
  features: FeatureSnapshot,
  regime: RegimeDecision,
  position: PositionContext,
  cost: CostContext,
  config: SignalConfig = DEFAULT_SIGNAL_CONFIG,
): CandidateSignal {
  validate(symbol, features, regime, position, cost, config);
  const stableRegime = regime.stableRegime;
  const hasThisLong = position.openLong?.symbol === symbol;
  const scoreBreakdown = score(features, stableRegime, config);
  const estimatedRoundTripCostBps = finite(
    2 * cost.feeBpsPerSide +
      2 * cost.estimatedSlippageBpsPerSide +
      features.spreadBps,
    'round-trip cost',
    0,
  );

  const bullEvidence: string[] = [];
  const bearEvidence: string[] = [];
  if (features.obiTop5 > 0)
    bullEvidence.push(
      'Positive top-five OBI is quality evidence, not a prediction',
    );
  if (features.obiTop5 < 0)
    bearEvidence.push('Negative top-five OBI weakens entry quality');
  if (features.micropriceLeanBps > 0)
    bullEvidence.push('Positive microprice lean supports entry quality');
  if (features.micropriceLeanBps < 0)
    bearEvidence.push('Negative microprice lean weakens entry quality');

  let setupType: SetupType = 'NONE';
  let action: CandidateSignal['action'] = 'HOLD';
  let intent: CandidateSignal['intent'] = 'NONE';
  const reasons: string[] = [];
  const rejectionCategories: SignalRejectionCategory[] = [];

  if (hasThisLong && stableRegime === 'TRENDING_DOWN') {
    setupType = 'DETERMINISTIC_EXIT';
    action = 'SELL';
    intent = 'CLOSE_LONG';
    reasons.push('TRENDING_DOWN_EXIT');
    bearEvidence.push('Stable downtrend with a long position in this symbol');
  } else if (
    hasThisLong &&
    stableRegime === 'RANGE' &&
    features.zScore20 > 1.25
  ) {
    setupType = 'DETERMINISTIC_EXIT';
    action = 'SELL';
    intent = 'CLOSE_LONG';
    reasons.push('RANGE_OVERBOUGHT_EXIT');
    bearEvidence.push(
      'Range z-score above +1.25 with a long position in this symbol',
    );
  } else {
    if (
      stableRegime === 'TRENDING_UP' &&
      features.return5 > 0 &&
      features.emaFast > features.emaSlow
    ) {
      setupType = 'TREND_CONTINUATION';
      reasons.push('TREND_CONTINUATION_ELIGIBLE');
      bullEvidence.push('Positive five-bar return and fast EMA above slow EMA');
    } else if (stableRegime === 'RANGE' && features.zScore20 < -1.25) {
      setupType = 'RANGE_MEAN_REVERSION';
      reasons.push('RANGE_MEAN_REVERSION_ELIGIBLE');
      bullEvidence.push('Range z-score below -1.25');
    } else {
      rejectionCategories.push('NO_SETUP');
      reasons.push('NO_ENTRY_SETUP');
    }
  }

  const estimatedMoveBps = estimatedEntryMoveBps(features, setupType);
  const edgeToCostRatio =
    estimatedRoundTripCostBps > 0
      ? finite(
          estimatedMoveBps / estimatedRoundTripCostBps,
          'edge-to-cost ratio',
          0,
        )
      : 0;
  const clearsEstimatedCosts =
    estimatedRoundTripCostBps > 0 && edgeToCostRatio >= config.minEdgeCostRatio;

  if (
    setupType === 'TREND_CONTINUATION' ||
    setupType === 'RANGE_MEAN_REVERSION'
  ) {
    if (hasThisLong) rejectionCategories.push('ALREADY_LONG');
    if (features.obiTop5 <= -0.25)
      rejectionCategories.push('ADVERSE_MICROSTRUCTURE');
    if (!clearsEstimatedCosts) rejectionCategories.push('COST_GATE');
    if (scoreBreakdown.total < config.opportunityScoreThreshold)
      rejectionCategories.push('SCORE_GATE');
    reasons.push(...rejectionCategories);
    if (rejectionCategories.length === 0) {
      action = 'BUY';
      intent = 'OPEN_LONG';
      reasons.push('ENTRY_GATES_PASSED');
    }
  }

  return {
    symbol,
    action,
    intent,
    setupType,
    regime: stableRegime,
    opportunityScore: scoreBreakdown.total,
    scoreBreakdown,
    estimatedMoveBps,
    estimatedRoundTripCostBps,
    edgeToCostRatio,
    clearsEstimatedCosts,
    bullEvidence,
    bearEvidence,
    reasons,
    rejectionCategories,
    timestamp: features.timestamp,
  };
}

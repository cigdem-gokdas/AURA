import type { FeatureSnapshot } from '../features/types.js';
import type {
  MarketRegime,
  RegimeHysteresisState,
  RegimeTransition,
} from './types.js';

const REGIMES: readonly MarketRegime[] = [
  'TRENDING_UP',
  'TRENDING_DOWN',
  'RANGE',
  'HIGH_VOLATILITY',
  'UNCERTAIN',
];

export class RegimeClassificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegimeClassificationError';
  }
}

function requireCondition(
  condition: unknown,
  message: string,
): asserts condition {
  if (!condition) throw new RegimeClassificationError(message);
}

function requireSymbol(symbol: string, features: FeatureSnapshot): void {
  requireCondition(
    typeof symbol === 'string' && symbol.trim().length > 0,
    'Missing symbol',
  );
  requireCondition(features.symbol === symbol, 'Feature symbol mismatch');
  requireCondition(
    Number.isFinite(features.adx) && features.adx >= 0,
    'Invalid ADX',
  );
  requireCondition(
    Number.isFinite(features.emaFast) && features.emaFast > 0,
    'Invalid fast EMA',
  );
  requireCondition(
    Number.isFinite(features.emaSlow) && features.emaSlow > 0,
    'Invalid slow EMA',
  );
  requireCondition(
    Number.isFinite(features.atrPctPercentile) &&
      features.atrPctPercentile >= 0 &&
      features.atrPctPercentile <= 1,
    'Invalid ATR percentile',
  );
}

/** Raw thresholds are identical for every explicitly supplied symbol. */
export function classifyRawRegime(
  symbol: string,
  features: FeatureSnapshot,
): MarketRegime {
  requireSymbol(symbol, features);
  if (features.atrPctPercentile > 0.9) return 'HIGH_VOLATILITY';
  if (features.adx > 25 && features.emaFast > features.emaSlow)
    return 'TRENDING_UP';
  if (features.adx > 25 && features.emaFast < features.emaSlow)
    return 'TRENDING_DOWN';
  if (features.adx <= 20 && features.atrPctPercentile < 0.7) return 'RANGE';
  return 'UNCERTAIN';
}

export function initialRegimeState(symbol: string): RegimeHysteresisState {
  requireCondition(
    typeof symbol === 'string' && symbol.trim().length > 0,
    'Missing symbol',
  );
  return {
    symbol,
    stableRegime: 'UNCERTAIN',
    pendingRegime: null,
    pendingCount: 0,
  };
}

function checkedPrevious(
  symbol: string,
  previousState: RegimeHysteresisState | null,
): RegimeHysteresisState {
  if (previousState === null) return initialRegimeState(symbol);
  requireCondition(
    previousState.symbol === symbol,
    'Regime state symbol mismatch',
  );
  requireCondition(
    REGIMES.includes(previousState.stableRegime),
    'Invalid stable regime',
  );
  requireCondition(
    (previousState.pendingRegime === null &&
      previousState.pendingCount === 0) ||
      (previousState.pendingRegime !== null &&
        REGIMES.includes(previousState.pendingRegime) &&
        previousState.pendingRegime !== previousState.stableRegime &&
        previousState.pendingCount === 1),
    'Invalid pending regime state',
  );
  return previousState;
}

/** Pure transition: pass the previous value for this symbol and retain nextState externally. */
export function transitionRegime(
  symbol: string,
  features: FeatureSnapshot,
  previousState: RegimeHysteresisState | null,
): RegimeTransition {
  const rawProposedRegime = classifyRawRegime(symbol, features);
  const previous = checkedPrevious(symbol, previousState);
  let stableRegime = previous.stableRegime;
  let pendingRegime: MarketRegime | null = null;
  let pendingCount: 0 | 1 = 0;
  let reason: string;

  if (rawProposedRegime === stableRegime) {
    reason = 'Raw proposal matches the stable regime';
  } else if (rawProposedRegime === 'HIGH_VOLATILITY') {
    stableRegime = 'HIGH_VOLATILITY';
    reason = 'High volatility activates immediately';
  } else if (previous.pendingRegime === rawProposedRegime) {
    stableRegime = rawProposedRegime;
    reason = 'Two consecutive matching raw proposals';
  } else {
    pendingRegime = rawProposedRegime;
    pendingCount = 1;
    reason = 'Awaiting a second matching raw proposal';
  }

  const transitioned = stableRegime !== previous.stableRegime;
  return {
    decision: { symbol, stableRegime, rawProposedRegime, transitioned, reason },
    nextState: { symbol, stableRegime, pendingRegime, pendingCount },
  };
}

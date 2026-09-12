import type { Candle, OrderBookLevel } from '../market/types.js';
import type { FeatureInput, FeatureSnapshot } from './types.js';

const FAST_EMA_PERIOD = 9;
const SLOW_EMA_PERIOD = 21;
const WILDER_PERIOD = 14;
const STAT_PERIOD = 20;
const ATR_PERCENTILE_WINDOW = 100;
/** First ADX needs 14 directional observations plus 14 DX observations. */
export const MIN_FEATURE_CANDLES = 2 * WILDER_PERIOD;

export class FeatureCalculationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FeatureCalculationError';
  }
}

function requireCondition(
  condition: unknown,
  message: string,
): asserts condition {
  if (!condition) throw new FeatureCalculationError(message);
}

function finite(value: number, label: string, minimum = -Infinity): number {
  requireCondition(
    Number.isFinite(value) && value >= minimum,
    `Invalid ${label}`,
  );
  return value;
}

function positive(value: number, label: string): number {
  requireCondition(Number.isFinite(value) && value > 0, `Invalid ${label}`);
  return value;
}

function validTimestamp(value: number, label: string): number {
  requireCondition(
    Number.isSafeInteger(value) && value >= 0,
    `Invalid ${label}`,
  );
  return value;
}

function mean(values: readonly number[]): number {
  requireCondition(values.length > 0, 'Empty numeric window');
  return finite(
    values.reduce((sum, value) => sum + value, 0) / values.length,
    'mean',
  );
}

function latestEma(values: readonly number[], period: number): number {
  let ema = mean(values.slice(0, period));
  const alpha = 2 / (period + 1);
  for (let index = period; index < values.length; index += 1) {
    ema = finite(alpha * values[index]! + (1 - alpha) * ema, 'EMA');
  }
  return ema;
}

function wilderAtrAndAdx(candles: readonly Candle[]): {
  atr: number;
  adx: number;
  atrPctPercentile: number;
} {
  let trSum = 0;
  let plusSum = 0;
  let minusSum = 0;
  let atr = 0;
  let plusDm = 0;
  let minusDm = 0;
  let adx = 0;
  const dxValues: number[] = [];
  const atrPcts: number[] = [];

  for (let index = 1; index < candles.length; index += 1) {
    const previous = candles[index - 1]!;
    const current = candles[index]!;
    const trueRange = Math.max(
      current.high - current.low,
      Math.abs(current.high - previous.close),
      Math.abs(current.low - previous.close),
    );
    const upMove = current.high - previous.high;
    const downMove = previous.low - current.low;
    const positiveMovement = upMove > downMove && upMove > 0 ? upMove : 0;
    const negativeMovement = downMove > upMove && downMove > 0 ? downMove : 0;

    if (index <= WILDER_PERIOD) {
      trSum += trueRange;
      plusSum += positiveMovement;
      minusSum += negativeMovement;
      if (index === WILDER_PERIOD) {
        atr = trSum / WILDER_PERIOD;
        plusDm = plusSum / WILDER_PERIOD;
        minusDm = minusSum / WILDER_PERIOD;
      }
    } else {
      atr = (atr * (WILDER_PERIOD - 1) + trueRange) / WILDER_PERIOD;
      plusDm =
        (plusDm * (WILDER_PERIOD - 1) + positiveMovement) / WILDER_PERIOD;
      minusDm =
        (minusDm * (WILDER_PERIOD - 1) + negativeMovement) / WILDER_PERIOD;
    }

    if (index >= WILDER_PERIOD) {
      finite(atr, 'ATR', 0);
      const plusDi = atr === 0 ? 0 : (100 * plusDm) / atr;
      const minusDi = atr === 0 ? 0 : (100 * minusDm) / atr;
      const denominator = plusDi + minusDi;
      const dx =
        denominator === 0
          ? 0
          : (100 * Math.abs(plusDi - minusDi)) / denominator;
      dxValues.push(finite(dx, 'DX', 0));
      atrPcts.push(finite(atr / current.close, 'ATR percent', 0));
      if (dxValues.length === WILDER_PERIOD) {
        adx = mean(dxValues);
      } else if (dxValues.length > WILDER_PERIOD) {
        adx = (adx * (WILDER_PERIOD - 1) + dx) / WILDER_PERIOD;
      }
    }
  }

  const window = atrPcts.slice(-ATR_PERCENTILE_WINDOW);
  const latest = window.at(-1)!;
  const less = window.filter((value) => value < latest).length;
  const equal = window.filter((value) => value === latest).length;
  return {
    atr: finite(atr, 'ATR', 0),
    adx: finite(adx, 'ADX', 0),
    // Midrank keeps flat, tied ATR series at the 50th percentile.
    atrPctPercentile: finite(
      (less + equal / 2) / window.length,
      'ATR percentile',
      0,
    ),
  };
}

function validatedBookSide(
  levels: readonly OrderBookLevel[],
  descending: boolean,
): OrderBookLevel[] {
  requireCondition(levels.length > 0, 'Empty order book side');
  const copy = levels.map((level) => ({
    price: positive(level.price, 'order book price'),
    size: finite(level.size, 'order book quantity', 0),
  }));
  return copy.sort((left, right) =>
    descending ? right.price - left.price : left.price - right.price,
  );
}

/** Pure feature calculation for exactly the explicitly supplied market. */
export function calculateFeatures(
  symbol: string,
  data: FeatureInput,
  evaluationTime: number,
): FeatureSnapshot {
  requireCondition(
    typeof symbol === 'string' && symbol.trim().length > 0,
    'Missing symbol',
  );
  validTimestamp(evaluationTime, 'evaluation time');
  const { candles, orderBook } = data;
  requireCondition(
    candles.length >= MIN_FEATURE_CANDLES,
    `At least ${MIN_FEATURE_CANDLES} candles are required`,
  );
  requireCondition(orderBook.symbol === symbol, 'Order book symbol mismatch');
  validTimestamp(orderBook.timestamp, 'order book timestamp');
  requireCondition(
    orderBook.timestamp <= evaluationTime,
    'Order book timestamp is in the future',
  );

  let previousTimestamp = -1;
  for (const candle of candles) {
    requireCondition(candle.symbol === symbol, 'Candle symbol mismatch');
    validTimestamp(candle.timestamp, 'candle timestamp');
    requireCondition(
      candle.timestamp > previousTimestamp &&
        candle.timestamp <= evaluationTime,
      'Invalid candle chronology',
    );
    previousTimestamp = candle.timestamp;
    positive(candle.open, 'open');
    positive(candle.high, 'high');
    positive(candle.low, 'low');
    positive(candle.close, 'close');
    finite(candle.volume, 'volume', 0);
    requireCondition(
      candle.high >= Math.max(candle.open, candle.close, candle.low) &&
        candle.low <= Math.min(candle.open, candle.close, candle.high),
      'Impossible candle prices',
    );
  }

  const bids = validatedBookSide(orderBook.bids, true);
  const asks = validatedBookSide(orderBook.asks, false);
  const bestBid = bids[0]!;
  const bestAsk = asks[0]!;
  requireCondition(bestBid.price <= bestAsk.price, 'Crossed order book');
  const midPrice = positive((bestBid.price + bestAsk.price) / 2, 'mid price');
  const bestSize = positive(bestBid.size + bestAsk.size, 'best-level quantity');
  const microprice = positive(
    (bestAsk.price * bestBid.size + bestBid.price * bestAsk.size) / bestSize,
    'microprice',
  );
  const bidVolume = finite(
    bids.slice(0, 5).reduce((sum, level) => sum + level.size, 0),
    'top-five bid volume',
    0,
  );
  const askVolume = finite(
    asks.slice(0, 5).reduce((sum, level) => sum + level.size, 0),
    'top-five ask volume',
    0,
  );
  const totalVolume = positive(bidVolume + askVolume, 'top-five total volume');

  const closes = candles.map((candle) => candle.close);
  const latest = candles.at(-1)!;
  const lastTwentyCloses = closes.slice(-STAT_PERIOD);
  const closeMean = mean(lastTwentyCloses);
  const variance = mean(
    lastTwentyCloses.map((close) => (close - closeMean) ** 2),
  );
  const standardDeviation = Math.sqrt(finite(variance, 'close variance', 0));
  const { atr, adx, atrPctPercentile } = wilderAtrAndAdx(candles);

  const snapshot: FeatureSnapshot = {
    symbol,
    timestamp: evaluationTime,
    close: latest.close,
    bestBid: bestBid.price,
    bestAsk: bestAsk.price,
    midPrice,
    emaFast: latestEma(closes, FAST_EMA_PERIOD),
    emaSlow: latestEma(closes, SLOW_EMA_PERIOD),
    adx,
    atr,
    atrPct: atr / latest.close,
    atrPctPercentile,
    volume: latest.volume,
    volumeSma20: mean(
      candles.slice(-STAT_PERIOD).map((candle) => candle.volume),
    ),
    return5: latest.close / closes[closes.length - 6]! - 1,
    zScore20:
      standardDeviation === 0
        ? 0
        : (latest.close - closeMean) / standardDeviation,
    obiTop5: (bidVolume - askVolume) / totalVolume,
    spreadBps: ((bestAsk.price - bestBid.price) / midPrice) * 10_000,
    microprice,
    micropriceLeanBps: ((microprice - midPrice) / midPrice) * 10_000,
    dataAgeMs: evaluationTime - Math.min(latest.timestamp, orderBook.timestamp),
  };
  for (const [key, value] of Object.entries(snapshot)) {
    if (typeof value === 'number') finite(value, key);
  }
  return snapshot;
}

import { describe, expect, it } from 'vitest';
import {
  calculateFeatures,
  FeatureCalculationError,
  MIN_FEATURE_CANDLES,
} from '../../src/features/calculate.js';
import type { FeatureInput } from '../../src/features/types.js';
import type { Candle, OrderBookSnapshot } from '../../src/market/types.js';

const START = 1_000_000;
const BAR_MS = 180_000;

function candles(symbol: string, count = 30, firstClose = 100): Candle[] {
  return Array.from({ length: count }, (_, index) => {
    const close = firstClose + index;
    return {
      symbol,
      timestamp: START + index * BAR_MS,
      open: close,
      high: close + 1,
      low: close - 1,
      close,
      volume: index + 1,
    };
  });
}

function book(symbol: string, timestamp: number): OrderBookSnapshot {
  return {
    symbol,
    timestamp,
    bids: [5, 4, 3, 2, 1].map((size, index) => ({ price: 99 - index, size })),
    asks: [1, 1, 1, 1, 1].map((size, index) => ({ price: 101 + index, size })),
  };
}

function fixture(
  symbol: string,
  count = 30,
  firstClose = 100,
): {
  data: FeatureInput;
  evaluationTime: number;
} {
  const series = candles(symbol, count, firstClose);
  const lastTime = series.at(-1)!.timestamp;
  return {
    data: { candles: series, orderBook: book(symbol, lastTime + 1_000) },
    evaluationTime: lastTime + 2_000,
  };
}

describe('calculateFeatures', () => {
  it('calculates seeded EMA9/21, Wilder ATR14/ADX14, rolling volume, return5, and z-score20', () => {
    const { data, evaluationTime } = fixture('BTC-USDT');
    const result = calculateFeatures('BTC-USDT', data, evaluationTime);
    expect(result.symbol).toBe('BTC-USDT');
    expect(result.timestamp).toBe(evaluationTime);
    expect(result.close).toBe(129);
    expect(result.emaFast).toBeCloseTo(125, 10);
    expect(result.emaSlow).toBeCloseTo(119, 10);
    expect(result.atr).toBeCloseTo(2, 10);
    expect(result.adx).toBeCloseTo(100, 10);
    expect(result.atrPct).toBeCloseTo(2 / 129, 10);
    expect(result.volume).toBe(30);
    expect(result.volumeSma20).toBeCloseTo(20.5, 10);
    expect(result.return5).toBeCloseTo(129 / 124 - 1, 10);
    expect(result.zScore20).toBeCloseTo(9.5 / Math.sqrt(33.25), 10);
    expect(result.dataAgeMs).toBe(2_000);
  });

  it('uses Wilder smoothing after a true-range spike', () => {
    const { data, evaluationTime } = fixture('BTC-USDT', 29);
    const changed = [...data.candles];
    changed[28] = { ...changed[28]!, high: changed[28]!.close + 10 };
    const result = calculateFeatures(
      'BTC-USDT',
      { ...data, candles: changed },
      evaluationTime,
    );
    expect(result.atr).toBeCloseTo(37 / 14, 10);
    expect(result.adx).toBeCloseTo(100, 10);
  });

  it('calculates the latest ATR-percentile midrank using at most 100 valid observations', () => {
    const short = fixture('BTC-USDT', 30);
    expect(
      calculateFeatures('BTC-USDT', short.data, short.evaluationTime)
        .atrPctPercentile,
    ).toBeCloseTo(0.5 / 16, 10);
    const long = fixture('BTC-USDT', 120);
    expect(
      calculateFeatures('BTC-USDT', long.data, long.evaluationTime)
        .atrPctPercentile,
    ).toBeCloseTo(0.5 / 100, 10);
  });

  it('calculates top-five OBI, spread, microprice, and microprice lean', () => {
    const { data, evaluationTime } = fixture('BTC-USDT');
    const result = calculateFeatures('BTC-USDT', data, evaluationTime);
    expect(result.bestBid).toBe(99);
    expect(result.bestAsk).toBe(101);
    expect(result.midPrice).toBe(100);
    expect(result.obiTop5).toBeCloseTo(0.5, 10);
    expect(result.spreadBps).toBeCloseTo(200, 10);
    expect(result.microprice).toBeCloseTo((101 * 5 + 99) / 6, 10);
    expect(result.micropriceLeanBps).toBeCloseTo(
      ((101 * 5 + 99) / 6 - 100) * 100,
      10,
    );
  });

  it('handles flat prices and zero standard deviation without NaN or Infinity', () => {
    const { data, evaluationTime } = fixture('BTC-USDT', 30);
    const flat = data.candles.map((candle) => ({
      ...candle,
      open: 100,
      high: 100,
      low: 100,
      close: 100,
      volume: 0,
    }));
    const result = calculateFeatures(
      'BTC-USDT',
      { ...data, candles: flat },
      evaluationTime,
    );
    expect(result.atr).toBe(0);
    expect(result.adx).toBe(0);
    expect(result.atrPct).toBe(0);
    expect(result.atrPctPercentile).toBe(0.5);
    expect(result.zScore20).toBe(0);
    expect(
      Object.values(result)
        .filter((value): value is number => typeof value === 'number')
        .every(Number.isFinite),
    ).toBe(true);
  });

  it('rejects insufficient history, invalid candles, timestamps, and symbol mismatches', () => {
    const { data, evaluationTime } = fixture('BTC-USDT');
    expect(MIN_FEATURE_CANDLES).toBe(28);
    const exactlyEnough = fixture('BTC-USDT', MIN_FEATURE_CANDLES);
    expect(
      calculateFeatures(
        'BTC-USDT',
        exactlyEnough.data,
        exactlyEnough.evaluationTime,
      ).adx,
    ).toBeCloseTo(100, 10);
    expect(() =>
      calculateFeatures(
        'BTC-USDT',
        { ...data, candles: data.candles.slice(0, 27) },
        evaluationTime,
      ),
    ).toThrow(FeatureCalculationError);
    const badPrice = [...data.candles];
    badPrice[5] = { ...badPrice[5]!, close: -1 };
    expect(() =>
      calculateFeatures(
        'BTC-USDT',
        { ...data, candles: badPrice },
        evaluationTime,
      ),
    ).toThrow(FeatureCalculationError);
    const badTime = [...data.candles];
    badTime[5] = { ...badTime[5]!, timestamp: badTime[4]!.timestamp };
    expect(() =>
      calculateFeatures(
        'BTC-USDT',
        { ...data, candles: badTime },
        evaluationTime,
      ),
    ).toThrow(FeatureCalculationError);
    expect(() =>
      calculateFeatures('BTC-USDT', data, data.candles.at(-1)!.timestamp - 1),
    ).toThrow(FeatureCalculationError);
    expect(() => calculateFeatures('ETH-USDT', data, evaluationTime)).toThrow(
      FeatureCalculationError,
    );
  });

  it('rejects crossed books, negative quantities, and nonfinite values', () => {
    const { data, evaluationTime } = fixture('BTC-USDT');
    const crossed = { ...data.orderBook, asks: [{ price: 98, size: 1 }] };
    expect(() =>
      calculateFeatures(
        'BTC-USDT',
        { ...data, orderBook: crossed },
        evaluationTime,
      ),
    ).toThrow('Crossed order book');
    const negative = { ...data.orderBook, bids: [{ price: 99, size: -1 }] };
    expect(() =>
      calculateFeatures(
        'BTC-USDT',
        { ...data, orderBook: negative },
        evaluationTime,
      ),
    ).toThrow(FeatureCalculationError);
    const negativeVolume = [...data.candles];
    negativeVolume[10] = { ...negativeVolume[10]!, volume: -1 };
    expect(() =>
      calculateFeatures(
        'BTC-USDT',
        { ...data, candles: negativeVolume },
        evaluationTime,
      ),
    ).toThrow(FeatureCalculationError);
    const infinite = [...data.candles];
    infinite[10] = { ...infinite[10]!, volume: Infinity };
    expect(() =>
      calculateFeatures(
        'BTC-USDT',
        { ...data, candles: infinite },
        evaluationTime,
      ),
    ).toThrow(FeatureCalculationError);
    const huge = {
      ...data.orderBook,
      bids: Array.from({ length: 5 }, (_, index) => ({
        price: 99 - index,
        size: 1e308,
      })),
    };
    expect(() =>
      calculateFeatures(
        'BTC-USDT',
        { ...data, orderBook: huge },
        evaluationTime,
      ),
    ).toThrow(FeatureCalculationError);
  });

  it('is symbol independent and has no mutable BTC → ETH → BTC state', () => {
    const btc = fixture('BTC-USDT');
    const eth = fixture('ETH-USDT', 30, 200);
    const btcOnly = calculateFeatures('BTC-USDT', btc.data, btc.evaluationTime);
    const firstBtc = calculateFeatures(
      'BTC-USDT',
      btc.data,
      btc.evaluationTime,
    );
    const ethResult = calculateFeatures(
      'ETH-USDT',
      eth.data,
      eth.evaluationTime,
    );
    const secondBtc = calculateFeatures(
      'BTC-USDT',
      btc.data,
      btc.evaluationTime,
    );
    expect(firstBtc).toEqual(btcOnly);
    expect(secondBtc).toEqual(btcOnly);
    expect(ethResult.symbol).toBe('ETH-USDT');
    expect(ethResult.close).toBe(229);
    const sameNumbersEth = fixture('ETH-USDT');
    const sameNumbersResult = calculateFeatures(
      'ETH-USDT',
      sameNumbersEth.data,
      sameNumbersEth.evaluationTime,
    );
    expect({ ...sameNumbersResult, symbol: 'BTC-USDT' }).toEqual(btcOnly);
  });
});

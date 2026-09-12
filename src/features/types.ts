import type { Candle, OrderBookSnapshot } from '../market/types.js';

export interface FeatureInput {
  /** Oldest to newest, with one closed candle per timestamp. */
  candles: readonly Candle[];
  orderBook: OrderBookSnapshot;
}

export interface FeatureSnapshot {
  symbol: string;
  timestamp: number;
  close: number;
  bestBid: number;
  bestAsk: number;
  midPrice: number;
  emaFast: number;
  emaSlow: number;
  adx: number;
  atr: number;
  atrPct: number;
  atrPctPercentile: number;
  volume: number;
  volumeSma20: number;
  return5: number;
  zScore20: number;
  obiTop5: number;
  spreadBps: number;
  microprice: number;
  micropriceLeanBps: number;
  dataAgeMs: number;
}

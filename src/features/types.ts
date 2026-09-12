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

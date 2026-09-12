import type { ProtectionMode } from '../risk/types.js';
import type { OrderSide } from '../execution/types.js';

export interface PositionProtectionState {
  mode: ProtectionMode;
  initialStopPrice: number;
  currentStopPrice: number;
  takeProfitPrice: number | null;
  breakEvenActivated: boolean;
  trailingActivated: boolean;
  lastUpdatedAt: number;
}

export interface OpenPosition {
  symbol: string;
  quantity: number;
  averageEntryPrice: number;
  markPrice: number;
  referencePrice: number;
  openedAt: number;
  updatedAt: number;
  protection: PositionProtectionState;
}

export interface EquitySnapshot {
  equity: number;
  availableQuoteBalance: number;
  unrealizedPnl: number;
  realizedPnlToday: number;
  openPositionSymbol: string | null;
  timestamp: number;
}

export interface PerformanceState {
  equity: EquitySnapshot;
  dayStartEquity: number;
  peakEquity: number;
  completedTrades: number;
  winningTrades: number;
  losingTrades: number;
  consecutiveLosses: number;
  timestamp: number;
}

export interface Fill {
  symbol: string;
  clientOrderId: string;
  exchangeOrderId: string;
  fillId: string;
  side: OrderSide;
  quantity: number;
  price: number;
  fee: number;
  timestamp: number;
}

/** Contract only; no monitoring loop is implemented. */
export interface PositionMonitor {
  getOpenPosition(): Promise<OpenPosition | null>;
  getEquitySnapshot(): Promise<EquitySnapshot>;
  getPerformanceState(): Promise<PerformanceState>;
}

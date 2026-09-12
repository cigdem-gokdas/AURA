import type { ProtectionMode, ProtectionPlan } from '../risk/types.js';
import type { OrderSide } from '../execution/types.js';
import type { DecisionMemorySummary } from '../memory/types.js';
import type { StartupExchangeSnapshot } from '../execution/types.js';

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
  weightedAverageEntryPrice: number;
  markPrice: number;
  referencePrice: number;
  realizedPnl: number;
  unrealizedPnl: number;
  /** False after exchange-only restart recovery when prior partial PnL/fees are unknown. */
  tradePerformanceComplete: boolean;
  /** Unallocated entry fees, in quote-currency equivalent. */
  entryFeeBalance: number;
  /** Cumulative initial risk for the trade, used only for realized R reporting. */
  riskCapital: number;
  openedAt: number;
  updatedAt: number;
  protectionPlan: ProtectionPlan;
  protectionMode: ProtectionMode;
  protection: PositionProtectionState;
}

export interface EquitySnapshot {
  startingEquity: number;
  currentEquity: number;
  peakEquity: number;
  equity: number;
  availableQuoteBalance: number;
  unrealizedPnl: number;
  realizedPnlToday: number;
  dailyPnl: number;
  dailyReturn: number;
  currentDrawdown: number;
  maximumDrawdown: number;
  openPositionSymbol: string | null;
  timestamp: number;
}

export interface PerformanceState {
  equity: EquitySnapshot;
  dayStartEquity: number;
  peakEquity: number;
  completedTrades: number;
  closedTradeCount: number;
  winningTrades: number;
  losingTrades: number;
  consecutiveWins: number;
  consecutiveLosses: number;
  dailyPnl: number;
  dailyReturn: number;
  currentDrawdown: number;
  maximumDrawdown: number;
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

export interface FillPolicy {
  allowSameSymbolIncrease: boolean;
  /** Required for the first BUY and checked on subsequent same-symbol BUYs. */
  protectionPlan: ProtectionPlan | null;
  protectionMode: ProtectionMode;
}

export interface FillProcessingResult {
  status: 'APPLIED' | 'DUPLICATE_FILL' | 'INVALID_FILL' | 'SYMBOL_CONFLICT'
    | 'SAME_SYMBOL_INCREASE_NOT_ALLOWED' | 'NO_MATCHING_POSITION' | 'OVERSELL'
    | 'PROTECTION_MISMATCH';
  position: OpenPosition | null;
  closedTradePnl: number | null;
  closedTradeOutcomeR: number | null;
}

export interface StartupMonitorContext {
  /** Explicit marks and plans; exchange balance alone cannot supply these safely. */
  referencePrices: Readonly<Record<string, number>>;
  openedAtBySymbol: Readonly<Record<string, number>>;
  protectionPlans: Readonly<Record<string, ProtectionPlan>>;
  protectionModes: Readonly<Record<string, ProtectionMode>>;
}

export interface StartupMonitorResult {
  status: 'RESTORED' | 'DISCREPANCY' | 'INVALID_SNAPSHOT';
  reason: string;
  exchangePositionSymbols: readonly string[];
  localPositionSymbol: string | null;
  position: OpenPosition | null;
}

export interface PositionMonitor {
  getOpenPosition(): Promise<OpenPosition | null>;
  getEquitySnapshot(): Promise<EquitySnapshot>;
  getPerformanceState(): Promise<PerformanceState>;
  processFill(fill: Fill, policy?: FillPolicy): FillProcessingResult;
  updateMark(symbol: string, price: number, timestamp: number): void;
  recordDecision(summary: DecisionMemorySummary): void;
  getRecentDecisionMemory(): readonly DecisionMemorySummary[];
  reconcileStartup(snapshot: StartupExchangeSnapshot, context: StartupMonitorContext): StartupMonitorResult;
}

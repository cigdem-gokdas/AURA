import type { MarketProfile } from '../market/types.js';

export type OrderSide = 'BUY' | 'SELL';
export type OrderKind = 'MARKET' | 'LIMIT';
export type OrderState =
  | 'PENDING'
  | 'OPEN'
  | 'PARTIALLY_FILLED'
  | 'FILLED'
  | 'CANCELLED'
  | 'REJECTED'
  | 'UNKNOWN';

export interface OrderRequest {
  symbol: string;
  clientOrderId: string;
  cycleId: string;
  decisionId: string;
  side: OrderSide;
  kind: OrderKind;
  quantity: number;
  limitPrice: number | null;
}

export interface OrderSubmissionResult {
  symbol: string;
  clientOrderId: string;
  cycleId: string;
  decisionId: string;
  accepted: boolean;
  exchangeOrderId: string | null;
  reason: string | null;
  timestamp: number;
}

export interface OrderStatus {
  symbol: string;
  clientOrderId: string;
  cycleId: string;
  decisionId: string;
  exchangeOrderId: string | null;
  state: OrderState;
  requestedQuantity: number;
  filledQuantity: number;
  averageFillPrice: number | null;
  updatedAt: number;
}

export interface ExchangePositionSnapshot {
  symbol: string;
  quantity: number;
  averageEntryPrice: number;
  updatedAt: number;
}

export interface StartupExchangeSnapshot {
  profile: MarketProfile;
  positions: readonly ExchangePositionSnapshot[];
  openOrders: readonly OrderStatus[];
  timestamp: number;
}

export interface ReconciliationResult {
  symbol: string;
  clientOrderId: string;
  cycleId: string;
  decisionId: string;
  order: OrderStatus | null;
  position: ExchangePositionSnapshot | null;
  reconciled: boolean;
  reason: string;
  timestamp: number;
}

/** Contract only; no exchange or process behavior is implemented. */
export interface ExecutionEngine {
  submit(request: OrderRequest): Promise<OrderSubmissionResult>;
  getOrderStatus(symbol: string, clientOrderId: string): Promise<OrderStatus>;
  reconcile(request: OrderRequest): Promise<ReconciliationResult>;
  getStartupSnapshot(): Promise<StartupExchangeSnapshot>;
}

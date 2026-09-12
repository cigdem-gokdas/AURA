import type { MarketProfile } from '../market/types.js';
import type { ApprovedOrderPlan, ProtectionMode } from '../risk/types.js';

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
  exchangeOrderId?: string | null;
  cycleId: string;
  decisionId: string;
  side: OrderSide;
  kind: OrderKind;
  quantity: number;
  limitPrice: number | null;
}

export interface OrderSubmissionResult {
  status: 'ACCEPTED' | 'REJECTED' | 'CONNECTOR_FAILURE' | 'RECONCILE_REQUIRED' | 'DUPLICATE' | 'INVALID_PLAN';
  symbol: string;
  clientOrderId: string;
  cycleId: string;
  decisionId: string;
  accepted: boolean;
  exchangeOrderId: string | null;
  reason: string | null;
  timestamp: number;
  protectionMode: ProtectionMode | null;
  protectionVerified: boolean;
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
  averageEntryPrice: number | null;
  updatedAt: number;
}

export interface StartupExchangeSnapshot {
  profile: MarketProfile;
  totalEquityUsd: number;
  positions: readonly ExchangePositionSnapshot[];
  openOrders: readonly OrderStatus[];
  balances: readonly { currency: string; equity: number; available: number }[];
  recentFills: readonly { symbol: string; orderId: string; clientOrderId: string | null; quantity: number; price: number; timestamp: number }[];
  feeRates: readonly { symbol: string; makerRate: number; takerRate: number }[];
  orderLookupSupported: boolean;
  timestamp: number;
}

export interface ReconciliationResult {
  outcome: 'FILLED' | 'OPEN' | 'NOT_FOUND' | 'UNKNOWN';
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
  start(): Promise<void>;
  submitApprovedOrder(plan: ApprovedOrderPlan): Promise<OrderSubmissionResult>;
  getOrderStatus(symbol: string, clientOrderId: string): Promise<OrderStatus>;
  reconcile(request: OrderRequest): Promise<ReconciliationResult>;
  getStartupSnapshot(): Promise<StartupExchangeSnapshot>;
}

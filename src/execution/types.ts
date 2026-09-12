import type { MarketProfile } from '../market/types.js';
import type { OkxConnectorHealth, OkxMcpCallDiagnostic } from '../okx/types.js';
import type { AtkToolTrace } from '../okx/telemetry.js';
import type { ApprovedOrderPlan, ProtectionMode } from '../risk/types.js';
import type { ExecutionTools } from './discovery.js';

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
  /** Exchange algo IDs attached to the entry, when the exchange reported them. */
  protectionIds?: readonly string[];
}

/** Ownership evidence linking exchange-side protection to exactly one AURA entry. */
/**
 * Parameter signature of one AURA entry's protection. OKX materializes an attached TP/SL
 * as a new OCO algo whose algoId differs from the parent order's attachAlgoId and which
 * carries neither the parent ordId nor a client ID, so ownership is correlated through the
 * exact trigger prices, the protected quantity, and the lifecycle window.
 */
export interface ProtectionSignature {
  slTriggerPx: number;
  tpTriggerPx: number | null;
  quantity: number;
  notBefore: number | null;
}

export interface AttachedProtectionLink {
  symbol: string;
  entryOrderId: string | null;
  entryClientOrderId: string | null;
  protectionIds: readonly string[];
  signature?: ProtectionSignature;
}

export interface ProtectionCancelResult {
  status: 'NONE' | 'CANCELLED' | 'AMBIGUOUS';
  protectionIds: readonly string[];
  reason: string;
}

export interface PendingProtection {
  symbol: string;
  algoId: string;
  algoClientOrderId: string | null;
  orderId: string | null;
  side?: string | null;
  ordType?: string | null;
  state?: string | null;
  quantity?: number | null;
  slTriggerPx?: number | null;
  tpTriggerPx?: number | null;
  createdAt?: number | null;
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
  /** Authoritative order-record fill details, present when the exchange returns them. */
  fee?: number | null;
  feeCurrency?: string | null;
  tradeId?: string | null;
  fillTime?: number | null;
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
  /** Raw non-zero spot holdings until startup ownership reconciliation classifies them. */
  positions: readonly ExchangePositionSnapshot[];
  openOrders: readonly OrderStatus[];
  balances: readonly { currency: string; equity: number; available: number }[];
  recentFills: readonly { symbol: string; orderId: string; clientOrderId: string | null;
    fillId?: string; tradeId?: string | null; billId?: string | null;
    side?: 'buy' | 'sell'; quantity: number; price: number;
    fee?: number; feeCurrency?: string; timestamp: number }[];
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

/** One explicit infrastructure experiment; never an autonomous trade plan. */
export interface DemoSmokeRequest {
  symbol: string;
  quantity: number;
  quantityStep: number;
  minOrderSize: number;
  tickSize: number;
  referencePrice: number;
  feeRate: number;
  cycleId: string;
  decisionId: string;
  entryClientOrderId: string;
  protectionClientOrderId: string;
  exitClientOrderId: string;
  /** Classified immediately before the experiment by the owning agent. */
  baseline: StartupExchangeSnapshot;
}

export interface DemoSmokeExecutionResult {
  status: 'PASS' | 'REFUSED' | 'REJECTED' | 'ENTRY_NOT_ACCEPTED'
    | 'RECONCILE_REQUIRED' | 'MANUAL_RECONCILIATION_REQUIRED';
  entryState: 'NOT_SUBMITTED' | 'SUBMISSION_PENDING' | 'SUBMITTED'
    | 'PARTIALLY_FILLED' | 'FILLED' | 'RECONCILE_REQUIRED' | 'NOT_FOUND' | 'REJECTED' | 'CLOSED';
  writeDiagnostic: OkxMcpCallDiagnostic | null;
  reason: string;
  symbol: string;
  clientOrderId: string;
  orderId: string | null;
  confirmedFilledQuantity: number;
  entryAverageFillPrice: number | null;
  entryFeeAmount: number;
  entryFeeCurrency: string | null;
  netOwnedBase: number;
  protectionTest: 'PASS' | 'UNAVAILABLE';
  protectionId: string | null;
  exitOrderId: string | null;
  dustQuantity: number;
  auraManagedActivePositionCount: number;
}

export interface DemoSmokeStage {
  stage: string;
  symbol: string;
  clientOrderId: string;
  orderId?: string | null;
  quantity?: number;
  protectionId?: string | null;
  baseBalance?: number;
  quoteBalance?: number;
  openOrderIds?: readonly string[];
  recentFillOrderIds?: readonly string[];
  detail?: string;
  writeDiagnostic?: OkxMcpCallDiagnostic;
}

/** Contract only; no exchange or process behavior is implemented. */
export interface ExecutionEngine {
  /** False while exchange-side entry protection has not been verified end to end. */
  liveEntryProtectionReady?(): boolean;
  start(): Promise<void>;
  stop?(): Promise<void>;
  getWriteHealth?(): Promise<OkxConnectorHealth>;
  getWriteServerVersion?(): string | null;
  getWriteToolNames?(): readonly string[];
  getWriteTraces?(): readonly AtkToolTrace[];
  getCapabilities?(): ExecutionTools | null;
  submitApprovedOrder(plan: ApprovedOrderPlan): Promise<OrderSubmissionResult>;
  getOrderStatus(symbol: string, clientOrderId: string): Promise<OrderStatus>;
  reconcile(request: OrderRequest): Promise<ReconciliationResult>;
  getStartupSnapshot(): Promise<StartupExchangeSnapshot>;
  /** READ-lane view of pending algo protection for one symbol; null when the query tool is unavailable. */
  getPendingProtection?(symbol: string): Promise<readonly PendingProtection[] | null>;
  /** Cancels only protection linked to the given entry; one attempt, no retry, ambiguity reported. */
  cancelAttachedProtection?(link: AttachedProtectionLink): Promise<ProtectionCancelResult>;
  verifyDemoRuntime?(): Promise<boolean>;
  runDemoSmoke?(request: DemoSmokeRequest, onStage?: (stage: DemoSmokeStage) => void): Promise<DemoSmokeExecutionResult>;
}

import type { OkxConnector } from '../okx/connector.js';
import { OkxConnectorError } from '../okx/types.js';
import type { OkxMcpCallDiagnostic } from '../okx/types.js';
import { isAuraOkxClientId, isOkxClientId } from '../okx/client-id.js';
import { normalizeOkxFillIdentity } from '../okx/fill.js';
import { setTimeout as delay } from 'node:timers/promises';
import type { ApprovedOrderPlan, ProtectionPlan } from '../risk/types.js';
import { minimumDemoSmokeQuantity, roundSmokeExitDown } from './smoke-size.js';
import { discoverExecutionTools, type ExecutionTools } from './discovery.js';
import type {
  AttachedProtectionLink, DemoSmokeExecutionResult, DemoSmokeRequest, DemoSmokeStage, ExchangePositionSnapshot,
  ExecutionEngine, OrderRequest, OrderStatus,
  OrderSubmissionResult, PendingProtection, ProtectionCancelResult, ProtectionSignature, ReconciliationResult,
  StartupExchangeSnapshot,
} from './types.js';

type Row = Record<string, unknown>;
function record(value: unknown): Row | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : null;
}
function rows(value: unknown): Row[] {
  const envelope = record(value);
  if (!envelope || !Array.isArray(envelope.data)) throw new OkxConnectorError('CONNECTOR_PROTOCOL_ERROR', 'Malformed OKX tool result');
  return envelope.data.map(item => {
    const row = record(item);
    if (!row) throw new OkxConnectorError('CONNECTOR_PROTOCOL_ERROR', 'Malformed OKX row');
    return row;
  });
}
function numeric(value: unknown, fallback: number | null = null): number | null {
  if (typeof value !== 'number' && (typeof value !== 'string' || value.trim() === '')) return fallback;
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
}
function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}
function safeSmokeMessage(value: unknown): string | null {
  const message = text(value)?.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 180) ?? null;
  return message && /(?:api.?key|secret|passphrase|password|authorization|bearer|credential|token)/i.test(message)
    ? '[redacted]' : message;
}
function orderState(value: unknown): OrderStatus['state'] {
  switch (value) {
    case 'live': return 'OPEN';
    case 'partially_filled': return 'PARTIALLY_FILLED';
    case 'filled': return 'FILLED';
    case 'canceled': return 'CANCELLED';
    case 'order_failed': return 'REJECTED';
    default: return 'UNKNOWN';
  }
}
function parseOrder(row: Row, symbol: string, clientOrderId: string, cycleId = '', decisionId = ''): OrderStatus {
  if (row.instId !== symbol) throw new OkxConnectorError('CONNECTOR_PROTOCOL_ERROR', 'Order symbol mismatch');
  const size = numeric(row.sz);
  const filled = numeric(row.accFillSz, 0);
  if (size === null || size <= 0 || filled === null || filled < 0 || filled > size) {
    throw new OkxConnectorError('CONNECTOR_PROTOCOL_ERROR', 'Invalid order size');
  }
  const clOrdId = text(row.clOrdId) ?? clientOrderId;
  return {
    symbol, clientOrderId: clOrdId, cycleId, decisionId,
    exchangeOrderId: text(row.ordId), state: orderState(row.state),
    requestedQuantity: size, filledQuantity: filled,
    averageFillPrice: numeric(row.avgPx), updatedAt: numeric(row.uTime, Date.now())!,
    fee: numeric(row.fee), feeCurrency: text(row.feeCcy), tradeId: text(row.tradeId),
    fillTime: numeric(row.fillTime),
  };
}
function baseCurrency(symbol: string): string | null {
  const match = /^([A-Z0-9]+)-([A-Z0-9]+)$/.exec(symbol);
  return match?.[1] ?? null;
}
interface SmokeFill {
  orderId: string;
  fillId: string;
  side: 'buy' | 'sell';
  quantity: number;
  price: number;
  fee: number;
  feeCurrency: string;
}
function smokeIdentityMatches(row: Row, symbol: string, clientOrderId: string,
  orderId: string | null): boolean {
  if (row.instId !== symbol) return false;
  const client = text(row.clOrdId), exchange = text(row.ordId);
  if (client !== clientOrderId && (!orderId || exchange !== orderId)) return false;
  if ((client && client !== clientOrderId) || (orderId && exchange && exchange !== orderId)) {
    throw new Error('Contradictory smoke order and client identifiers');
  }
  return true;
}
function parseSmokeFill(row: Row, request: DemoSmokeRequest, clientOrderId: string,
  orderId: string | null, expectedSide: 'buy' | 'sell'): SmokeFill {
  if (!smokeIdentityMatches(row, request.symbol, clientOrderId, orderId)) {
    throw new Error('Smoke fill identity cannot be verified');
  }
  const exchangeOrderId = text(row.ordId);
  const quantity = numeric(row.fillSz);
  const price = numeric(row.fillPx) ?? (row.state === 'filled' ? numeric(row.avgPx) : null);
  const fee = numeric(row.fee);
  const feeCurrency = text(row.feeCcy);
  const { fillId } = normalizeOkxFillIdentity(row);
  if (!fillId || !exchangeOrderId || (row.side != null && row.side !== expectedSide)
    || quantity === null || quantity <= 0 || price === null || price <= 0
    || fee === null || !feeCurrency
    || ![baseCurrency(request.symbol), 'USDT'].includes(feeCurrency)) {
    throw new Error('Smoke fill identity, quantity, or fee cannot be verified');
  }
  return { orderId: exchangeOrderId, fillId, side: expectedSide,
    quantity, price, fee, feeCurrency };
}
const approximately = (a: number, b: number, tolerance = 1e-9): boolean =>
  Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tolerance;
function alignToTick(value: number, tick: number | undefined, mode: 'down' | 'up'): number {
  if (!tick || !Number.isFinite(tick) || tick <= 0) return value;
  const units = value / tick;
  const rounded = mode === 'down' ? Math.floor(units + 1e-9) : Math.ceil(units - 1e-9);
  return Number((rounded * tick).toPrecision(15));
}
/** Exact SL/TP triggers derived from a protection plan; entry payload, verification, and cleanup all use this. */
export function protectionTriggers(protection: ProtectionPlan, tickSize?: number): { sl: number; tp: number } {
  const reference = protection.initialStopPrice + protection.stopDistanceAbsolute;
  return { sl: protection.initialStopPrice,
    tp: alignToTick(reference + protection.stopDistanceAbsolute * protection.takeProfitR, tickSize, 'down') };
}
/** The exact take-profit trigger sent with a live entry; verification compares against the same value. */
export function takeProfitTrigger(plan: ApprovedOrderPlan): number {
  return protectionTriggers(plan.protection, plan.tickSize).tp;
}
/**
 * Conservative correlation of a pending algo row with one AURA entry: exact stop and
 * take-profit triggers, a protected quantity equal to the entry (within fee and lot
 * rounding), a live sell-side TP/SL algo, created no earlier than the entry.
 */
export function protectionSignatureMatches(row: { side?: string | null; ordType?: string | null; state?: string | null;
  quantity?: number | null; slTriggerPx?: number | null; tpTriggerPx?: number | null; createdAt?: number | null },
signature: ProtectionSignature): boolean {
  if (row.side != null && row.side !== 'sell') return false;
  if (row.ordType != null && row.ordType !== 'oco' && row.ordType !== 'conditional') return false;
  if (row.state != null && row.state !== 'live' && row.state !== 'pending' && row.state !== 'effective') return false;
  if (row.slTriggerPx == null || row.slTriggerPx !== signature.slTriggerPx) return false;
  if (signature.tpTriggerPx !== null && row.tpTriggerPx != null && row.tpTriggerPx !== signature.tpTriggerPx) return false;
  if (row.quantity != null && (row.quantity <= 0 || row.quantity > signature.quantity * (1 + 1e-6)
    || row.quantity < signature.quantity * 0.99)) return false;
  if (signature.notBefore !== null && row.createdAt != null && row.createdAt < signature.notBefore) return false;
  return true;
}
function pendingProtectionRow(row: Row, symbol: string): PendingProtection | null {
  const algoId = text(row.algoId);
  if (row.instId !== symbol || algoId === null) return null;
  return { symbol, algoId, algoClientOrderId: text(row.algoClOrdId), orderId: text(row.ordId),
    side: text(row.side), ordType: text(row.ordType), state: text(row.state), quantity: numeric(row.sz),
    slTriggerPx: numeric(row.slTriggerPx), tpTriggerPx: numeric(row.tpTriggerPx), createdAt: numeric(row.cTime) };
}
function validPlan(plan: ApprovedOrderPlan): boolean {
  return !!plan && !!plan.protection && !!baseCurrency(plan.symbol) && (plan.side === 'BUY' || plan.side === 'SELL')
    && Number.isFinite(plan.quantity) && plan.quantity > 0
    && Number.isFinite(plan.referencePrice) && plan.referencePrice > 0
    && Number.isFinite(plan.estimatedNotional) && plan.estimatedNotional > 0
    && Math.abs(plan.quantity * plan.referencePrice - plan.estimatedNotional)
      <= Math.max(1e-8, plan.estimatedNotional * 1e-8)
    && isOkxClientId(plan.clientOrderId)
    && !!plan.cycleId && !!plan.decisionId
    && plan.protection.symbol === plan.symbol
    && Number.isFinite(plan.protection.initialStopPrice)
    && plan.protection.initialStopPrice > 0
    && Number.isFinite(plan.protection.stopDistanceAbsolute)
    && plan.protection.stopDistanceAbsolute > 0
    && (plan.side !== 'BUY' || (plan.protection.initialStopPrice < plan.referencePrice
      && Math.abs(plan.referencePrice - plan.protection.initialStopPrice - plan.protection.stopDistanceAbsolute) < 1e-8
      && Math.abs(plan.protection.stopDistanceFraction
        - plan.protection.stopDistanceAbsolute / plan.referencePrice) < 1e-10))
    && Number.isFinite(plan.protection.takeProfitR)
    && plan.protection.takeProfitR > 0;
}

/** Inert until start(); all exchange activity uses the injected official MCP connector. */
export class OkxExecutionEngine implements ExecutionEngine {
  private tools: ExecutionTools | null = null;
  private readonly attemptedClientOrderIds = new Set<string>();
  private readonly reservedSellQuantity = new Map<string, number>();

  /**
   * Human attestation (LIVE_ENTRY_PROTECTION_VERIFIED=true) that the production attached
   * TP/SL path was proven end to end on demo. Default false: live BUY entries are impossible;
   * protective SELL exits for managed positions stay available.
   */
  liveEntryProtectionReady(): boolean { return this.liveEntryProtectionVerified; }

  constructor(
    private readonly connector: OkxConnector,
    private readonly trackedSymbols: readonly string[] = ['BTC-USDT', 'ETH-USDT'],
    private readonly now: () => number = Date.now,
    private readonly readConnector: OkxConnector = connector,
    private readonly demoSmokeArmFlagExplicitlyFalse = false,
    private readonly liveEntryProtectionVerified = false,
  ) {}

  async start(): Promise<void> {
    if (this.readConnector !== this.connector && (this.readConnector.lane !== 'READ'
      || this.readConnector.readOnly !== true || this.connector.lane !== 'WRITE'
      || this.connector.readOnly === true || this.readConnector.profile !== this.connector.profile)) {
      throw new OkxConnectorError('PROFILE_CONFIGURATION_ERROR', 'Execution requires isolated read-only READ and spot WRITE lanes');
    }
    await this.readConnector.connect();
    await this.connector.connect();
    const [readTools, writeTools] = await Promise.all([this.readConnector.listTools(), this.connector.listTools()]);
    if (this.readConnector !== this.connector && !writeTools.some(tool => tool.name === 'spot_place_order')) {
      throw new OkxConnectorError('TOOL_NOT_AVAILABLE', 'WRITE lane lacks spot order placement');
    }
    const readQueries = readTools.filter(tool => tool.name.startsWith('spot_get_')
      || tool.name.startsWith('account_get_'));
    const writeActions = writeTools.filter(tool => tool.name === 'spot_place_order'
      || tool.name === 'spot_place_algo_order' || tool.name === 'spot_cancel_order'
      || tool.name === 'spot_cancel_algo_order');
    this.tools = discoverExecutionTools([...readQueries, ...writeActions]);
  }

  async stop(): Promise<void> { await this.connector.disconnect(); }
  async getWriteHealth() { return this.connector.healthCheck(); }
  getWriteServerVersion(): string | null { return this.connector.getServerVersion?.() ?? null; }
  getWriteToolNames(): readonly string[] { return this.connector.getCapabilities?.().names() ?? []; }
  getWriteTraces() { return this.connector.getRecentTraces?.() ?? []; }

  getCapabilities(): ExecutionTools | null {
    return this.tools ? { ...this.tools } : null;
  }

  private connected(): boolean {
    return this.tools !== null && this.connector.isConnected() && this.readConnector.isConnected();
  }

  /** Server-reported demo mode is checked on both independent MCP sessions. */
  async verifyDemoRuntime(): Promise<boolean> {
    if (!this.demoSmokeArmFlagExplicitlyFalse || !this.connected() || this.readConnector === this.connector
      || this.readConnector.lane !== 'READ' || this.readConnector.readOnly !== true
      || this.connector.lane !== 'WRITE' || this.connector.readOnly === true
      || this.readConnector.profile !== 'demo' || this.connector.profile !== 'demo') return false;
    try {
      const [readTools, writeTools] = await Promise.all([this.readConnector.listTools(), this.connector.listTools()]);
      if (!readTools.some(tool => tool.name === 'system_get_capabilities')
        || !writeTools.some(tool => tool.name === 'system_get_capabilities')) return false;
      const [read, write] = await Promise.all([
        this.readConnector.callTool<unknown>('system_get_capabilities', {}),
        this.connector.callTool<unknown>('system_get_capabilities', {}),
      ]);
      const readCapabilities = record(record(read)?.capabilities);
      const writeCapabilities = record(record(write)?.capabilities);
      return readCapabilities?.demo === true && readCapabilities.readOnly === true
        && writeCapabilities?.demo === true && writeCapabilities.readOnly === false;
    } catch { return false; }
  }

  private async smokeFills(request: DemoSmokeRequest, clientOrderId: string,
    orderId: string | null, expectedSide: 'buy' | 'sell'): Promise<SmokeFill[]> {
    const tool = this.tools?.getFills;
    if (!tool) throw new Error('Smoke fill query unavailable');
    const found = rows(await this.readConnector.callTool(tool,
      { instId: request.symbol, archive: false },
      { cycleId: request.cycleId, decisionId: request.decisionId }));
    const fills = new Map<string, SmokeFill>();
    for (const row of found) {
      if (!smokeIdentityMatches(row, request.symbol, clientOrderId, orderId)) continue;
      const fill = parseSmokeFill(row, request, clientOrderId, orderId, expectedSide);
      const previous = fills.get(fill.fillId);
      if (previous && JSON.stringify(previous) !== JSON.stringify(fill)) {
        throw new Error('Conflicting records for the same smoke fill');
      }
      fills.set(fill.fillId, fill);
    }
    return [...fills.values()];
  }

  private async smokeEvidence(request: DemoSmokeRequest, clientOrderId: string,
    orderId: string | null, side: 'buy' | 'sell'): Promise<{ order: OrderStatus | null; fills: SmokeFill[] }> {
    let order: OrderStatus | null = null;
    let orderRow: Row | null = null;
    let resolvedOrderId = orderId;
    const fills = new Map<string, SmokeFill>();
    if (!this.tools?.getOrders || !this.tools.getFills) {
      throw new Error('Smoke order-history or fill query unavailable');
    }
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const candidates: Row[] = [];
      if (this.tools.getOrder) {
        for (const lookup of [
          ...(resolvedOrderId ? [{ instId: request.symbol, ordId: resolvedOrderId }] : []),
          { instId: request.symbol, clOrdId: clientOrderId },
        ]) {
          try {
            candidates.push(...rows(await this.readConnector.callTool(this.tools.getOrder, lookup,
              { cycleId: request.cycleId, decisionId: request.decisionId })));
          } catch { /* Direct not-found errors are common; listings and fills still reconcile. */ }
        }
      }
      candidates.push(...await this.queryOrders(request.symbol, 'open'));
      candidates.push(...await this.queryOrders(request.symbol, 'history'));
      for (const row of candidates) {
        if (!smokeIdentityMatches(row, request.symbol, clientOrderId, resolvedOrderId)) continue;
        if (row.side != null && row.side !== side) throw new Error('Smoke order side mismatch');
        const parsed = parseOrder(row, request.symbol, clientOrderId);
        if (resolvedOrderId && parsed.exchangeOrderId && parsed.exchangeOrderId !== resolvedOrderId) {
          throw new Error('Conflicting smoke order IDs');
        }
        resolvedOrderId = parsed.exchangeOrderId ?? resolvedOrderId;
        if (!order || order.state !== 'FILLED' || parsed.state === 'FILLED') {
          order = parsed;
          orderRow = row;
        }
      }
      const observedFills = await this.smokeFills(request, clientOrderId,
        resolvedOrderId, side);
      for (const fill of observedFills) {
        if (resolvedOrderId && fill.orderId !== resolvedOrderId) {
          throw new Error('Fill and order IDs conflict');
        }
        resolvedOrderId = fill.orderId;
        const previous = fills.get(fill.fillId);
        if (previous && JSON.stringify(previous) !== JSON.stringify(fill)) {
          throw new Error('Conflicting records for the same smoke fill');
        }
        fills.set(fill.fillId, fill);
      }
      const filled = [...fills.values()].reduce((sum, fill) => sum + fill.quantity, 0);
      if (order?.state === 'FILLED' && filled > 0
        && approximately(filled, order.filledQuantity, request.quantityStep / 10)) break;
      if (order?.state === 'CANCELLED' || order?.state === 'REJECTED') break;
      if (attempt < 3) await delay(350);
    }
    if (fills.size === 0 && order?.state === 'FILLED' && orderRow
      && approximately(numeric(orderRow.fillSz) ?? NaN,
        order.filledQuantity, request.quantityStep / 10)) {
      const summary = parseSmokeFill(orderRow, request, clientOrderId,
        resolvedOrderId, side);
      fills.set(summary.fillId, summary);
    }
    return { order, fills: [...fills.values()] };
  }

  private async smokePlace(request: DemoSmokeRequest, side: 'buy' | 'sell',
    quantity: number, clientOrderId: string): Promise<{ attempted: boolean; rejected: boolean;
      orderId: string | null; ambiguous: boolean; diagnostic: OkxMcpCallDiagnostic | null }> {
    const empty = { attempted: false, rejected: false, orderId: null,
      ambiguous: false, diagnostic: null };
    if (!this.tools?.placeOrder || this.attemptedClientOrderIds.has(clientOrderId)) return empty;
    try { await this.getOrderStatus(request.symbol, clientOrderId); return empty; }
    catch (error) {
      if (!(error instanceof OkxConnectorError) || error.category !== 'TOOL_NOT_AVAILABLE') return empty;
    }
    if (!await this.verifyDemoRuntime()) return empty;
    this.attemptedClientOrderIds.add(clientOrderId);
    let response: unknown;
    const started = Date.now();
    try {
      response = await this.connector.callTool(this.tools.placeOrder, {
        instId: request.symbol, tdMode: 'cash', side, ordType: 'market',
        sz: String(quantity), tgtCcy: 'base_ccy', clOrdId: clientOrderId,
      }, { cycleId: request.cycleId, decisionId: request.decisionId });
    } catch (error) {
      const diagnostic = error instanceof OkxConnectorError && error.diagnostic
        ? error.diagnostic : { toolName: this.tools.placeOrder, isError: null,
          exchangeCode: null, exchangeMessage: null, returnedOrderId: null,
          returnedClientOrderId: null, latencyMs: Math.max(0, Date.now() - started),
          schemaParsed: false };
      return { attempted: true, rejected: diagnostic.exchangeCode !== null
        && diagnostic.exchangeCode !== '0', orderId: diagnostic.returnedOrderId,
        ambiguous: diagnostic.exchangeCode === null || diagnostic.exchangeCode === '0', diagnostic };
    }
    try {
      const acknowledgements = rows(response);
      if (acknowledgements.length !== 1) throw new Error('Invalid smoke acknowledgement');
      const ack = acknowledgements[0]!;
      const orderId = text(ack.ordId);
      const diagnostic: OkxMcpCallDiagnostic = { toolName: this.tools.placeOrder,
        isError: false, exchangeCode: ack.sCode == null ? null : String(ack.sCode),
        exchangeMessage: safeSmokeMessage(ack.sMsg), returnedOrderId: orderId,
        returnedClientOrderId: text(ack.clOrdId),
        latencyMs: Math.max(0, Date.now() - started), schemaParsed: true };
      if (ack.sCode !== '0' && ack.sCode !== 0) {
        return { attempted: true, rejected: true, orderId, ambiguous: false, diagnostic };
      }
      return { attempted: true, rejected: false, orderId,
        ambiguous: !orderId || text(ack.clOrdId) !== clientOrderId, diagnostic };
    } catch { return { attempted: true, rejected: false, orderId: null, ambiguous: true,
      diagnostic: { toolName: this.tools.placeOrder, isError: false,
        exchangeCode: null, exchangeMessage: null, returnedOrderId: null,
        returnedClientOrderId: null, latencyMs: Math.max(0, Date.now() - started),
        schemaParsed: false } }; }
  }

  private async smokeAlgoRows(request: DemoSmokeRequest, status: 'pending' | 'history',
    ordType?: 'conditional' | 'oco'): Promise<Row[]> {
    if (!this.tools?.getAlgoOrders) throw new Error('Smoke protection query unavailable');
    // ATK's algo history defaults to state=effective (triggered); a cancelled
    // protection is only visible when state=canceled is requested explicitly.
    return rows(await this.readConnector.callTool(this.tools.getAlgoOrders,
      { status, instId: request.symbol, ...(ordType ? { ordType } : {}),
        ...(status === 'history' ? { state: 'canceled' } : {}) },
      { cycleId: request.cycleId, decisionId: request.decisionId }));
  }

  private async smokeProtection(request: DemoSmokeRequest, quantity: number, entryPrice: number,
    onStage: (stage: DemoSmokeStage) => void): Promise<{ status: 'PASS' | 'UNAVAILABLE' | 'MANUAL'; id: string | null }> {
    const tools = this.tools!;
    if (!tools.conditionalProtectionSupported || !tools.algoClientOrderIdSupported || !tools.placeAlgoOrder
      || !tools.getAlgoOrders || !tools.cancelAlgoOrder) return { status: 'UNAVAILABLE', id: null };
    const anchor = Math.min(request.referencePrice, entryPrice);
    const stop = Number((Math.floor(anchor * 0.5 / request.tickSize)
      * request.tickSize).toPrecision(15));
    if (!Number.isFinite(anchor) || anchor <= 0 || !Number.isFinite(stop)
      || stop <= 0 || stop >= anchor * 0.75
      || !await this.verifyDemoRuntime()) return { status: 'MANUAL', id: null };
    let id: string | null = null;
    try {
      const response = await this.connector.callTool(tools.placeAlgoOrder, {
        instId: request.symbol, tdMode: 'cash', side: 'sell', ordType: 'conditional',
        sz: String(quantity), slTriggerPx: String(stop), slOrdPx: '-1',
        algoClOrdId: request.protectionClientOrderId,
      }, { cycleId: request.cycleId, decisionId: request.decisionId });
      const acknowledgements = rows(response);
      if (acknowledgements.length !== 1) throw new Error('Ambiguous protection acknowledgement');
      const ack = acknowledgements[0]!;
      if (ack.sCode !== '0' && ack.sCode !== 0) return { status: 'UNAVAILABLE', id: null };
      id = text(ack.algoId);
    } catch {
      // A failed MCP call may still have submitted the protection. Query by
      // its unique client ID; do not make another placement attempt.
    }
    let found: Row | null = null;
    try {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const pending = await this.smokeAlgoRows(request, 'pending');
        found = pending.find(row => row.instId === request.symbol
          && (row.algoClOrdId === request.protectionClientOrderId
            || (!!id && row.algoId === id))) ?? null;
        if (found) break;
        if (attempt < 3) await delay(350);
      }
    } catch { return { status: 'MANUAL', id }; }
    if (!found) return { status: 'MANUAL', id };
    id = text(found.algoId) ?? id;
    if (!id) return { status: 'MANUAL', id: null };
    onStage({ stage: 'PROTECTION_FOUND', symbol: request.symbol,
      clientOrderId: request.protectionClientOrderId, protectionId: id, quantity });
    const verified = approximately(numeric(found.sz) ?? NaN, quantity, request.quantityStep / 10)
      && (found.state === 'live' || found.state === 'pending' || found.state == null);
    // Even an unverified known protection must be removed before any cleanup SELL.
    if (!await this.verifyDemoRuntime()) return { status: 'MANUAL', id };
    let cancelAcknowledged = false;
    try {
      const cancellation = rows(await this.connector.callTool(tools.cancelAlgoOrder,
        { instId: request.symbol, algoId: id },
        { cycleId: request.cycleId, decisionId: request.decisionId }));
      cancelAcknowledged = cancellation.length === 1
        && cancellation[0]?.algoId === id
        && (cancellation[0]?.sCode === '0' || cancellation[0]?.sCode === 0);
    } catch { /* The cancellation may have landed; query before deciding. */ }
    const baselineFillIds = new Set(request.baseline.recentFills.map(fill => fill.fillId).filter(Boolean));
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        const [pending, conditionalPending, history, fillResponse] = await Promise.all([
          this.smokeAlgoRows(request, 'pending'),
          this.smokeAlgoRows(request, 'pending', 'conditional'),
          this.smokeAlgoRows(request, 'history'),
          this.readConnector.callTool(tools.getFills!, { instId: request.symbol, archive: false }),
        ]);
        const active = [...pending, ...conditionalPending].some(row => row.instId === request.symbol
          && (row.algoId === id || row.algoClOrdId === request.protectionClientOrderId));
        const canceled = history.some(row => row.instId === request.symbol
          && (row.algoId === id || row.algoClOrdId === request.protectionClientOrderId)
          && (row.state === 'canceled' || row.state === 'cancelled'));
        const newSell = rows(fillResponse).some(row => row.instId === request.symbol
          && row.side === 'sell' && !baselineFillIds.has(normalizeOkxFillIdentity(row).fillId));
        if (!active && !newSell && (canceled || (cancelAcknowledged && attempt === 3))) {
          onStage({ stage: 'PROTECTION_CANCELLED', symbol: request.symbol,
            clientOrderId: request.protectionClientOrderId, protectionId: id, quantity });
          return { status: verified ? 'PASS' : 'UNAVAILABLE', id };
        }
      } catch { /* Another bounded read may still reconcile the cancellation. */ }
      if (attempt < 3) await delay(350);
    }
    return { status: 'MANUAL', id };
  }

  async runDemoSmoke(request: DemoSmokeRequest,
    onStage: (stage: DemoSmokeStage) => void = () => undefined): Promise<DemoSmokeExecutionResult> {
    const result: DemoSmokeExecutionResult = {
      status: 'REFUSED', entryState: 'NOT_SUBMITTED', writeDiagnostic: null,
      reason: 'Demo smoke has not started', symbol: request.symbol,
      clientOrderId: request.entryClientOrderId, orderId: null,
      confirmedFilledQuantity: 0, entryAverageFillPrice: null,
      entryFeeAmount: 0, entryFeeCurrency: null, netOwnedBase: 0,
      protectionTest: 'UNAVAILABLE', protectionId: null, exitOrderId: null,
      dustQuantity: 0, auraManagedActivePositionCount: 0,
    };
    const emit = (stage: DemoSmokeStage): void => { try { onStage(stage); } catch { /* Observability cannot alter execution. */ } };
    const finish = (status: DemoSmokeExecutionResult['status'], reason: string): DemoSmokeExecutionResult => {
      result.status = status; result.reason = reason;
      emit({ stage: status, symbol: request.symbol, clientOrderId: request.entryClientOrderId,
        orderId: result.orderId, quantity: result.confirmedFilledQuantity,
        protectionId: result.protectionId, detail: reason });
      return { ...result };
    };
    if (!request || !this.trackedSymbols.includes(request.symbol) || !request.symbol.endsWith('-USDT')
      || !isAuraOkxClientId(request.entryClientOrderId, 'SMOKE')
      || !isAuraOkxClientId(request.protectionClientOrderId, 'PROT')
      || !isAuraOkxClientId(request.exitClientOrderId, 'EXIT')
      || !/^AURA-SMOKE-[A-Za-z0-9-]+C$/.test(request.cycleId)
      || !/^AURA-SMOKE-[A-Za-z0-9-]+D$/.test(request.decisionId)
      || new Set([request.cycleId, request.decisionId, request.entryClientOrderId,
        request.protectionClientOrderId, request.exitClientOrderId]).size !== 5
      || request.baseline.profile !== 'demo' || request.baseline.openOrders.length !== 0
      || !Number.isFinite(request.referencePrice) || request.referencePrice <= 0
      || !Number.isFinite(request.tickSize) || request.tickSize <= 0
      || !Number.isFinite(request.quantity) || request.quantity <= 0) {
      return finish('REFUSED', 'Invalid or non-demo smoke request');
    }
    if (!await this.verifyDemoRuntime()) return finish('REFUSED', 'Both MCP servers must confirm demo mode');
    const base = baseCurrency(request.symbol)!;
    const baselineBase = request.baseline.balances.find(item => item.currency === base)?.equity ?? 0;
    const baselineQuote = request.baseline.balances.find(item => item.currency === 'USDT')?.available ?? 0;
    const expectedMinimum = minimumDemoSmokeQuantity({ symbol: request.symbol, instrumentId: request.symbol,
      minOrderSize: request.minOrderSize, quantityStep: request.quantityStep, tickSize: request.tickSize },
    request.feeRate, request.referencePrice, baselineQuote);
    if (expectedMinimum === null || !approximately(request.quantity, expectedMinimum, request.quantityStep / 10)) {
      return finish('REFUSED', 'Smoke quantity is not the minimum fee-safe executable size');
    }
    let before: StartupExchangeSnapshot;
    try { before = await this.getStartupSnapshot(); }
    catch { return finish('REFUSED', 'Immediate pre-smoke exchange snapshot unavailable'); }
    const beforeBase = before.balances.find(item => item.currency === base)?.equity ?? 0;
    const beforeQuote = before.balances.find(item => item.currency === 'USDT')?.available ?? 0;
    const allCurrencies = new Set([...before.balances, ...request.baseline.balances]
      .map(balance => balance.currency));
    const inventoryUnchanged = [...allCurrencies].every(currency => {
      const prior = request.baseline.balances.find(item => item.currency === currency);
      const latest = before.balances.find(item => item.currency === currency);
      return approximately(prior?.equity ?? 0, latest?.equity ?? 0, 1e-9)
        && approximately(prior?.available ?? 0, latest?.available ?? 0, 1e-9);
    });
    const fillIdentity = (snapshot: StartupExchangeSnapshot): string[] => snapshot.recentFills
      .map(fill => `${fill.symbol}|${fill.orderId}|${fill.clientOrderId ?? ''}|${fill.quantity}|${fill.price}|${fill.timestamp}`)
      .sort();
    if (before.profile !== 'demo' || before.openOrders.length !== 0
      || !inventoryUnchanged
      || JSON.stringify(fillIdentity(before)) !== JSON.stringify(fillIdentity(request.baseline))
      || !approximately(beforeBase, baselineBase, request.quantityStep / 10)
      || !approximately(beforeQuote, baselineQuote, 1e-6)) {
      return finish('REFUSED', 'Exchange inventory or orders changed after ownership check');
    }
    emit({ stage: 'BASELINE_RECORDED', symbol: request.symbol,
      clientOrderId: request.entryClientOrderId, baseBalance: beforeBase,
      quoteBalance: beforeQuote,
      openOrderIds: before.openOrders.filter(order => order.symbol === request.symbol)
        .map(order => order.exchangeOrderId ?? order.clientOrderId),
      recentFillOrderIds: before.recentFills.filter(fill => fill.symbol === request.symbol)
        .map(fill => fill.orderId) });
    emit({ stage: 'ENTRY_INTENT', symbol: request.symbol, clientOrderId: request.entryClientOrderId,
      quantity: request.quantity, detail: `Approximate demo notional ${request.quantity * request.referencePrice} USDT` });
    const entry = await this.smokePlace(request, 'buy', request.quantity, request.entryClientOrderId);
    result.writeDiagnostic = entry.diagnostic;
    if (entry.attempted) {
      result.entryState = entry.ambiguous ? 'SUBMISSION_PENDING' : 'SUBMITTED';
      if (entry.diagnostic) emit({ stage: 'ENTRY_WRITE_RESULT', symbol: request.symbol,
        clientOrderId: request.entryClientOrderId, orderId: entry.orderId,
        writeDiagnostic: entry.diagnostic });
    }
    if (!entry.attempted) return finish('REFUSED', 'Entry identity lookup or demo guard refused placement');
    if (entry.rejected) {
      if (entry.orderId) {
        result.orderId = entry.orderId;
        result.entryState = 'RECONCILE_REQUIRED';
        return finish('MANUAL_RECONCILIATION_REQUIRED',
          'Exchange rejection also returned an order ID; ownership is contradictory');
      }
      result.entryState = 'REJECTED';
      return finish('REJECTED', `Exchange rejected demo entry${entry.diagnostic?.exchangeCode
        ? ` (${entry.diagnostic.exchangeCode})` : ''}${entry.diagnostic?.exchangeMessage
        ? `: ${entry.diagnostic.exchangeMessage}` : ''}`);
    }
    result.orderId = entry.orderId;
    emit({ stage: entry.ambiguous ? 'ENTRY_AMBIGUOUS' : 'ENTRY_ACKNOWLEDGED',
      symbol: request.symbol, clientOrderId: request.entryClientOrderId, orderId: entry.orderId,
      quantity: request.quantity });
    try {
      const evidence = await this.smokeEvidence(request, request.entryClientOrderId, entry.orderId, 'buy');
      const filled = evidence.fills.reduce((sum, fill) => sum + fill.quantity, 0);
      result.confirmedFilledQuantity = filled;
      result.auraManagedActivePositionCount = filled > 0 ? 1 : 0;
      result.orderId = evidence.order?.exchangeOrderId ?? result.orderId;
      result.entryState = filled > 0
        ? (evidence.order?.state === 'FILLED' ? 'FILLED' : 'PARTIALLY_FILLED')
        : evidence.order ? 'SUBMITTED' : 'RECONCILE_REQUIRED';
      if (evidence.order?.state === 'CANCELLED' || evidence.order?.state === 'REJECTED') {
        if (evidence.fills.length === 0) {
          result.entryState = evidence.order.state === 'REJECTED' ? 'REJECTED' : 'NOT_FOUND';
          return finish(evidence.order.state === 'REJECTED' ? 'REJECTED' : 'ENTRY_NOT_ACCEPTED',
            'Demo entry definitively closed without a fill');
        }
      }
      if (!evidence.order && filled === 0 && !entry.orderId) {
        const afterNoEntry = await this.getStartupSnapshot();
        const afterBase = afterNoEntry.balances.find(item => item.currency === base)?.equity ?? 0;
        const afterQuote = afterNoEntry.balances.find(item => item.currency === 'USDT')?.available ?? 0;
        if (afterNoEntry.profile === 'demo' && afterNoEntry.openOrders.length === 0
          && afterNoEntry.recentFills.every(fill => fill.clientOrderId !== request.entryClientOrderId)
          && JSON.stringify(fillIdentity(afterNoEntry)) === JSON.stringify(fillIdentity(before))
          && approximately(afterBase, beforeBase, request.quantityStep / 10)
          && approximately(afterQuote, beforeQuote, 1e-6)) {
          result.entryState = 'NOT_FOUND';
          return finish('ENTRY_NOT_ACCEPTED',
            'No matching order or fill after bounded reconciliation; balances unchanged');
        }
        return finish('MANUAL_RECONCILIATION_REQUIRED',
          'No order identity, but balance, fills, or open orders changed');
      }
      if (evidence.order?.state !== 'FILLED' || !evidence.order.exchangeOrderId
        || evidence.order.clientOrderId !== request.entryClientOrderId
        || !approximately(filled, evidence.order.filledQuantity, request.quantityStep / 10)
        || !approximately(filled, request.quantity, request.quantityStep / 10)
        || evidence.fills.some(fill => fill.orderId !== evidence.order!.exchangeOrderId)) {
        return finish('RECONCILE_REQUIRED', 'Entry order and fills are not conclusively reconciled');
      }
      result.orderId = evidence.order.exchangeOrderId;
      result.confirmedFilledQuantity = filled;
      result.entryAverageFillPrice = evidence.fills.reduce((sum, fill) => sum + fill.price * fill.quantity, 0) / filled;
      result.entryFeeAmount = evidence.fills.reduce((sum, fill) => sum + Math.abs(fill.fee), 0);
      const currencies = [...new Set(evidence.fills.map(fill => fill.feeCurrency))];
      result.entryFeeCurrency = currencies.length === 1 ? currencies[0]! : 'MIXED';
      const baseFees = evidence.fills.reduce((sum, fill) => sum
        + (fill.feeCurrency === base ? Math.abs(fill.fee) : 0), 0);
      result.netOwnedBase = filled - baseFees;
      if (!Number.isFinite(result.netOwnedBase) || result.netOwnedBase <= 0) {
        return finish('MANUAL_RECONCILIATION_REQUIRED', 'Entry fee consumed or obscured smoke-owned base');
      }
      emit({ stage: 'ENTRY_FILLED', symbol: request.symbol, clientOrderId: request.entryClientOrderId,
        orderId: result.orderId, quantity: result.netOwnedBase });
      const afterEntry = await this.getStartupSnapshot();
      const afterBase = afterEntry.balances.find(item => item.currency === base)?.equity ?? 0;
      if (afterEntry.profile !== 'demo' || afterEntry.openOrders.some(order =>
        order.clientOrderId === request.entryClientOrderId)
        || afterBase - beforeBase + request.quantityStep / 10 < result.netOwnedBase) {
        return finish('MANUAL_RECONCILIATION_REQUIRED', 'Entry balance delta or open-order state is inconsistent');
      }
      const sellQuantity = roundSmokeExitDown(result.netOwnedBase, request.quantityStep);
      if (sellQuantity + request.quantityStep / 10 < request.minOrderSize) {
        result.dustQuantity = result.netOwnedBase;
        return finish('MANUAL_RECONCILIATION_REQUIRED', 'Smoke-owned base is below the minimum safe cleanup size');
      }
      const protection = await this.smokeProtection(request, sellQuantity,
        result.entryAverageFillPrice!, emit);
      result.protectionTest = protection.status === 'PASS' ? 'PASS' : 'UNAVAILABLE';
      result.protectionId = protection.id;
      if (protection.status === 'MANUAL') {
        return finish('MANUAL_RECONCILIATION_REQUIRED', 'Smoke protection could not be safely reconciled and removed');
      }
      emit({ stage: 'PROTECTION_TEST', symbol: request.symbol,
        clientOrderId: request.protectionClientOrderId, protectionId: result.protectionId,
        detail: result.protectionTest });
      const beforeExit = await this.getStartupSnapshot();
      const availableBase = beforeExit.balances.find(item => item.currency === base)?.available ?? 0;
      const totalBase = beforeExit.balances.find(item => item.currency === base)?.equity ?? 0;
      if (beforeExit.profile !== 'demo' || beforeExit.openOrders.length > 0
        || availableBase + request.quantityStep / 10 < sellQuantity
        || totalBase - beforeBase + request.quantityStep / 10 < result.netOwnedBase
        || !await this.verifyDemoRuntime()) {
        return finish('MANUAL_RECONCILIATION_REQUIRED', 'Owned balance or demo guard changed before cleanup');
      }
      emit({ stage: 'EXIT_INTENT', symbol: request.symbol,
        clientOrderId: request.exitClientOrderId, quantity: sellQuantity });
      const exit = await this.smokePlace(request, 'sell', sellQuantity, request.exitClientOrderId);
      if (!exit.attempted || exit.rejected) {
        return finish('MANUAL_RECONCILIATION_REQUIRED', 'One intended cleanup SELL was refused or rejected');
      }
      result.exitOrderId = exit.orderId;
      const exitEvidence = await this.smokeEvidence(request, request.exitClientOrderId, exit.orderId, 'sell');
      const sold = exitEvidence.fills.reduce((sum, fill) => sum + fill.quantity, 0);
      if (exitEvidence.order?.state !== 'FILLED' || !exitEvidence.order.exchangeOrderId
        || exitEvidence.order.clientOrderId !== request.exitClientOrderId
        || !approximately(sold, sellQuantity, request.quantityStep / 10)
        || !approximately(sold, exitEvidence.order.filledQuantity, request.quantityStep / 10)
        || exitEvidence.fills.some(fill => fill.orderId !== exitEvidence.order!.exchangeOrderId)) {
        return finish('MANUAL_RECONCILIATION_REQUIRED', 'Cleanup SELL outcome is ambiguous; no retry permitted');
      }
      result.exitOrderId = exitEvidence.order.exchangeOrderId;
      const exitBaseFees = exitEvidence.fills.reduce((sum, fill) => sum
        + (fill.feeCurrency === base ? Math.max(0, -fill.fee) : 0), 0);
      const remainder = result.netOwnedBase - sold - exitBaseFees;
      if (remainder < -request.quantityStep / 10) {
        return finish('MANUAL_RECONCILIATION_REQUIRED', 'Cleanup appears to have consumed unrelated inventory');
      }
      result.dustQuantity = Math.max(0, remainder);
      emit({ stage: 'EXIT_FILLED', symbol: request.symbol, clientOrderId: request.exitClientOrderId,
        orderId: result.exitOrderId, quantity: sold });
      const final = await this.getStartupSnapshot();
      const finalBase = final.balances.find(item => item.currency === base)?.equity ?? 0;
      const smokeOpen = final.openOrders.some(order => [request.entryClientOrderId,
        request.exitClientOrderId].includes(order.clientOrderId));
      const protectionOpen = this.tools?.getAlgoOrders
        ? (await this.smokeAlgoRows(request, 'pending')).some(row => row.instId === request.symbol
          && (row.algoId === result.protectionId || row.algoClOrdId === request.protectionClientOrderId)) : false;
      if (final.profile !== 'demo' || smokeOpen || protectionOpen
        || !approximately(finalBase - beforeBase, result.dustQuantity,
          Math.max(request.quantityStep / 2, 1e-8))
        || result.dustQuantity + request.quantityStep / 10 >= request.minOrderSize) {
        return finish('MANUAL_RECONCILIATION_REQUIRED', 'Final smoke-only flat reconciliation failed');
      }
      result.auraManagedActivePositionCount = 0;
      result.entryState = 'CLOSED';
      return finish('PASS', 'Entry, protection test, cleanup, and smoke-only flat state reconciled');
    } catch (error) {
      if (result.confirmedFilledQuantity === 0 && result.entryState !== 'NOT_SUBMITTED') {
        result.entryState = 'RECONCILE_REQUIRED';
      }
      return finish('MANUAL_RECONCILIATION_REQUIRED', error instanceof Error ? error.message
        : 'Smoke lifecycle requires manual reconciliation');
    }
  }

  private submission(plan: ApprovedOrderPlan, status: OrderSubmissionResult['status'],
    exchangeOrderId: string | null = null, reason: string | null = null,
    protectionMode: OrderSubmissionResult['protectionMode'] = null, protectionVerified = false): OrderSubmissionResult {
    return {
      status, symbol: plan.symbol, clientOrderId: plan.clientOrderId,
      cycleId: plan.cycleId, decisionId: plan.decisionId,
      accepted: status === 'ACCEPTED', exchangeOrderId, reason,
      timestamp: this.now(), protectionMode, protectionVerified,
    };
  }

  async submitApprovedOrder(plan: ApprovedOrderPlan): Promise<OrderSubmissionResult> {
    if (!validPlan(plan)) return this.submission(plan, 'INVALID_PLAN', null, 'Invalid approved order plan');
    if (this.connector.profile === 'live' && plan.side === 'BUY' && !this.liveEntryProtectionReady())
      return this.submission(plan, 'REJECTED', null, 'Live entry protection is unverified');
    if (this.attemptedClientOrderIds.has(plan.clientOrderId)) return this.submission(plan, 'DUPLICATE', null, 'clientOrderId already attempted');
    if (!this.connected()) return this.submission(plan, 'CONNECTOR_FAILURE', null, 'MCP connector unavailable');
    this.attemptedClientOrderIds.add(plan.clientOrderId);
    const tools = this.tools!;
    // Read-only exchange lookup protects idempotency after a process restart.
    try {
      await this.getOrderStatus(plan.symbol, plan.clientOrderId);
      return this.submission(plan, 'DUPLICATE', null, 'clientOrderId already exists at exchange');
    } catch (error) {
      if (!(error instanceof OkxConnectorError) || error.category !== 'TOOL_NOT_AVAILABLE') {
        return this.submission(plan, 'CONNECTOR_FAILURE', null, 'Existing-order lookup failed');
      }
    }
    if (plan.side === 'SELL') {
      if (!tools.getBalance) return this.submission(plan, 'CONNECTOR_FAILURE', null, 'Balance tool unavailable');
      try {
        const balances = this.parseBalances(await this.readConnector.callTool(tools.getBalance, {}));
        const owned = balances.find(balance => balance.currency === baseCurrency(plan.symbol))?.available ?? 0;
        if (owned - (this.reservedSellQuantity.get(plan.symbol) ?? 0) < plan.quantity) {
          return this.submission(plan, 'REJECTED', null, 'Insufficient unreserved owned spot balance');
        }
        this.reservedSellQuantity.set(plan.symbol, (this.reservedSellQuantity.get(plan.symbol) ?? 0) + plan.quantity);
      } catch {
        return this.submission(plan, 'CONNECTOR_FAILURE', null, 'Balance lookup failed');
      }
    }
    const attach = plan.side === 'BUY' && tools.attachedProtectionSupported;
    const args: Record<string, unknown> = {
      instId: plan.symbol, tdMode: 'cash', side: plan.side.toLowerCase(),
      ordType: 'market', sz: String(plan.quantity), tgtCcy: 'base_ccy',
      clOrdId: plan.clientOrderId,
    };
    if (attach) {
      args.slTriggerPx = String(plan.protection.initialStopPrice);
      args.slOrdPx = '-1';
      args.tpTriggerPx = String(takeProfitTrigger(plan));
      args.tpOrdPx = '-1';
    }
    let result: unknown;
    try {
      result = await this.connector.callTool(tools.placeOrder, args,
        { cycleId: plan.cycleId, decisionId: plan.decisionId });
    } catch {
      return this.submission(plan, 'RECONCILE_REQUIRED', null, 'Order outcome ambiguous after MCP call');
    }
    let row: Row;
    try {
      const orderRows = rows(result);
      if (orderRows.length !== 1) throw new Error('Expected one order acknowledgement');
      row = orderRows[0]!;
    } catch {
      return this.submission(plan, 'RECONCILE_REQUIRED', null, 'Malformed order acknowledgement');
    }
    if (row.sCode != null && row.sCode !== '0' && row.sCode !== 0) {
      return this.submission(plan, 'REJECTED', text(row.ordId), 'Exchange rejected order');
    }
    const orderId = text(row.ordId);
    if (!orderId || text(row.clOrdId) !== plan.clientOrderId || (row.sCode !== '0' && row.sCode !== 0)) {
      return this.submission(plan, 'RECONCILE_REQUIRED', orderId, 'Order acknowledgement lacks matching identity');
    }
    if (!attach) return this.submission(plan, 'ACCEPTED', orderId, null,
      plan.side === 'BUY' ? 'CLIENT_SIDE' : null, false);
    const { verified, ids } = await this.verifyAttachedProtection(plan, orderId);
    return { ...this.submission(plan, 'ACCEPTED', orderId,
      verified ? null : 'Exchange protection could not be verified',
      verified ? 'EXCHANGE_SIDE' : 'CLIENT_SIDE', verified), protectionIds: ids };
  }

  /** Algo rows linked to one AURA entry by attached algo ID, parent order ID, or entry client ID. */
  /**
   * Rows linked to one AURA entry by an exchange-provided identity (known algo ID, parent
   * order ID, entry client ID) or by the protection signature. Identity alone is not
   * enough on OKX: the pending OCO's algoId differs from the parent attachAlgoId.
   */
  private linkedProtection(candidates: readonly Row[], link: AttachedProtectionLink): Row[] {
    return candidates.filter(row => {
      if (row.instId !== link.symbol) return false;
      const algoId = text(row.algoId);
      const byIdentity = (algoId !== null && link.protectionIds.includes(algoId))
        || (!!link.entryOrderId && text(row.ordId) === link.entryOrderId)
        || (!!link.entryClientOrderId && (text(row.clOrdId) === link.entryClientOrderId
          || text(row.attachAlgoClOrdId) === link.entryClientOrderId));
      if (byIdentity) return true;
      const pending = pendingProtectionRow(row, link.symbol);
      return !!link.signature && pending !== null && protectionSignatureMatches(pending, link.signature);
    });
  }

  private signatureMatches(candidates: readonly Row[], link: AttachedProtectionLink): Row[] {
    if (!link.signature) return [];
    return candidates.filter(row => {
      const pending = pendingProtectionRow(row, link.symbol);
      return pending !== null && protectionSignatureMatches(pending, link.signature!);
    });
  }

  private attachedIds(orderRows: readonly Row[], symbol: string, orderId: string): string[] {
    const ids: string[] = [];
    for (const row of orderRows) {
      if (row.instId !== symbol || text(row.ordId) !== orderId || !Array.isArray(row.attachAlgoOrds)) continue;
      for (const item of row.attachAlgoOrds) {
        const algo = record(item);
        const id = text(algo?.attachAlgoId) ?? text(algo?.algoId);
        if (id) ids.push(id);
      }
    }
    return ids;
  }

  private async verifyAttachedProtection(plan: ApprovedOrderPlan, orderId: string): Promise<{ verified: boolean; ids: string[] }> {
    const ids = new Set<string>();
    if (!this.readConnector.isConnected() || !this.tools?.getAlgoOrders) return { verified: false, ids: [] };
    const triggers = protectionTriggers(plan.protection, plan.tickSize);
    const signature: ProtectionSignature = { slTriggerPx: triggers.sl, tpTriggerPx: triggers.tp,
      quantity: plan.quantity, notBefore: null };
    const pricesMatch = (value: unknown): boolean => {
      const algo = record(value);
      return algo !== null && numeric(algo.slTriggerPx) === triggers.sl && numeric(algo.tpTriggerPx) === triggers.tp;
    };
    // Verification requires the LIVE pending TP/SL algo, not the parent order's echo of the
    // payload: on OKX the materialized OCO carries a different algoId than attachAlgoId and no
    // parent ordId, so it is correlated by the exact protection signature. Bounded READ
    // re-queries cover indexing lag; no write is ever repeated here.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (this.tools.getOrder) {
        try {
          const orderRows = rows(await this.readConnector.callTool(this.tools.getOrder, { instId: plan.symbol, ordId: orderId }));
          this.attachedIds(orderRows, plan.symbol, orderId).forEach(id => ids.add(id));
        } catch { /* Parent attachAlgoId is supplementary identity only. */ }
      }
      try {
        const algoRows = rows(await this.readConnector.callTool(this.tools.getAlgoOrders, { status: 'pending', instId: plan.symbol }));
        const linked = this.linkedProtection(algoRows, { symbol: plan.symbol, entryOrderId: orderId,
          entryClientOrderId: plan.clientOrderId, protectionIds: [...ids], signature });
        const live = linked.filter(row => pricesMatch(row)
          && (row.state == null || row.state === 'live' || row.state === 'pending' || row.state === 'effective'));
        for (const row of live) { const id = text(row.algoId); if (id) ids.add(id); }
        if (live.length === 1) return { verified: true, ids: [...ids] };
        if (live.length > 1) return { verified: false, ids: [...ids] };
      } catch { /* A later bounded read may still verify. */ }
      if (attempt < 3) await delay(350);
    }
    return { verified: false, ids: [...ids] };
  }

  async getPendingProtection(symbol: string): Promise<readonly PendingProtection[] | null> {
    if (!this.connected() || !this.tools?.getAlgoOrders) return null;
    const pending = rows(await this.readConnector.callTool(this.tools.getAlgoOrders, { status: 'pending', instId: symbol }));
    return pending.map(row => pendingProtectionRow(row, symbol)).filter((row): row is PendingProtection => row !== null);
  }

  /**
   * Cancels only algo protection linked to the given AURA entry. Unlinked algo orders
   * (unmanaged inventory protection, other agents) are never touched. One cancellation
   * attempt per linked ID; anything still pending afterwards is reported as ambiguous.
   */
  async cancelAttachedProtection(link: AttachedProtectionLink): Promise<ProtectionCancelResult> {
    const finish = (status: ProtectionCancelResult['status'], ids: Iterable<string>, reason: string): ProtectionCancelResult =>
      ({ status, protectionIds: [...new Set(ids)], reason });
    const known = new Set(link.protectionIds);
    if (!this.connected() || !this.tools?.getAlgoOrders) {
      return known.size || link.entryOrderId
        ? finish('AMBIGUOUS', known, 'Protection query unavailable') : finish('NONE', [], 'No protection evidence');
    }
    try {
      if (this.tools.getOrder && link.entryOrderId) {
        try {
          const orderRows = rows(await this.readConnector.callTool(this.tools.getOrder,
            { instId: link.symbol, ordId: link.entryOrderId }));
          this.attachedIds(orderRows, link.symbol, link.entryOrderId).forEach(id => known.add(id));
        } catch { /* The pending listing still identifies linked protection. */ }
      }
      const enriched: AttachedProtectionLink = { ...link, protectionIds: [...known] };
      const pending = rows(await this.readConnector.callTool(this.tools.getAlgoOrders, { status: 'pending', instId: link.symbol }));
      // Two live algos with the identical signature cannot be told apart; never cancel either.
      const bySignature = this.signatureMatches(pending, enriched);
      if (bySignature.length > 1) {
        return finish('AMBIGUOUS', bySignature.map(row => text(row.algoId) ?? ''),
          'Multiple pending algos share this entry\'s protection signature');
      }
      const targets = [...new Set(this.linkedProtection(pending, enriched)
        .map(row => text(row.algoId)).filter((id): id is string => id !== null))];
      if (!targets.length) return finish('NONE', known, 'No pending protection linked to the entry');
      if (!this.tools.cancelAlgoOrder) return finish('AMBIGUOUS', targets, 'Cancel tool unavailable');
      for (const algoId of targets) {
        try { await this.connector.callTool(this.tools.cancelAlgoOrder, { instId: link.symbol, algoId }); }
        catch { /* One attempt only; the follow-up query decides. */ }
      }
      const after = rows(await this.readConnector.callTool(this.tools.getAlgoOrders, { status: 'pending', instId: link.symbol }));
      const remaining = this.linkedProtection(after, { ...enriched, protectionIds: [...new Set([...known, ...targets])] });
      return remaining.length
        ? finish('AMBIGUOUS', targets, 'Linked protection still pending after one cancellation attempt')
        : finish('CANCELLED', targets, 'Linked protection cancelled');
    } catch { return finish('AMBIGUOUS', known, 'Protection query failed'); }
  }

  private parseBalances(value: unknown): { currency: string; equity: number; available: number; averageEntryPrice: number | null; updatedAt: number }[] {
    const row = rows(value)[0];
    if (!row || !Array.isArray(row.details)) throw new OkxConnectorError('CONNECTOR_PROTOCOL_ERROR', 'Malformed trading balance');
    return row.details.map(item => {
      const detail = record(item);
      const currency = text(detail?.ccy);
      const equity = numeric(detail?.eq);
      const available = numeric(detail?.availBal);
      if (!currency || equity === null || equity < 0 || available === null || available < 0) {
        throw new OkxConnectorError('CONNECTOR_PROTOCOL_ERROR', 'Malformed balance currency');
      }
      return { currency, equity, available,
        averageEntryPrice: numeric(detail?.avgPx), updatedAt: numeric(row.uTime, this.now())! };
    });
  }

  private async queryOrders(symbol: string, status: 'open' | 'history'): Promise<Row[]> {
    const tool = this.tools?.getOrders;
    return tool ? rows(await this.readConnector.callTool(tool, { status, instId: symbol })) : [];
  }

  async getOrderStatus(symbol: string, clientOrderId: string): Promise<OrderStatus> {
    if (!this.connected()) throw new OkxConnectorError('CONNECTOR_NOT_CONNECTED', 'MCP connector unavailable');
    const lookup = this.tools?.getOrder;
    let lookupFailed = false;
    if (lookup) {
      try {
        const found = rows(await this.readConnector.callTool(lookup, { instId: symbol, clOrdId: clientOrderId }));
        const row = found.find(item => item.instId === symbol && item.clOrdId === clientOrderId);
        if (row) return parseOrder(row, symbol, clientOrderId);
      } catch { lookupFailed = true; }
    }
    for (const status of ['open', 'history'] as const) {
      const row = (await this.queryOrders(symbol, status)).find(item => item.instId === symbol && item.clOrdId === clientOrderId);
      if (row) return parseOrder(row, symbol, clientOrderId);
    }
    if (lookupFailed && !this.tools?.getOrders) throw new OkxConnectorError('CONNECTOR_PROTOCOL_ERROR', 'Order lookup failed');
    if (!lookup && !this.tools?.getOrders) throw new OkxConnectorError('CONNECTOR_PROTOCOL_ERROR', 'No order lookup capability');
    throw new OkxConnectorError('TOOL_NOT_AVAILABLE', 'Order not found by clientOrderId');
  }

  async reconcile(request: OrderRequest): Promise<ReconciliationResult> {
    const finish = (outcome: ReconciliationResult['outcome'], order: OrderStatus | null,
      position: ExchangePositionSnapshot | null, reason: string): ReconciliationResult => ({
      outcome, order, position, reason,
      symbol: request.symbol, clientOrderId: request.clientOrderId,
      cycleId: request.cycleId, decisionId: request.decisionId,
      // NOT_FOUND is a point-in-time observation, not proof that a late fill cannot appear.
      reconciled: outcome === 'FILLED' || outcome === 'OPEN', timestamp: this.now(),
    });
    if (!this.connected()) return finish('UNKNOWN', null, null, 'MCP connector unavailable');
    try {
      let order: OrderStatus | null = null;
      if (request.exchangeOrderId && this.tools?.getOrder) {
        try {
          const found = rows(await this.readConnector.callTool(this.tools.getOrder, {
            instId: request.symbol, ordId: request.exchangeOrderId,
          }));
          const exact = found.find(row => row.instId === request.symbol && row.ordId === request.exchangeOrderId);
          if (exact) order = parseOrder(exact, request.symbol, request.clientOrderId,
            request.cycleId, request.decisionId);
        } catch { /* Continue with client ID and listing queries. */ }
      }
      try { order ??= await this.getOrderStatus(request.symbol, request.clientOrderId); }
      catch (error) {
        if (!(error instanceof OkxConnectorError) || error.category !== 'TOOL_NOT_AVAILABLE') {
          return finish('UNKNOWN', null, null, 'Order lookup failed');
        }
      }
      if (order) {
        order.cycleId = request.cycleId;
        order.decisionId = request.decisionId;
        if (order.state === 'FILLED') return finish('FILLED', order, null, 'Order filled');
        if (order.state === 'OPEN' || order.state === 'PENDING' || order.state === 'PARTIALLY_FILLED') {
          return finish('OPEN', order, null, 'Order pending/open');
        }
      }
      const fillTool = this.tools?.getFills;
      if (fillTool) {
        const fillRows = rows(await this.readConnector.callTool(fillTool, { instId: request.symbol, archive: false }));
        const matched = fillRows.find(row => row.instId === request.symbol
          && (row.clOrdId === request.clientOrderId || (!!request.exchangeOrderId && row.ordId === request.exchangeOrderId)));
        if (matched) {
          normalizeOkxFillIdentity(matched);
          return finish('FILLED', order, null, 'Matching recent fill found');
        }
      }
      if (order) return finish('UNKNOWN', order, null, `Order found with state ${order.state}`);
      if (!this.tools?.getOrders && !this.tools?.getOrder && !fillTool) return finish('UNKNOWN', null, null, 'No reconciliation query tools');
      return finish('NOT_FOUND', order, null, 'No matching order in lookup, open/history, or fills');
    } catch {
      return finish('UNKNOWN', null, null, 'Reconciliation query failed');
    }
  }

  async getStartupSnapshot(): Promise<StartupExchangeSnapshot> {
    if (!this.connected()) throw new OkxConnectorError('CONNECTOR_NOT_CONNECTED', 'MCP connector unavailable');
    const tools = this.tools!;
    if (!tools.getBalance || !tools.getTradeFee || !tools.getOrders || !tools.getFills) {
      throw new OkxConnectorError('TOOL_NOT_AVAILABLE', 'Startup reconciliation tools unavailable');
    }
    const balanceResponse = await this.readConnector.callTool(tools.getBalance, {});
    const balances = this.parseBalances(balanceResponse);
    const totalEquityUsd = numeric(rows(balanceResponse)[0]?.totalEq);
    if (totalEquityUsd === null || totalEquityUsd < 0) throw new OkxConnectorError('CONNECTOR_PROTOCOL_ERROR', 'Malformed total equity');
    const positions: ExchangePositionSnapshot[] = [];
    for (const symbol of this.trackedSymbols) {
      const currency = baseCurrency(symbol);
      const balance = balances.find(item => item.currency === currency);
      if (balance && balance.equity > 0) positions.push({
        symbol, quantity: balance.equity, averageEntryPrice: balance.averageEntryPrice,
        updatedAt: balance.updatedAt,
      });
    }
    const openOrders: OrderStatus[] = [];
    const recentFills: StartupExchangeSnapshot['recentFills'][number][] = [];
    const feeRates: StartupExchangeSnapshot['feeRates'][number][] = [];
    for (const symbol of this.trackedSymbols) {
      const open = await this.queryOrders(symbol, 'open');
      openOrders.push(...open.map(row => parseOrder(row, symbol, text(row.clOrdId) ?? '')));
      if (tools.getOrder) {
        for (const order of openOrders.filter(item => item.symbol === symbol && item.clientOrderId)) {
          try {
            const queried = rows(await this.readConnector.callTool(tools.getOrder, { instId: symbol, clOrdId: order.clientOrderId }));
            const exact = queried.find(item => item.instId === symbol && item.clOrdId === order.clientOrderId);
            if (exact) Object.assign(order, parseOrder(exact, symbol, order.clientOrderId));
          } catch { /* The open-order listing still proves this order exists. */ }
        }
      }
      const fills = rows(await this.readConnector.callTool(tools.getFills, { instId: symbol, archive: false }));
      for (const row of fills) {
        if (row.instId !== symbol) throw new OkxConnectorError('CONNECTOR_PROTOCOL_ERROR', 'Fill symbol mismatch');
        const identity = normalizeOkxFillIdentity(row);
        const orderId = text(row.ordId), quantity = numeric(row.fillSz), price = numeric(row.fillPx);
        const fee = numeric(row.fee), feeCurrency = text(row.feeCcy);
        const fillTime = numeric(row.fillTime ?? row.ts);
        if (!orderId || (row.side !== 'buy' && row.side !== 'sell')
          || quantity === null || quantity <= 0 || price === null || price <= 0
          || fee === null || !feeCurrency || fillTime === null
          || !Number.isSafeInteger(fillTime) || fillTime < 1_000_000_000_000)
          throw new OkxConnectorError('CONNECTOR_PROTOCOL_ERROR', 'Malformed fill');
        recentFills.push({ symbol, orderId, clientOrderId: text(row.clOrdId),
          ...identity, side: row.side, quantity, price, fee, feeCurrency, timestamp: fillTime });
      }
      const fees = rows(await this.readConnector.callTool(tools.getTradeFee, { instType: 'SPOT', instId: symbol }));
      const fee = fees[0];
      const makerRate = numeric(fee?.maker), takerRate = numeric(fee?.taker);
      if (!fee || makerRate === null || takerRate === null) throw new OkxConnectorError('CONNECTOR_PROTOCOL_ERROR', 'Malformed fee rate');
      feeRates.push({ symbol, makerRate, takerRate });
    }
    return {
      profile: this.connector.profile, totalEquityUsd, positions, openOrders,
      balances: balances.map(({ currency, equity, available }) => ({ currency, equity, available })),
      recentFills, feeRates, orderLookupSupported: tools.getOrder !== null,
      timestamp: this.now(),
    };
  }
}

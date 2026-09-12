import type { OkxConnector } from '../okx/connector.js';
import { OkxConnectorError } from '../okx/types.js';
import type { ApprovedOrderPlan } from '../risk/types.js';
import { discoverExecutionTools, type ExecutionTools } from './discovery.js';
import type {
  ExchangePositionSnapshot, ExecutionEngine, OrderRequest, OrderStatus,
  OrderSubmissionResult, ReconciliationResult, StartupExchangeSnapshot,
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
  };
}
function baseCurrency(symbol: string): string | null {
  const match = /^([A-Z0-9]+)-([A-Z0-9]+)$/.exec(symbol);
  return match?.[1] ?? null;
}
function validPlan(plan: ApprovedOrderPlan): boolean {
  return !!plan && !!plan.protection && !!baseCurrency(plan.symbol) && (plan.side === 'BUY' || plan.side === 'SELL')
    && Number.isFinite(plan.quantity) && plan.quantity > 0
    && Number.isFinite(plan.referencePrice) && plan.referencePrice > 0
    && Number.isFinite(plan.estimatedNotional) && plan.estimatedNotional > 0
    && Math.abs(plan.quantity * plan.referencePrice - plan.estimatedNotional)
      <= Math.max(1e-8, plan.estimatedNotional * 1e-8)
    && /^[A-Za-z0-9_-]{1,32}$/.test(plan.clientOrderId)
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

  constructor(
    private readonly connector: OkxConnector,
    private readonly trackedSymbols: readonly string[] = ['BTC-USDT', 'ETH-USDT'],
    private readonly now: () => number = Date.now,
  ) {}

  async start(): Promise<void> {
    await this.connector.connect();
    this.tools = discoverExecutionTools(await this.connector.listTools());
  }

  getCapabilities(): ExecutionTools | null {
    return this.tools ? { ...this.tools } : null;
  }

  private connected(): boolean {
    return this.tools !== null && this.connector.isConnected();
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
        const balances = this.parseBalances(await this.connector.callTool(tools.getBalance, {}));
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
      args.tpTriggerPx = String(plan.referencePrice + plan.protection.stopDistanceAbsolute * plan.protection.takeProfitR);
      args.tpOrdPx = '-1';
    }
    let result: unknown;
    try {
      result = await this.connector.callTool(tools.placeOrder, args);
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
    const verified = await this.verifyAttachedProtection(plan, orderId);
    return this.submission(plan, 'ACCEPTED', orderId,
      verified ? null : 'Exchange protection could not be verified',
      verified ? 'EXCHANGE_SIDE' : 'CLIENT_SIDE', verified);
  }

  private async verifyAttachedProtection(plan: ApprovedOrderPlan, orderId: string): Promise<boolean> {
    if (!this.connector.isConnected()) return false;
    const expectedTp = plan.referencePrice + plan.protection.stopDistanceAbsolute * plan.protection.takeProfitR;
    const pricesMatch = (value: unknown): boolean => {
      const algo = record(value);
      return algo !== null && numeric(algo.slTriggerPx) === plan.protection.initialStopPrice
        && numeric(algo.tpTriggerPx) === expectedTp;
    };
    if (this.tools?.getOrder) {
      try {
        const orderRows = rows(await this.connector.callTool(this.tools.getOrder, { instId: plan.symbol, ordId: orderId }));
        const row = orderRows.find(item => item.instId === plan.symbol && item.ordId === orderId);
        if (Array.isArray(row?.attachAlgoOrds) && row.attachAlgoOrds.some(pricesMatch)) return true;
      } catch { /* Try the dedicated algo-order query next. */ }
    }
    if (this.tools?.getAlgoOrders) {
      try {
        const algoRows = rows(await this.connector.callTool(this.tools.getAlgoOrders, { status: 'pending', instId: plan.symbol }));
        return algoRows.some(row => row.instId === plan.symbol
          && (row.ordId === orderId || row.clOrdId === plan.clientOrderId
            || row.algoClOrdId === plan.clientOrderId || row.attachAlgoClOrdId === plan.clientOrderId)
          && pricesMatch(row));
      } catch { return false; }
    }
    return false;
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
    return tool ? rows(await this.connector.callTool(tool, { status, instId: symbol })) : [];
  }

  async getOrderStatus(symbol: string, clientOrderId: string): Promise<OrderStatus> {
    if (!this.connected()) throw new OkxConnectorError('CONNECTOR_NOT_CONNECTED', 'MCP connector unavailable');
    const lookup = this.tools?.getOrder;
    let lookupFailed = false;
    if (lookup) {
      try {
        const found = rows(await this.connector.callTool(lookup, { instId: symbol, clOrdId: clientOrderId }));
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
          const found = rows(await this.connector.callTool(this.tools.getOrder, {
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
        const fillRows = rows(await this.connector.callTool(fillTool, { instId: request.symbol, archive: false }));
        const matched = fillRows.find(row => row.instId === request.symbol
          && (row.clOrdId === request.clientOrderId || (!!request.exchangeOrderId && row.ordId === request.exchangeOrderId)));
        if (matched) return finish('FILLED', order, null, 'Matching recent fill found');
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
    const balanceResponse = await this.connector.callTool(tools.getBalance, {});
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
            const queried = rows(await this.connector.callTool(tools.getOrder, { instId: symbol, clOrdId: order.clientOrderId }));
            const exact = queried.find(item => item.instId === symbol && item.clOrdId === order.clientOrderId);
            if (exact) Object.assign(order, parseOrder(exact, symbol, order.clientOrderId));
          } catch { /* The open-order listing still proves this order exists. */ }
        }
      }
      const fills = rows(await this.connector.callTool(tools.getFills, { instId: symbol, archive: false }));
      for (const row of fills) {
        if (row.instId !== symbol) throw new OkxConnectorError('CONNECTOR_PROTOCOL_ERROR', 'Fill symbol mismatch');
        const orderId = text(row.ordId), quantity = numeric(row.fillSz), price = numeric(row.fillPx);
        if (!orderId || quantity === null || quantity <= 0 || price === null || price <= 0) throw new OkxConnectorError('CONNECTOR_PROTOCOL_ERROR', 'Malformed fill');
        recentFills.push({ symbol, orderId, clientOrderId: text(row.clOrdId), quantity, price,
          timestamp: numeric(row.ts, this.now())! });
      }
      const fees = rows(await this.connector.callTool(tools.getTradeFee, { instType: 'SPOT', instId: symbol }));
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

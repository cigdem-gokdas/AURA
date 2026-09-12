import type { OkxConnector } from '../okx/connector.js';
import { OkxConnectorError } from '../okx/types.js';
import { canonicalToolName, type AtkCapability } from '../okx/capabilities.js';
import { normalizeOkxFillIdentity } from '../okx/fill.js';
import type {
  Candle,
  InstrumentMeta,
  MarketAdapter,
  OpenSpotOrder,
  OrderBookLevel,
  OrderBookSnapshot,
  RecentSpotFill,
  SpotFeeRate,
  Ticker,
  TradingBalanceSnapshot,
} from './types.js';

const CANDLE_BARS = new Set([
  '1m',
  '3m',
  '5m',
  '15m',
  '30m',
  '1H',
  '2H',
  '4H',
  '6H',
  '12H',
  '1D',
  '2D',
  '3D',
  '1W',
  '1M',
  '3M',
]);

function invalid(message: string): never {
  throw new OkxConnectorError('CONNECTOR_PROTOCOL_ERROR', message);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    invalid(`Invalid ${label}`);
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) invalid(`Invalid ${label}`);
  return value;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim())
    invalid(`Missing or invalid ${label}`);
  return value;
}

function numeric(value: unknown, label: string, minimum = -Infinity): number {
  if (
    typeof value !== 'number' &&
    (typeof value !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(value))
  ) {
    invalid(`Invalid ${label}`);
  }
  const result = Number(value);
  if (!Number.isFinite(result) || result < minimum) invalid(`Invalid ${label}`);
  return result;
}

function timestamp(value: unknown, label: string): number {
  const result = numeric(value, label, 1);
  // ATK/OKX timestamps are Unix milliseconds. A seconds value must fail closed
  // instead of being treated as a plausible but decades-old market observation.
  if (!Number.isSafeInteger(result) || result < 1_000_000_000_000)
    invalid(`Invalid ${label}`);
  return result;
}

function optionalPrice(value: unknown, label: string): number | null {
  return value === '' || value == null
    ? null
    : numeric(value, label, Number.EPSILON);
}

function matchingSymbol(row: Record<string, unknown>, symbol: string): void {
  if (text(row.instId, 'instrument ID') !== symbol)
    invalid('OKX response instrument does not match request');
}

function toolRows(value: unknown): unknown[] {
  const envelope = record(value, 'OKX tool envelope');
  text(envelope.endpoint, 'OKX endpoint');
  text(envelope.requestTime, 'OKX request time');
  return array(envelope.data, 'OKX data rows');
}

function oneRow(value: unknown): Record<string, unknown> {
  const rows = toolRows(value);
  if (rows.length !== 1) invalid('Expected exactly one OKX data row');
  return record(rows[0], 'OKX data row');
}

function side(value: unknown): 'buy' | 'sell' {
  if (value !== 'buy' && value !== 'sell') invalid('Invalid OKX order side');
  return value;
}

function levels(value: unknown, label: string): OrderBookLevel[] {
  return array(value, label).map((item) => {
    const level = array(item, label + ' level');
    if (level.length < 2) invalid('Incomplete OKX order book level');
    return {
      price: numeric(level[0], label + ' price', Number.EPSILON),
      size: numeric(level[1], label + ' size', Number.EPSILON),
    };
  });
}

/** Read-only domain adapter. Each request retains its own symbol and profile flag. */
export class OkxMarketAdapter implements MarketAdapter {
  constructor(private readonly connector: OkxConnector) {}

  private async call<T>(
    capability: AtkCapability,
    args: Record<string, unknown>,
  ): Promise<T> {
    const toolName = this.connector.getCapabilities
      ? this.connector.getCapabilities().resolve(capability)
      : canonicalToolName(capability);
    if (!toolName) throw new OkxConnectorError('TOOL_NOT_AVAILABLE', `Missing ${capability} capability`);
    const tools = await this.connector.listTools();
    if (!tools.some((tool) => tool.name === toolName)) {
      throw new OkxConnectorError(
        'TOOL_NOT_AVAILABLE',
        `Required OKX MCP tool ${toolName} is unavailable`,
      );
    }
    return this.connector.callTool<T>(toolName, args);
  }

  private marketArgs(symbol: string): { instId: string; demo: boolean } {
    return {
      instId: text(symbol, 'symbol'),
      demo: this.connector.profile === 'demo',
    };
  }

  async getTicker(symbol: string): Promise<Ticker> {
    const row = oneRow(
      await this.call('MARKET_TICKER', this.marketArgs(symbol)),
    );
    matchingSymbol(row, symbol);
    const bid = numeric(row.bidPx, 'bid price', Number.EPSILON);
    const ask = numeric(row.askPx, 'ask price', Number.EPSILON);
    if (ask < bid) invalid('Crossed OKX ticker');
    return {
      symbol,
      bid,
      ask,
      last: numeric(row.last, 'last price', Number.EPSILON),
      timestamp: timestamp(row.ts, 'ticker timestamp'),
    };
  }

  async getCandles(
    symbol: string,
    timeframe: string,
    limit: number,
  ): Promise<readonly Candle[]> {
    if (!CANDLE_BARS.has(timeframe)) invalid('Unsupported candle timeframe');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
      invalid('Invalid candle limit');
    const rows = toolRows(
      await this.call('MARKET_CANDLES', {
        ...this.marketArgs(symbol),
        bar: timeframe,
        limit,
      }),
    );
    return rows.map((item) => {
      const row = array(item, 'candle');
      if (row.length < 6) invalid('Incomplete OKX candle');
      const open = numeric(row[1], 'candle open', Number.EPSILON);
      const high = numeric(row[2], 'candle high', Number.EPSILON);
      const low = numeric(row[3], 'candle low', Number.EPSILON);
      const close = numeric(row[4], 'candle close', Number.EPSILON);
      if (
        high < Math.max(open, close, low) ||
        low > Math.min(open, close, high)
      )
        invalid('Impossible OKX candle prices');
      return {
        symbol,
        timestamp: timestamp(row[0], 'candle timestamp'),
        open,
        high,
        low,
        close,
        volume: numeric(row[5], 'candle volume', 0),
      };
    });
  }

  async getOrderBook(
    symbol: string,
    depth: number,
  ): Promise<OrderBookSnapshot> {
    if (!Number.isSafeInteger(depth) || depth < 1 || depth > 400)
      invalid('Invalid order book depth');
    const row = oneRow(
      await this.call('MARKET_ORDERBOOK', {
        ...this.marketArgs(symbol),
        sz: depth,
      }),
    );
    const bids = levels(row.bids, 'bid');
    const asks = levels(row.asks, 'ask');
    if (!bids.length || !asks.length || bids[0]!.price > asks[0]!.price)
      invalid('Invalid OKX order book');
    return {
      symbol,
      bids,
      asks,
      timestamp: timestamp(row.ts, 'order book timestamp'),
    };
  }

  async getInstrumentMeta(symbol: string): Promise<InstrumentMeta> {
    const row = oneRow(
      await this.call('MARKET_INSTRUMENT', {
        instType: 'SPOT',
        ...this.marketArgs(symbol),
      }),
    );
    matchingSymbol(row, symbol);
    return {
      symbol,
      instrumentId: text(row.instId, 'instrument ID'),
      ...(typeof row.state === 'string' ? { state: row.state } : {}),
      minOrderSize: numeric(row.minSz, 'minimum order size', Number.EPSILON),
      quantityStep: numeric(row.lotSz, 'lot size', Number.EPSILON),
      tickSize: numeric(row.tickSz, 'tick size', Number.EPSILON),
    };
  }

  async checkConnectorAvailable(): Promise<boolean> {
    if (!this.connector.isConnected()) return false;
    const health = await this.connector.healthCheck();
    return health.connected && health.status === 'HEALTHY';
  }

  async checkMarketReachable(symbol: string): Promise<boolean> {
    try {
      await this.getTicker(symbol);
      return true;
    } catch (error) {
      if (
        error instanceof OkxConnectorError &&
        error.category !== 'TOOL_CALL_FAILED' &&
        error.category !== 'CONNECTOR_UNAVAILABLE'
      ) {
        throw error;
      }
      return false;
    }
  }

  async getSpotFeeRate(symbol: string): Promise<SpotFeeRate> {
    const row = oneRow(
      await this.call('ACCOUNT_FEE', {
        instType: 'SPOT',
        instId: text(symbol, 'symbol'),
      }),
    );
    if (row.instId != null && row.instId !== '') matchingSymbol(row, symbol);
    return {
      symbol,
      makerRate: numeric(row.maker, 'maker fee'),
      takerRate: numeric(row.taker, 'taker fee'),
    };
  }

  async getTradingBalanceSnapshot(): Promise<TradingBalanceSnapshot> {
    const row = oneRow(await this.call('ACCOUNT_BALANCE', {}));
    return {
      totalEquityUsd: numeric(row.totalEq, 'total equity', 0),
      balances: array(row.details, 'balance details').map((item) => {
        const detail = record(item, 'balance detail');
        return {
          currency: text(detail.ccy, 'balance currency'),
          equity: numeric(detail.eq, 'currency equity', 0),
          available: numeric(detail.availBal, 'available balance', 0),
        };
      }),
      timestamp: timestamp(row.uTime, 'balance timestamp'),
    };
  }

  async getOpenSpotOrders(symbol: string): Promise<readonly OpenSpotOrder[]> {
    const rows = toolRows(
      await this.call('SPOT_QUERY_ORDERS', {
        status: 'open',
        instId: text(symbol, 'symbol'),
      }),
    );
    return rows.map((item) => {
      const row = record(item, 'spot order');
      matchingSymbol(row, symbol);
      if (row.state !== 'live' && row.state !== 'partially_filled')
        invalid('Invalid open spot order state');
      const quantity = numeric(row.sz, 'order quantity', Number.EPSILON);
      const filledQuantity = numeric(row.accFillSz, 'filled quantity', 0);
      if (filledQuantity > quantity)
        invalid('Filled quantity exceeds order quantity');
      return {
        symbol,
        orderId: text(row.ordId, 'order ID'),
        clientOrderId:
          row.clOrdId === '' || row.clOrdId == null
            ? null
            : text(row.clOrdId, 'client order ID'),
        side: side(row.side),
        state: row.state,
        quantity,
        filledQuantity,
        price: optionalPrice(row.px, 'order price'),
        timestamp: timestamp(row.uTime, 'order timestamp'),
      };
    });
  }

  async getRecentSpotFills(symbol: string): Promise<readonly RecentSpotFill[]> {
    const rows = toolRows(
      await this.call('SPOT_FILLS', {
        instId: text(symbol, 'symbol'),
        archive: false,
      }),
    );
    return rows.map((item) => {
      const row = record(item, 'spot fill');
      matchingSymbol(row, symbol);
      return {
        symbol,
        ...normalizeOkxFillIdentity(row),
        orderId: text(row.ordId, 'order ID'),
        clientOrderId: row.clOrdId == null || row.clOrdId === '' ? null : text(row.clOrdId, 'client order ID'),
        side: side(row.side),
        quantity: numeric(row.fillSz, 'fill quantity', Number.EPSILON),
        price: numeric(row.fillPx, 'fill price', Number.EPSILON),
        fee: numeric(row.fee, 'fill fee'),
        feeCurrency: text(row.feeCcy, 'fill fee currency'),
        timestamp: timestamp(row.fillTime ?? row.ts, 'fill timestamp'),
      };
    });
  }
}

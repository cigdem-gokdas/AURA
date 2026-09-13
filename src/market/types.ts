export type MarketProfile = 'demo' | 'live';

/** Timestamps throughout the scaffold are Unix milliseconds. */
export interface Ticker {
  symbol: string;
  bid: number;
  ask: number;
  last: number;
  timestamp: number;
}

/** OKX spot volCcy24h is denominated in the quote asset (USDT here). */
export interface SpotTicker24h {
  symbol: string;
  quoteVolume24h: number;
  timestamp: number;
}

export interface SpotInstrumentListing {
  symbol: string;
  state: string;
}

export interface Candle {
  symbol: string;
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface OrderBookLevel {
  price: number;
  size: number;
}

export interface OrderBookSnapshot {
  symbol: string;
  bids: readonly OrderBookLevel[];
  asks: readonly OrderBookLevel[];
  timestamp: number;
}

export interface InstrumentMeta {
  symbol: string;
  instrumentId: string;
  /** Exchange trading state when the source supplies it. */
  state?: string;
  minOrderSize: number;
  quantityStep: number;
  tickSize: number;
}

export interface SpotFeeRate {
  symbol: string;
  makerRate: number;
  takerRate: number;
}

export interface TradingBalance {
  currency: string;
  equity: number;
  available: number;
}

export interface TradingBalanceSnapshot {
  totalEquityUsd: number;
  balances: readonly TradingBalance[];
  timestamp: number;
}

export interface OpenSpotOrder {
  symbol: string;
  orderId: string;
  clientOrderId: string | null;
  side: 'buy' | 'sell';
  state: 'live' | 'partially_filled';
  quantity: number;
  filledQuantity: number;
  price: number | null;
  timestamp: number;
}

export interface RecentSpotFill {
  symbol: string;
  fillId: string;
  orderId: string;
  clientOrderId?: string | null;
  tradeId?: string | null;
  billId?: string | null;
  side: 'buy' | 'sell';
  quantity: number;
  price: number;
  fee: number;
  feeCurrency: string;
  timestamp: number;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** An abstraction only; no command implementation exists in this scaffold. */
export interface CommandRunner {
  run(command: string, args: readonly string[]): Promise<CommandResult>;
}

/** An abstraction only; no exchange calls exist in this scaffold. */
export interface MarketAdapter {
  /** Production ATK adapter exposes these read-only bulk discovery calls. */
  getSpotTickers24h?(): Promise<readonly SpotTicker24h[]>;
  getSpotInstrumentListings?(): Promise<readonly SpotInstrumentListing[]>;
  getTicker(symbol: string): Promise<Ticker>;
  getCandles(
    symbol: string,
    bar: string,
    limit: number,
  ): Promise<readonly Candle[]>;
  getOrderBook(symbol: string, depth: number): Promise<OrderBookSnapshot>;
  getInstrumentMeta(symbol: string): Promise<InstrumentMeta>;
  checkConnectorAvailable(): Promise<boolean>;
  checkMarketReachable(symbol: string): Promise<boolean>;
  getSpotFeeRate(symbol: string): Promise<SpotFeeRate>;
  getTradingBalanceSnapshot(): Promise<TradingBalanceSnapshot>;
  getOpenSpotOrders(symbol: string): Promise<readonly OpenSpotOrder[]>;
  getRecentSpotFills(symbol: string): Promise<readonly RecentSpotFill[]>;
}

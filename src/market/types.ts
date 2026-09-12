export type MarketProfile = 'demo' | 'live';

/** Timestamps throughout the scaffold are Unix milliseconds. */
export interface Ticker {
  symbol: string;
  bid: number;
  ask: number;
  last: number;
  timestamp: number;
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
  minOrderSize: number;
  quantityStep: number;
  tickSize: number;
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
  getTicker(symbol: string): Promise<Ticker>;
  getCandles(
    symbol: string,
    bar: string,
    limit: number,
  ): Promise<readonly Candle[]>;
  getOrderBook(symbol: string, depth: number): Promise<OrderBookSnapshot>;
  getInstrumentMeta(symbol: string): Promise<InstrumentMeta>;
}

import type { MarketAdapter } from '../market/types.js';
import { minimumDemoSmokeQuantity } from '../execution/smoke-size.js';

export interface DemoSmokeSelection {
  symbol: string;
  quantity: number;
  approximateNotional: number;
  referencePrice: number;
  quantityStep: number;
  minOrderSize: number;
  tickSize: number;
  feeRate: number;
  spreadBps: number;
  dataAgeMs: number;
}

/** Infrastructure-only quote check; no OQS, regime, LLM, or strategy input. */
export async function selectDemoSmokeMarket(symbols: readonly string[], market: MarketAdapter,
  availableQuote: number, maxDataAgeMs: number, maxSpreadBps: number | null,
  now: () => number): Promise<DemoSmokeSelection | null> {
  if (!Number.isFinite(maxSpreadBps) || maxSpreadBps === null || maxSpreadBps <= 0) return null;
  const ordered = [...symbols].sort((a, b) => Number(b === 'ETH-USDT') - Number(a === 'ETH-USDT'));
  for (const symbol of ordered) {
    try {
      const [meta, ticker, book, fee] = await Promise.all([
        market.getInstrumentMeta(symbol), market.getTicker(symbol), market.getOrderBook(symbol, 5),
        market.getSpotFeeRate(symbol),
      ]);
      let evaluatedAt = now();
      const futureMs = Math.max(book.timestamp, ticker.timestamp) - evaluatedAt;
      if (futureMs > 0 && futureMs <= 100) {
        await new Promise<void>(resolve => setTimeout(resolve, futureMs + 1));
        evaluatedAt = now();
      }
      if (meta.symbol !== symbol || meta.state !== 'live'
        || ticker.symbol !== symbol || book.symbol !== symbol || fee.symbol !== symbol
        || !Number.isFinite(meta.tickSize) || meta.tickSize <= 0
        || !Number.isSafeInteger(ticker.timestamp) || !Number.isSafeInteger(book.timestamp)
        || ticker.timestamp > evaluatedAt || book.timestamp > evaluatedAt
        || evaluatedAt - ticker.timestamp > maxDataAgeMs || evaluatedAt - book.timestamp > maxDataAgeMs
        || !Number.isFinite(ticker.last) || ticker.last <= 0 || book.bids.length === 0 || book.asks.length === 0) continue;
      const bid = book.bids[0]!.price, ask = book.asks[0]!.price;
      if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask < bid
        || !Number.isFinite(book.bids[0]!.size) || book.bids[0]!.size <= 0
        || !Number.isFinite(book.asks[0]!.size) || book.asks[0]!.size <= 0) continue;
      const spreadBps = (ask - bid) / ((ask + bid) / 2) * 10_000;
      if (!Number.isFinite(spreadBps) || spreadBps > maxSpreadBps) continue;
      const feeRate = Math.abs(fee.takerRate);
      const quantity = minimumDemoSmokeQuantity(meta, feeRate, ask, availableQuote);
      if (quantity === null) continue;
      return { symbol, quantity, approximateNotional: quantity * ask, referencePrice: ask,
        quantityStep: meta.quantityStep, minOrderSize: meta.minOrderSize, tickSize: meta.tickSize,
        feeRate, spreadBps, dataAgeMs: evaluatedAt - book.timestamp };
    } catch { /* A failed market read cannot make a symbol eligible. */ }
  }
  return null;
}

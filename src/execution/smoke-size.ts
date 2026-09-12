import type { InstrumentMeta } from '../market/types.js';

/** Minimum entry whose base-fee-adjusted proceeds still permit one min-size exit. */
export function minimumDemoSmokeQuantity(meta: InstrumentMeta, feeRate: number,
  ask: number, availableQuote: number): number | null {
  if (![meta.minOrderSize, meta.quantityStep, ask, availableQuote, feeRate].every(Number.isFinite)
    || meta.minOrderSize <= 0 || meta.quantityStep <= 0 || ask <= 0 || availableQuote <= 0
    || feeRate < 0 || feeRate >= 0.1) return null;
  const required = meta.minOrderSize * (1 + feeRate) / (1 - feeRate);
  let units = Math.ceil(required / meta.quantityStep - 1e-10);
  if (!Number.isSafeInteger(units) || units < 1) return null;
  let quantity = Number((units * meta.quantityStep).toPrecision(15));
  while (quantity * (1 - feeRate) / (1 + feeRate) + 1e-12 < meta.minOrderSize) {
    units += 1;
    quantity = Number((units * meta.quantityStep).toPrecision(15));
  }
  // Balance buffer covers a small adverse market fill; it does not increase size.
  return quantity * ask * (1 + feeRate) * 1.01 <= availableQuote ? quantity : null;
}

/** Sell only whole lots of the confirmed net base received from the BUY. */
export function roundSmokeExitDown(netOwnedBase: number, quantityStep: number): number {
  if (![netOwnedBase, quantityStep].every(Number.isFinite)
    || netOwnedBase <= 0 || quantityStep <= 0) return 0;
  let units = Math.floor(netOwnedBase / quantityStep + 1e-10);
  let quantity = Number((units * quantityStep).toPrecision(15));
  if (quantity > netOwnedBase) {
    units -= 1;
    quantity = Number((units * quantityStep).toPrecision(15));
  }
  return units > 0 ? quantity : 0;
}

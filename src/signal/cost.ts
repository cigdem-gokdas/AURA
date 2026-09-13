import type { CostContext } from './types.js';

/** OKX negative taker fee rates denote a charge, not a negative trading cost. */
export function costContextFromOkxTakerFee(takerRate: number, spreadBps: number): CostContext {
  if (!Number.isFinite(takerRate) || !Number.isFinite(spreadBps) || spreadBps < 0)
    throw new RangeError('Invalid OKX fee rate or spread');
  return { feeBpsPerSide: Math.abs(takerRate) * 10_000,
    estimatedSlippageBpsPerSide: spreadBps / 2 };
}

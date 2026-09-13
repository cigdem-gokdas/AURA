import { describe, expect, it } from 'vitest';
import { costContextFromOkxTakerFee } from '../../src/signal/cost.js';
import { generateCandidate } from '../../src/signal/generate.js';
import { features, flat, regime } from './fixtures.js';

describe('actual OKX negative fee convention', () => {
  it('treats taker=-0.001 as a positive 10 bps per-side cost', () => {
    const cost = costContextFromOkxTakerFee(-0.001, 2);
    expect(cost).toEqual({ feeBpsPerSide: 10, estimatedSlippageBpsPerSide: 1 });
    const candidate = generateCandidate('BTC-USDT', features('BTC-USDT'), regime('BTC-USDT'), flat, cost);
    expect(candidate.estimatedRoundTripCostBps).toBe(24);
    expect(candidate.estimatedRoundTripCostBps).toBeGreaterThan(0);
  });

  it('fails closed on invalid fee data', () => {
    expect(() => costContextFromOkxTakerFee(NaN, 2)).toThrow();
    expect(() => costContextFromOkxTakerFee(-0.001, -1)).toThrow();
  });
});

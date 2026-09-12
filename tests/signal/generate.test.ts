import { describe, expect, it } from 'vitest';
import {
  generateCandidate,
  SignalGenerationError,
} from '../../src/signal/generate.js';
import { costs, features, flat, regime } from './fixtures.js';

describe('generateCandidate', () => {
  it.each(['BTC-USDT', 'ETH-USDT'])(
    'proposes a %s trend continuation long',
    (symbol) => {
      const candidate = generateCandidate(
        symbol,
        features(symbol),
        regime(symbol),
        flat,
        costs,
      );
      expect(candidate).toMatchObject({
        symbol,
        action: 'BUY',
        intent: 'OPEN_LONG',
        setupType: 'TREND_CONTINUATION',
        regime: 'TRENDING_UP',
        opportunityScore: 84,
        estimatedMoveBps: 50,
        estimatedRoundTripCostBps: 8,
        edgeToCostRatio: 6.25,
        clearsEstimatedCosts: true,
        timestamp: 1_000_000,
      });
      expect(candidate.scoreBreakdown).toEqual({
        regimeStructure: 30,
        momentumOrReversion: 15,
        volumeQuality: 10,
        orderBookImbalance: 5,
        micropriceQuality: 5,
        spreadQuality: 9,
        dataQuality: 10,
        total: 84,
      });
      expect(candidate.rejectionCategories).toEqual([]);
      expect(candidate.bullEvidence.length).toBeGreaterThan(0);
    },
  );

  it.each(['BTC-USDT', 'ETH-USDT'])(
    'proposes a %s range mean-reversion long',
    (symbol) => {
      const candidate = generateCandidate(
        symbol,
        features(symbol),
        regime(symbol, 'RANGE'),
        flat,
        costs,
      );
      expect(candidate).toMatchObject({
        symbol,
        action: 'BUY',
        intent: 'OPEN_LONG',
        setupType: 'RANGE_MEAN_REVERSION',
        regime: 'RANGE',
        opportunityScore: 77.5,
        estimatedMoveBps: 75,
        estimatedRoundTripCostBps: 8,
        edgeToCostRatio: 9.375,
      });
    },
  );

  it('requires trend return and EMA alignment, and range z-score below -1.25', () => {
    expect(
      generateCandidate(
        'BTC-USDT',
        features('BTC-USDT', { return5: 0 }),
        regime('BTC-USDT'),
        flat,
        costs,
      ),
    ).toMatchObject({ action: 'HOLD', intent: 'NONE', setupType: 'NONE' });
    expect(
      generateCandidate(
        'BTC-USDT',
        features('BTC-USDT', { emaFast: 99 }),
        regime('BTC-USDT'),
        flat,
        costs,
      ).action,
    ).toBe('HOLD');
    expect(
      generateCandidate(
        'BTC-USDT',
        features('BTC-USDT', { zScore20: -1.25 }),
        regime('BTC-USDT', 'RANGE'),
        flat,
        costs,
      ).action,
    ).toBe('HOLD');
  });

  it('treats volume and mild negative OBI as quality, while adverse OBI vetoes BUY', () => {
    const lowVolume = generateCandidate(
      'BTC-USDT',
      features('BTC-USDT', { volume: 0 }),
      regime('BTC-USDT'),
      flat,
      costs,
    );
    expect(lowVolume.action).toBe('BUY');
    expect(lowVolume.scoreBreakdown.volumeQuality).toBe(0);
    const mild = generateCandidate(
      'BTC-USDT',
      features('BTC-USDT', { obiTop5: -0.2 }),
      regime('BTC-USDT'),
      flat,
      costs,
    );
    expect(mild.action).toBe('BUY');
    expect(mild.scoreBreakdown.orderBookImbalance).toBe(3);
    const adverse = generateCandidate(
      'BTC-USDT',
      features('BTC-USDT', { obiTop5: -0.25 }),
      regime('BTC-USDT'),
      flat,
      costs,
    );
    expect(adverse.action).toBe('HOLD');
    expect(adverse.intent).toBe('NONE');
    expect(adverse.rejectionCategories).toContain('ADVERSE_MICROSTRUCTURE');
  });

  it('scores OBI, microprice, volume, spread, and freshness monotonically without symbol thresholds', () => {
    function result(symbol: string, overrides = {}) {
      return generateCandidate(
        symbol,
        features(symbol, overrides),
        regime(symbol),
        flat,
        costs,
      );
    }
    const weak = result('BTC-USDT', {
      obiTop5: -0.1,
      micropriceLeanBps: -4,
      volume: 50,
      spreadBps: 4,
      dataAgeMs: 5_000,
    });
    const strong = result('ETH-USDT', {
      obiTop5: 0.4,
      micropriceLeanBps: 4,
      volume: 150,
      spreadBps: 2,
      dataAgeMs: 0,
    });
    expect(strong.scoreBreakdown.orderBookImbalance).toBeGreaterThan(
      weak.scoreBreakdown.orderBookImbalance,
    );
    expect(strong.scoreBreakdown.micropriceQuality).toBeGreaterThan(
      weak.scoreBreakdown.micropriceQuality,
    );
    expect(strong.scoreBreakdown.volumeQuality).toBeGreaterThan(
      weak.scoreBreakdown.volumeQuality,
    );
    expect(strong.scoreBreakdown.spreadQuality).toBeGreaterThan(
      weak.scoreBreakdown.spreadQuality,
    );
    expect(strong.scoreBreakdown.dataQuality).toBeGreaterThan(
      weak.scoreBreakdown.dataQuality,
    );
    expect(strong.opportunityScore).toBeGreaterThan(weak.opportunityScore);
  });

  it('keeps OQS components in 0..100 and emits no nonfinite numeric fields', () => {
    const high = generateCandidate(
      'BTC-USDT',
      features('BTC-USDT', {
        return5: 100,
        volume: 1_000_000,
        obiTop5: 1,
        micropriceLeanBps: 1_000,
        spreadBps: 0,
      }),
      regime('BTC-USDT'),
      flat,
      costs,
    );
    expect(high.opportunityScore).toBe(100);
    const low = generateCandidate(
      'ETH-USDT',
      features('ETH-USDT', {
        volume: 0,
        obiTop5: -1,
        micropriceLeanBps: -1_000,
        spreadBps: 100,
        dataAgeMs: 20_000,
      }),
      regime('ETH-USDT', 'UNCERTAIN'),
      flat,
      costs,
    );
    expect(low.opportunityScore).toBe(0);
    for (const candidate of [high, low]) {
      for (const value of Object.values(candidate.scoreBreakdown)) {
        expect(Number.isFinite(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
      }
      expect(candidate.opportunityScore).toBeLessThanOrEqual(100);
      expect(Number.isFinite(candidate.edgeToCostRatio)).toBe(true);
      expect(Number.isFinite(candidate.estimatedMoveBps)).toBe(true);
    }
  });

  it('applies round-trip cost, edge, and score gates independently', () => {
    const costly = generateCandidate(
      'BTC-USDT',
      features('BTC-USDT'),
      regime('BTC-USDT'),
      flat,
      { feeBpsPerSide: 20, estimatedSlippageBpsPerSide: 10 },
    );
    expect(costly.estimatedRoundTripCostBps).toBe(62);
    expect(costly.edgeToCostRatio).toBeCloseTo(50 / 62, 10);
    expect(costly).toMatchObject({
      action: 'HOLD',
      clearsEstimatedCosts: false,
    });
    expect(costly.rejectionCategories).toContain('COST_GATE');

    const poorScore = generateCandidate(
      'BTC-USDT',
      features('BTC-USDT', {
        volume: 0,
        obiTop5: -0.2,
        micropriceLeanBps: -20,
        dataAgeMs: 10_000,
      }),
      regime('BTC-USDT'),
      flat,
      costs,
    );
    expect(poorScore.opportunityScore).toBe(57);
    expect(poorScore.clearsEstimatedCosts).toBe(true);
    expect(poorScore.action).toBe('HOLD');
    expect(poorScore.rejectionCategories).toContain('SCORE_GATE');
    expect(poorScore.rejectionCategories).not.toContain('COST_GATE');

    const zeroCost = generateCandidate(
      'BTC-USDT',
      features('BTC-USDT', { spreadBps: 0 }),
      regime('BTC-USDT'),
      flat,
      { feeBpsPerSide: 0, estimatedSlippageBpsPerSide: 0 },
    );
    expect(zeroCost.edgeToCostRatio).toBe(0);
    expect(zeroCost.clearsEstimatedCosts).toBe(false);
    expect(zeroCost.rejectionCategories).toContain('COST_GATE');
  });

  it('exits only a long in the same symbol and never proposes a short', () => {
    const btcLong = { openLong: { symbol: 'BTC-USDT', quantity: 1 } };
    const ethLong = { openLong: { symbol: 'ETH-USDT', quantity: 1 } };
    const btcDown = generateCandidate(
      'BTC-USDT',
      features('BTC-USDT'),
      regime('BTC-USDT', 'TRENDING_DOWN'),
      btcLong,
      costs,
    );
    expect(btcDown).toMatchObject({
      symbol: 'BTC-USDT',
      action: 'SELL',
      intent: 'CLOSE_LONG',
      setupType: 'DETERMINISTIC_EXIT',
    });
    expect(
      generateCandidate(
        'BTC-USDT',
        features('BTC-USDT'),
        regime('BTC-USDT', 'TRENDING_DOWN'),
        ethLong,
        costs,
      ).action,
    ).toBe('HOLD');
    const ethRangeExit = generateCandidate(
      'ETH-USDT',
      features('ETH-USDT', { zScore20: 1.26 }),
      regime('ETH-USDT', 'RANGE'),
      ethLong,
      costs,
    );
    expect(ethRangeExit).toMatchObject({
      action: 'SELL',
      intent: 'CLOSE_LONG',
    });
    expect(
      generateCandidate(
        'ETH-USDT',
        features('ETH-USDT', { zScore20: 1.25 }),
        regime('ETH-USDT', 'RANGE'),
        ethLong,
        costs,
      ).action,
    ).toBe('HOLD');
    expect(
      [btcDown, ethRangeExit].every(
        (candidate) => candidate.intent === 'CLOSE_LONG',
      ),
    ).toBe(true);
  });

  it('does not enter in high-volatility or uncertain regimes, or add to its own long', () => {
    for (const stable of ['HIGH_VOLATILITY', 'UNCERTAIN'] as const) {
      expect(
        generateCandidate(
          'BTC-USDT',
          features('BTC-USDT'),
          regime('BTC-USDT', stable),
          flat,
          costs,
        ),
      ).toMatchObject({ action: 'HOLD', intent: 'NONE' });
    }
    expect(
      generateCandidate(
        'BTC-USDT',
        features('BTC-USDT'),
        regime('BTC-USDT'),
        { openLong: { symbol: 'BTC-USDT', quantity: 1 } },
        costs,
      ).rejectionCategories,
    ).toContain('ALREADY_LONG');
    expect(
      generateCandidate(
        'BTC-USDT',
        features('BTC-USDT'),
        regime('BTC-USDT'),
        { openLong: { symbol: 'ETH-USDT', quantity: 1 } },
        costs,
      ).action,
    ).toBe('BUY');
  });

  it('keeps BTC numeric behavior unchanged across BTC → ETH → BTC calls', () => {
    const btcOnly = generateCandidate(
      'BTC-USDT',
      features('BTC-USDT'),
      regime('BTC-USDT'),
      flat,
      costs,
    );
    const firstBtc = generateCandidate(
      'BTC-USDT',
      features('BTC-USDT'),
      regime('BTC-USDT'),
      flat,
      costs,
    );
    const eth = generateCandidate(
      'ETH-USDT',
      features('ETH-USDT'),
      regime('ETH-USDT'),
      flat,
      costs,
    );
    const secondBtc = generateCandidate(
      'BTC-USDT',
      features('BTC-USDT'),
      regime('BTC-USDT'),
      flat,
      costs,
    );
    expect(firstBtc).toEqual(btcOnly);
    expect(secondBtc).toEqual(btcOnly);
    expect(eth.symbol).toBe('ETH-USDT');
    expect(eth.opportunityScore).toBe(btcOnly.opportunityScore);
    expect(eth.edgeToCostRatio).toBe(btcOnly.edgeToCostRatio);
  });

  it('rejects mismatched symbols and invalid numeric inputs', () => {
    expect(() =>
      generateCandidate(
        'BTC-USDT',
        features('ETH-USDT'),
        regime('BTC-USDT'),
        flat,
        costs,
      ),
    ).toThrow(SignalGenerationError);
    expect(() =>
      generateCandidate(
        'BTC-USDT',
        features('BTC-USDT'),
        regime('ETH-USDT'),
        flat,
        costs,
      ),
    ).toThrow(SignalGenerationError);
    expect(() =>
      generateCandidate(
        'BTC-USDT',
        features('BTC-USDT', { obiTop5: NaN }),
        regime('BTC-USDT'),
        flat,
        costs,
      ),
    ).toThrow(SignalGenerationError);
    expect(() =>
      generateCandidate(
        'BTC-USDT',
        features('BTC-USDT'),
        regime('BTC-USDT'),
        flat,
        { feeBpsPerSide: Infinity, estimatedSlippageBpsPerSide: 1 },
      ),
    ).toThrow(SignalGenerationError);
  });
});

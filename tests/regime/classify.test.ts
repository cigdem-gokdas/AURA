import { describe, expect, it } from 'vitest';
import type { FeatureSnapshot } from '../../src/features/types.js';
import {
  classifyRawRegime,
  initialRegimeState,
  RegimeClassificationError,
  transitionRegime,
} from '../../src/regime/classify.js';

function features(
  symbol: string,
  overrides: Partial<FeatureSnapshot> = {},
): FeatureSnapshot {
  return {
    symbol,
    timestamp: 1_000_000,
    close: 100,
    bestBid: 99,
    bestAsk: 101,
    midPrice: 100,
    emaFast: 102,
    emaSlow: 100,
    adx: 30,
    atr: 1,
    atrPct: 0.01,
    atrPctPercentile: 0.5,
    volume: 1,
    volumeSma20: 1,
    return5: 0,
    zScore20: 0,
    obiTop5: 0,
    spreadBps: 200,
    microprice: 100,
    micropriceLeanBps: 0,
    dataAgeMs: 0,
    ...overrides,
  };
}

describe('classifyRawRegime', () => {
  it('classifies up, down, range, uncertain, and high volatility', () => {
    expect(classifyRawRegime('BTC-USDT', features('BTC-USDT'))).toBe(
      'TRENDING_UP',
    );
    expect(
      classifyRawRegime(
        'BTC-USDT',
        features('BTC-USDT', {
          emaFast: 98,
        }),
      ),
    ).toBe('TRENDING_DOWN');
    expect(
      classifyRawRegime(
        'BTC-USDT',
        features('BTC-USDT', {
          adx: 20,
          atrPctPercentile: 0.69,
        }),
      ),
    ).toBe('RANGE');
    expect(
      classifyRawRegime(
        'BTC-USDT',
        features('BTC-USDT', {
          adx: 22,
        }),
      ),
    ).toBe('UNCERTAIN');
    expect(
      classifyRawRegime(
        'BTC-USDT',
        features('BTC-USDT', {
          adx: 30,
          atrPctPercentile: 0.91,
        }),
      ),
    ).toBe('HIGH_VOLATILITY');
  });

  it('honors strict threshold boundaries and high-volatility precedence', () => {
    expect(
      classifyRawRegime(
        'BTC-USDT',
        features('BTC-USDT', {
          adx: 25,
        }),
      ),
    ).toBe('UNCERTAIN');
    expect(
      classifyRawRegime(
        'BTC-USDT',
        features('BTC-USDT', {
          adx: 25.001,
        }),
      ),
    ).toBe('TRENDING_UP');
    expect(
      classifyRawRegime(
        'BTC-USDT',
        features('BTC-USDT', {
          adx: 20,
          atrPctPercentile: 0.7,
        }),
      ),
    ).toBe('UNCERTAIN');
    expect(
      classifyRawRegime(
        'BTC-USDT',
        features('BTC-USDT', {
          adx: 20,
          atrPctPercentile: 0.699,
        }),
      ),
    ).toBe('RANGE');
    expect(
      classifyRawRegime(
        'BTC-USDT',
        features('BTC-USDT', {
          atrPctPercentile: 0.9,
        }),
      ),
    ).toBe('TRENDING_UP');
    expect(
      classifyRawRegime(
        'BTC-USDT',
        features('BTC-USDT', {
          atrPctPercentile: 0.9001,
        }),
      ),
    ).toBe('HIGH_VOLATILITY');
  });

  it('rejects mismatched symbols and invalid classification inputs', () => {
    expect(() => classifyRawRegime('ETH-USDT', features('BTC-USDT'))).toThrow(
      RegimeClassificationError,
    );
    expect(() =>
      classifyRawRegime(
        'BTC-USDT',
        features('BTC-USDT', {
          adx: NaN,
        }),
      ),
    ).toThrow(RegimeClassificationError);
    expect(() =>
      classifyRawRegime(
        'BTC-USDT',
        features('BTC-USDT', {
          atrPctPercentile: Infinity,
        }),
      ),
    ).toThrow(RegimeClassificationError);
  });

  it('uses identical thresholds for identical BTC and ETH feature values', () => {
    const btc = features('BTC-USDT', { adx: 20, atrPctPercentile: 0.69 });
    const eth = features('ETH-USDT', { adx: 20, atrPctPercentile: 0.69 });
    expect(classifyRawRegime('BTC-USDT', btc)).toBe(
      classifyRawRegime('ETH-USDT', eth),
    );
    const btcTransition = transitionRegime('BTC-USDT', btc, null);
    const ethTransition = transitionRegime('ETH-USDT', eth, null);
    expect({ ...ethTransition.decision, symbol: 'BTC-USDT' }).toEqual(
      btcTransition.decision,
    );
  });
});

describe('transitionRegime', () => {
  it('requires two consecutive matching normal proposals', () => {
    const initial = initialRegimeState('BTC-USDT');
    const first = transitionRegime('BTC-USDT', features('BTC-USDT'), initial);
    expect(first.decision).toMatchObject({
      symbol: 'BTC-USDT',
      stableRegime: 'UNCERTAIN',
      rawProposedRegime: 'TRENDING_UP',
      transitioned: false,
    });
    expect(first.nextState).toMatchObject({
      pendingRegime: 'TRENDING_UP',
      pendingCount: 1,
    });
    const second = transitionRegime(
      'BTC-USDT',
      features('BTC-USDT'),
      first.nextState,
    );
    expect(second.decision).toMatchObject({
      stableRegime: 'TRENDING_UP',
      transitioned: true,
    });
    expect(second.nextState.pendingRegime).toBeNull();
    expect(initial).toEqual({
      symbol: 'BTC-USDT',
      stableRegime: 'UNCERTAIN',
      pendingRegime: null,
      pendingCount: 0,
    });
  });

  it('activates high volatility immediately but takes two observations to leave it', () => {
    const high = features('BTC-USDT', { atrPctPercentile: 0.91 });
    const first = transitionRegime('BTC-USDT', high, null);
    expect(first.decision).toMatchObject({
      stableRegime: 'HIGH_VOLATILITY',
      transitioned: true,
    });
    const range = features('BTC-USDT', { adx: 15, atrPctPercentile: 0.4 });
    const leaving = transitionRegime('BTC-USDT', range, first.nextState);
    expect(leaving.decision).toMatchObject({
      stableRegime: 'HIGH_VOLATILITY',
      transitioned: false,
    });
    expect(leaving.nextState.pendingRegime).toBe('RANGE');
    const left = transitionRegime('BTC-USDT', range, leaving.nextState);
    expect(left.decision).toMatchObject({
      stableRegime: 'RANGE',
      transitioned: true,
    });
  });

  it('resets a pending proposal when the next raw proposal differs', () => {
    const up = transitionRegime('BTC-USDT', features('BTC-USDT'), null);
    const down = transitionRegime(
      'BTC-USDT',
      features('BTC-USDT', { emaFast: 98 }),
      up.nextState,
    );
    expect(down.decision.stableRegime).toBe('UNCERTAIN');
    expect(down.nextState).toMatchObject({
      pendingRegime: 'TRENDING_DOWN',
      pendingCount: 1,
    });
  });

  it('keeps BTC and ETH hysteresis independent with externally owned states', () => {
    const btcPending = transitionRegime('BTC-USDT', features('BTC-USDT'), null);
    const ethPending = transitionRegime(
      'ETH-USDT',
      features('ETH-USDT', { emaFast: 98 }),
      null,
    );
    const btcUp = transitionRegime(
      'BTC-USDT',
      features('BTC-USDT'),
      btcPending.nextState,
    );
    expect(btcUp.nextState.stableRegime).toBe('TRENDING_UP');
    expect(ethPending.nextState).toMatchObject({
      symbol: 'ETH-USDT',
      stableRegime: 'UNCERTAIN',
      pendingRegime: 'TRENDING_DOWN',
    });
    const ethDown = transitionRegime(
      'ETH-USDT',
      features('ETH-USDT', { emaFast: 98 }),
      ethPending.nextState,
    );
    expect(ethDown.nextState.stableRegime).toBe('TRENDING_DOWN');
    expect(btcUp.nextState.stableRegime).toBe('TRENDING_UP');
    expect(() =>
      transitionRegime('ETH-USDT', features('ETH-USDT'), btcPending.nextState),
    ).toThrow('Regime state symbol mismatch');
  });
});

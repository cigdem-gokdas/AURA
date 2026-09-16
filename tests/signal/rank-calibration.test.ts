import { describe, expect, it } from 'vitest';
import { generateCandidate } from '../../src/signal/generate.js';
import { rankEntryCandidates } from '../../src/signal/rank.js';
import { summarizeSignalCalibration } from '../../src/signal/calibration.js';
import type { CandidateSignal } from '../../src/signal/types.js';
import { costs, features, flat, regime } from './fixtures.js';

function entry(
  symbol: string,
  opportunityScore: number,
  edgeToCostRatio: number,
): CandidateSignal {
  return {
    ...generateCandidate(symbol, features(symbol), regime(symbol), flat, costs),
    opportunityScore,
    edgeToCostRatio,
  };
}

describe('rankEntryCandidates', () => {
  it('places ETH OQS 80 above BTC 70, and BTC OQS 80 above ETH 70', () => {
    expect(
      rankEntryCandidates([
        entry('BTC-USDT', 70, 5),
        entry('ETH-USDT', 80, 1),
      ]).map((candidate) => candidate.symbol),
    ).toEqual(['ETH-USDT', 'BTC-USDT']);
    expect(
      rankEntryCandidates([
        entry('ETH-USDT', 70, 5),
        entry('BTC-USDT', 80, 1),
      ]).map((candidate) => candidate.symbol),
    ).toEqual(['BTC-USDT', 'ETH-USDT']);
  });

  it('uses edge/cost after equal OQS and lexical symbol after exact tie', () => {
    expect(
      rankEntryCandidates([
        entry('BTC-USDT', 80, 2),
        entry('ETH-USDT', 80, 3),
      ]).map((candidate) => candidate.symbol),
    ).toEqual(['ETH-USDT', 'BTC-USDT']);
    expect(
      rankEntryCandidates([
        entry('ETH-USDT', 80, 3),
        entry('BTC-USDT', 80, 3),
      ]).map((candidate) => candidate.symbol),
    ).toEqual(['BTC-USDT', 'ETH-USDT']);
  });

  it('excludes HOLD and CLOSE_LONG and never mutates input', () => {
    const buy = entry('BTC-USDT', 80, 3);
    const hold = generateCandidate(
      'ETH-USDT',
      features('ETH-USDT'),
      regime('ETH-USDT', 'UNCERTAIN'),
      flat,
      costs,
    );
    const close = generateCandidate(
      'ETH-USDT',
      features('ETH-USDT'),
      regime('ETH-USDT', 'TRENDING_DOWN'),
      { openLong: { symbol: 'ETH-USDT', quantity: 1 } },
      costs,
    );
    const source = [close, hold, buy];
    expect(rankEntryCandidates(source)).toEqual([buy]);
    expect(source).toEqual([close, hold, buy]);
  });
});

describe('summarizeSignalCalibration', () => {
  it('groups counts, distributions, and rejection categories by symbol and universe', () => {
    const buy = generateCandidate(
      'BTC-USDT',
      features('BTC-USDT'),
      regime('BTC-USDT'),
      flat,
      costs,
    );
    const adverse = generateCandidate(
      'BTC-USDT',
      features('BTC-USDT', { obiTop5: -0.3 }),
      regime('BTC-USDT'),
      flat,
      costs,
    );
    const close = generateCandidate(
      'ETH-USDT',
      features('ETH-USDT'),
      regime('ETH-USDT', 'TRENDING_DOWN'),
      { openLong: { symbol: 'ETH-USDT', quantity: 1 } },
      costs,
    );
    const costReject = generateCandidate(
      'ETH-USDT',
      features('ETH-USDT'),
      regime('ETH-USDT'),
      flat,
      { feeBpsPerSide: 300, estimatedSlippageBpsPerSide: 100 },
    );
    const scoreReject = generateCandidate(
      'ETH-USDT',
      features('ETH-USDT', {
        volume: 0,
        obiTop5: -0.2,
        micropriceLeanBps: -20,
        dataAgeMs: 10_000,
      }),
      regime('ETH-USDT'),
      flat,
      costs,
    );
    const diagnostics = summarizeSignalCalibration([
      buy,
      adverse,
      close,
      costReject,
      scoreReject,
    ]);
    expect(diagnostics.combined).toMatchObject({
      symbol: null,
      evaluated: 5,
      buyProposals: 1,
      sellProposals: 1,
      holdCount: 3,
      adverseMicrostructureRejects: 1,
      costGateRejects: 1,
      scoreGateRejects: 1,
      eligibleEntries: 1,
    });
    expect(diagnostics.bySymbol['BTC-USDT']).toMatchObject({
      symbol: 'BTC-USDT',
      evaluated: 2,
      buyProposals: 1,
      sellProposals: 0,
      holdCount: 1,
      adverseMicrostructureRejects: 1,
      eligibleEntries: 1,
    });
    expect(diagnostics.bySymbol['ETH-USDT']).toMatchObject({
      symbol: 'ETH-USDT',
      evaluated: 3,
      buyProposals: 0,
      sellProposals: 1,
      holdCount: 2,
      costGateRejects: 1,
      scoreGateRejects: 1,
    });
    expect(diagnostics.combined.oqsDistribution).toEqual(
      [...diagnostics.combined.oqsDistribution].sort((a, b) => a - b),
    );
    expect(diagnostics.combined.edgeCostDistribution).toEqual(
      [...diagnostics.combined.edgeCostDistribution].sort((a, b) => a - b),
    );
    expect(diagnostics.combined.rejectionHistogram).toMatchObject({
      ADVERSE_MICROSTRUCTURE: 1,
      COST_GATE: 1,
      SCORE_GATE: 1,
    });
  });

  it('returns empty diagnostics without selecting or tuning anything', () => {
    const diagnostics = summarizeSignalCalibration([]);
    expect(diagnostics.bySymbol).toEqual({});
    expect(diagnostics.combined).toMatchObject({
      evaluated: 0,
      eligibleEntries: 0,
      oqsDistribution: [],
      edgeCostDistribution: [],
    });
  });
});

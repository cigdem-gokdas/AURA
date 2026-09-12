import { SignalGenerationError } from './generate.js';
import type { CandidateSignal } from './types.js';

/** Pure ordering of already-generated entry proposals; it selects no position. */
export function rankEntryCandidates(
  candidates: readonly CandidateSignal[],
): CandidateSignal[] {
  const entries = candidates.filter(
    (candidate) =>
      candidate.action === 'BUY' && candidate.intent === 'OPEN_LONG',
  );
  for (const candidate of entries) {
    if (
      !candidate.symbol ||
      !Number.isFinite(candidate.opportunityScore) ||
      candidate.opportunityScore < 0 ||
      candidate.opportunityScore > 100 ||
      !Number.isFinite(candidate.edgeToCostRatio) ||
      candidate.edgeToCostRatio < 0
    ) {
      throw new SignalGenerationError('Invalid entry candidate for ranking');
    }
  }
  return entries.sort((left, right) => {
    const scoreOrder = right.opportunityScore - left.opportunityScore;
    if (scoreOrder !== 0) return scoreOrder;
    const edgeOrder = right.edgeToCostRatio - left.edgeToCostRatio;
    if (edgeOrder !== 0) return edgeOrder;
    return left.symbol < right.symbol ? -1 : left.symbol > right.symbol ? 1 : 0;
  });
}

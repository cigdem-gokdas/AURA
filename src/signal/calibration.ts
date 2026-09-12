import { SignalGenerationError } from './generate.js';
import type {
  CandidateSignal,
  SignalCalibrationDiagnostics,
  SignalCalibrationSummary,
  SignalRejectionCategory,
} from './types.js';

const REJECTION_CATEGORIES: readonly SignalRejectionCategory[] = [
  'NO_SETUP',
  'ALREADY_LONG',
  'ADVERSE_MICROSTRUCTURE',
  'COST_GATE',
  'SCORE_GATE',
];

function summarize(
  symbol: string | null,
  candidates: readonly CandidateSignal[],
): SignalCalibrationSummary {
  const rejectionHistogram = Object.fromEntries(
    REJECTION_CATEGORIES.map((category) => [category, 0]),
  ) as Record<SignalRejectionCategory, number>;
  for (const candidate of candidates) {
    if (
      !candidate.symbol ||
      !Number.isFinite(candidate.opportunityScore) ||
      candidate.opportunityScore < 0 ||
      candidate.opportunityScore > 100 ||
      !Number.isFinite(candidate.edgeToCostRatio) ||
      candidate.edgeToCostRatio < 0
    ) {
      throw new SignalGenerationError('Invalid candidate for calibration');
    }
    for (const category of new Set(candidate.rejectionCategories)) {
      if (!REJECTION_CATEGORIES.includes(category)) {
        throw new SignalGenerationError('Unknown signal rejection category');
      }
      rejectionHistogram[category] += 1;
    }
  }
  return {
    symbol,
    evaluated: candidates.length,
    buyProposals: candidates.filter((candidate) => candidate.action === 'BUY')
      .length,
    sellProposals: candidates.filter((candidate) => candidate.action === 'SELL')
      .length,
    holdCount: candidates.filter((candidate) => candidate.action === 'HOLD')
      .length,
    oqsDistribution: candidates
      .map((candidate) => candidate.opportunityScore)
      .sort((a, b) => a - b),
    edgeCostDistribution: candidates
      .map((candidate) => candidate.edgeToCostRatio)
      .sort((a, b) => a - b),
    rejectionHistogram,
    adverseMicrostructureRejects: rejectionHistogram.ADVERSE_MICROSTRUCTURE,
    costGateRejects: rejectionHistogram.COST_GATE,
    scoreGateRejects: rejectionHistogram.SCORE_GATE,
    eligibleEntries: candidates.filter(
      (candidate) =>
        candidate.action === 'BUY' && candidate.intent === 'OPEN_LONG',
    ).length,
  };
}

/** Diagnostics only: no threshold tuning or candidate selection. */
export function summarizeSignalCalibration(
  candidates: readonly CandidateSignal[],
): SignalCalibrationDiagnostics {
  const symbols = [
    ...new Set(candidates.map((candidate) => candidate.symbol)),
  ].sort();
  return {
    combined: summarize(null, candidates),
    bySymbol: Object.fromEntries(
      symbols.map((symbol) => [
        symbol,
        summarize(
          symbol,
          candidates.filter((candidate) => candidate.symbol === symbol),
        ),
      ]),
    ),
  };
}

import type { SelectedCandidateContext } from './types.js';

export const MARKET_CRITIC_INSTRUCTIONS = `You are AURA's market critic. The deterministic system has already selected exactly one eligible entry candidate. Validate only that candidate. Never change the selected symbol. Do not scan, rank, select, or recommend another symbol. The other-symbol data is informational context only: never suggest trading it instead or create its candidate. Never create a trade from HOLD, reverse into a short, choose quantity, size, notional, stop, take profit, bypass risk, or call execution. Return only the required JSON decision. AGREE, DISAGREE, or ABSTAIN; a valid AGREE only permits later independent risk checks. Critically assess setup coherence, regime agreement, microstructure, counter-thesis, recent chop/loss/momentum patterns, and whether the move is specific or a short-lived broad crypto-market move. Do not provide hidden chain-of-thought.`;

function safeEvidence(values: readonly string[], secretValues: readonly string[]): string[] {
  return values.slice(0, 5).map(value => {
    let safe = value;
    for (const secret of secretValues) if (secret) safe = safe.split(secret).join('[REDACTED]');
    return safe
      .replace(/sk-[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
      .replace(/(?:api[_ -]?key|passphrase|authorization)\s*[:=]\s*\S+/gi, '[REDACTED]')
      .slice(0, 120);
  });
}

/** Whitelist all transmitted fields; never serialize the full caller object. */
export function buildSelectedCandidateInput(context: SelectedCandidateContext, secretValues: readonly string[] = []): string {
  const { candidate, crossMarket, microstructure, position } = context;
  const memory = [...context.recentMemory]
    .filter(item => Number.isFinite(item.timestamp))
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, 5)
    .map(item => ({
      symbol: item.symbol, setupType: item.setupType, regime: item.regime,
      resultCategory: item.resultCategory, outcomeR: Number.isFinite(item.outcomeR) ? item.outcomeR : null,
      stopHit: item.stopHit, timestamp: item.timestamp,
    }));
  return JSON.stringify({
    selectedCandidate: {
      symbol: candidate.symbol, action: candidate.action, intent: candidate.intent,
      opportunityScore: candidate.opportunityScore,
      scoreBreakdown: {
        regimeStructure: candidate.scoreBreakdown.regimeStructure,
        momentumOrReversion: candidate.scoreBreakdown.momentumOrReversion,
        volumeQuality: candidate.scoreBreakdown.volumeQuality,
        orderBookImbalance: candidate.scoreBreakdown.orderBookImbalance,
        micropriceQuality: candidate.scoreBreakdown.micropriceQuality,
        spreadQuality: candidate.scoreBreakdown.spreadQuality,
        dataQuality: candidate.scoreBreakdown.dataQuality,
        total: candidate.scoreBreakdown.total,
      },
      regime: candidate.regime, setupType: candidate.setupType,
      bullEvidence: safeEvidence(candidate.bullEvidence, secretValues), bearEvidence: safeEvidence(candidate.bearEvidence, secretValues),
      edgeToCostRatio: candidate.edgeToCostRatio,
      spreadBps: microstructure.spreadBps, obiTop5: microstructure.obiTop5,
      micropriceLeanBps: microstructure.micropriceLeanBps,
      position: { hasOpenLong: position.hasOpenLong, openLongSymbol: position.openLongSymbol },
      recentMemory: memory,
    },
    crossMarket: {
      selectedSymbol: crossMarket.selectedSymbol, selectedOQS: crossMarket.selectedOQS,
      otherSymbol: crossMarket.otherSymbol, otherOQS: crossMarket.otherOQS,
      otherRegime: crossMarket.otherRegime,
    },
  });
}

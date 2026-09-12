import { LlmDecisionSchema } from '../llm/types.js';
import type {
  PreTradeRiskInput, ProtectionPlan, RiskCertificate, RiskConfig, RiskGate,
  RiskGateName, RiskGateResult, RiskMode,
} from './types.js';

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const positive = (value: unknown): value is number => finite(value) && value > 0;
const fraction = (value: unknown): value is number => finite(value) && value > 0 && value <= 1;

function validConfig(config: RiskConfig): boolean {
  return Number.isSafeInteger(config.maxConcurrentPositions) && config.maxConcurrentPositions >= 1
    && fraction(config.maxTotalExposurePct) && fraction(config.riskPerTradePct)
    && fraction(config.maxRiskPerTradePct) && config.riskPerTradePct <= config.maxRiskPerTradePct
    && fraction(config.maxPositionPct)
    && fraction(config.softDrawdownPct) && fraction(config.defensiveDrawdownPct)
    && fraction(config.hardDailyLossPct) && fraction(config.hardPeakDrawdownPct)
    && config.softDrawdownPct < config.defensiveDrawdownPct
    && config.defensiveDrawdownPct < config.hardPeakDrawdownPct
    && finite(config.consecutiveLossPauseMinutes) && config.consecutiveLossPauseMinutes >= 15
    && config.consecutiveLossPauseMinutes <= 20
    && positive(config.maxDataAgeMs) && config.maxSpreadBps !== null
    && positive(config.maxSpreadBps) && fraction(config.maxAtrPercentile)
    && finite(config.opportunityScoreThreshold) && config.opportunityScoreThreshold >= 0
    && positive(config.minEdgeCostRatio) && positive(config.initialStopAtrMultiplier)
    && positive(config.breakEvenTriggerR) && positive(config.trailingActivationR)
    && positive(config.takeProfitR);
}

function validAccount(input: PreTradeRiskInput): boolean {
  const { account, timestamp } = input;
  return finite(timestamp) && timestamp >= 0 && positive(account.equity)
    && finite(account.availableQuoteBalance) && account.availableQuoteBalance >= 0
    && positive(account.dayStartEquity) && positive(account.peakEquity)
    && account.peakEquity >= account.equity
    && Number.isSafeInteger(account.consecutiveLosses) && account.consecutiveLosses >= 0
    && (account.lastLossTimestamp === null || (finite(account.lastLossTimestamp) && account.lastLossTimestamp <= timestamp))
    && finite(account.timestamp) && account.timestamp <= timestamp
    && account.openPositions.every(position => position.symbol.length > 0
      && positive(position.quantity) && positive(position.notional)
      && finite(position.exposurePct) && position.exposurePct >= 0 && position.exposurePct <= 1);
}

function modeFor(input: PreTradeRiskInput): RiskMode {
  const { account, config } = input;
  if (input.killSwitchActive || !positive(account.dayStartEquity) || !positive(account.peakEquity) || !finite(account.equity)) return 'LOCKDOWN';
  const dailyLoss = (account.dayStartEquity - account.equity) / account.dayStartEquity;
  const peakDrawdown = (account.peakEquity - account.equity) / account.peakEquity;
  if (dailyLoss >= config.hardDailyLossPct || peakDrawdown >= config.hardPeakDrawdownPct) return 'LOCKDOWN';
  if (peakDrawdown >= config.defensiveDrawdownPct) return 'DEFENSIVE';
  if (peakDrawdown >= config.softDrawdownPct) return 'CAUTION';
  return 'NORMAL';
}

function protectionFor(input: PreTradeRiskInput): ProtectionPlan | null {
  const { market, config, candidate } = input;
  if (!candidate || !positive(market.referencePrice) || !positive(market.atr)
    || !positive(config.initialStopAtrMultiplier) || !positive(config.breakEvenTriggerR)
    || !positive(config.trailingActivationR) || !positive(config.takeProfitR)
    || input.protectionMode === 'UNAVAILABLE') return null;
  const stopDistanceAbsolute = market.atr * config.initialStopAtrMultiplier;
  const initialStopPrice = market.referencePrice - stopDistanceAbsolute;
  const stopDistanceFraction = stopDistanceAbsolute / market.referencePrice;
  if (!positive(stopDistanceAbsolute) || !positive(initialStopPrice)
    || !positive(stopDistanceFraction) || stopDistanceFraction >= 1) return null;
  return {
    symbol: candidate.symbol, initialStopPrice, stopDistanceAbsolute, stopDistanceFraction,
    breakEvenTriggerR: config.breakEvenTriggerR,
    trailingActivationR: config.trailingActivationR,
    takeProfitR: config.takeProfitR,
    protectionMode: input.protectionMode,
  };
}

/** Pure, final deterministic authority for one proposed spot-long entry. */
export function evaluateEntryRisk(input: PreTradeRiskInput): RiskGateResult {
  const { candidate, account, market, config, timestamp } = input;
  const gates: RiskGate[] = [];
  const gate = (name: RiskGateName, passed: boolean, reason: string): void => {
    gates.push({ name, status: passed ? 'PASS' : 'FAIL', reason: passed ? 'Passed' : reason });
  };
  const configOk = validConfig(config);
  const accountOk = validAccount(input);
  const marketOk = positive(market.referencePrice) && finite(market.spreadBps) && market.spreadBps >= 0
    && positive(market.atr) && finite(market.atrPctPercentile) && market.atrPctPercentile >= 0
    && market.atrPctPercentile <= 1 && finite(market.dataAgeMs) && market.dataAgeMs >= 0
    && finite(market.timestamp) && market.timestamp <= timestamp;
  const mode = modeFor(input);
  const dailyLoss = accountOk ? (account.dayStartEquity - account.equity) / account.dayStartEquity : Infinity;
  const peakDrawdown = accountOk ? (account.peakEquity - account.equity) / account.peakEquity : Infinity;
  const protection = protectionFor(input);
  const existingNotional = account.openPositions.reduce((sum, position) => sum + position.notional, 0);
  const multiplier = Math.min(
    mode === 'DEFENSIVE' ? 0.5 : mode === 'CAUTION' ? 0.75 : mode === 'LOCKDOWN' ? 0 : 1,
    account.consecutiveLosses >= 2 ? 0.5 : 1,
  );
  const riskAmount = account.equity * config.riskPerTradePct * multiplier;
  const rawNotional = protection ? riskAmount / protection.stopDistanceFraction : NaN;
  const singleCap = account.equity * config.maxPositionPct;
  const portfolioCap = account.equity * config.maxTotalExposurePct;
  const remainingExposure = portfolioCap - existingNotional;
  const sizingCeiling = Math.min(rawNotional, singleCap, remainingExposure, account.availableQuoteBalance);
  const proposedNotional = input.requestedNotional ?? sizingCeiling;
  const notionalValid = positive(proposedNotional) && Number.isFinite(proposedNotional);
  const llm = input.llmResult as { status?: unknown; decision?: unknown } | null;
  const llmReachable = llm !== null && typeof llm === 'object' && llm.status === 'SUCCESS';
  const parsedLlm = LlmDecisionSchema.safeParse(llmReachable ? llm?.decision : undefined);

  gate('CONFIG_VALID', configOk, 'Risk configuration invalid or spread ceiling unset');
  gate('INPUT_VALID', accountOk && marketOk, 'Account, market, or timestamp invalid');
  gate('DATA_FRESH', accountOk && marketOk && market.dataAgeMs <= config.maxDataAgeMs
    && timestamp - market.timestamp <= config.maxDataAgeMs
    && timestamp - account.timestamp <= config.maxDataAgeMs
    && (candidate === null || (finite(candidate.timestamp) && candidate.timestamp <= timestamp
      && timestamp - candidate.timestamp <= config.maxDataAgeMs)), 'Market, account, or candidate data stale');
  gate('CANDIDATE_EXISTS', candidate !== null && candidate.action === 'BUY' && candidate.intent === 'OPEN_LONG', 'No eligible OPEN_LONG candidate');
  gate('OPPORTUNITY_SCORE', candidate !== null && finite(candidate.opportunityScore)
    && candidate.opportunityScore >= config.opportunityScoreThreshold, 'Opportunity score below threshold');
  gate('EDGE_COST', candidate !== null && candidate.clearsEstimatedCosts
    && positive(candidate.estimatedMoveBps) && finite(candidate.estimatedRoundTripCostBps)
    && candidate.estimatedRoundTripCostBps >= 0 && finite(candidate.edgeToCostRatio)
    && candidate.edgeToCostRatio >= config.minEdgeCostRatio
    && (candidate.estimatedRoundTripCostBps === 0
      || candidate.estimatedMoveBps / candidate.estimatedRoundTripCostBps >= config.minEdgeCostRatio)
    && candidate.estimatedMoveBps > candidate.estimatedRoundTripCostBps, 'Estimated edge does not clear costs');
  gate('LLM_REACHABLE', llmReachable, 'LLM decision unavailable');
  gate('LLM_SCHEMA', llmReachable && parsedLlm.success, 'LLM decision failed Zod validation');
  gate('LLM_AGREE', parsedLlm.success && parsedLlm.data.action === 'AGREE', 'LLM did not AGREE');
  gate('LLM_RISK', parsedLlm.success && parsedLlm.data.risk_flag !== 'HIGH', 'LLM raised HIGH risk');
  gate('SPREAD', marketOk && config.maxSpreadBps !== null && market.spreadBps <= config.maxSpreadBps, 'Spread exceeds ceiling');
  gate('VOLATILITY', marketOk && market.atrPctPercentile <= config.maxAtrPercentile, 'Volatility exceeds ceiling');
  const lossPauseUntil = account.consecutiveLosses >= 3
    ? (account.lastLossTimestamp === null ? Infinity : account.lastLossTimestamp + config.consecutiveLossPauseMinutes * 60_000)
    : -Infinity;
  gate('COOLDOWN', timestamp >= lossPauseUntil && (input.cooldownUntil === null || timestamp >= input.cooldownUntil), 'Entry cooldown or three-loss pause active');
  gate('SINGLE_POSITION_CAP', notionalValid && proposedNotional <= singleCap
    && proposedNotional <= rawNotional, 'Proposed notional exceeds single-position or per-trade risk cap');
  gate('CROSS_SYMBOL_POSITION_CAP', account.openPositions.length < config.maxConcurrentPositions,
    `CROSS_SYMBOL_POSITION_CAP: ${account.openPositions.map(position => position.symbol).join(', ')} already open`);
  gate('TOTAL_EXPOSURE_CAP', notionalValid && existingNotional + proposedNotional <= portfolioCap,
    'Existing exposure plus proposed notional exceeds portfolio cap');
  gate('DAILY_LOSS', dailyLoss < config.hardDailyLossPct, 'Hard daily-loss threshold reached');
  gate('PEAK_DRAWDOWN', peakDrawdown < config.hardPeakDrawdownPct, 'Hard peak-drawdown threshold reached');
  gate('SYMBOL_MATCH', candidate !== null && candidate.symbol.length > 0 && candidate.symbol === market.symbol,
    'Candidate and market symbols differ');
  gate('NO_AVERAGE_DOWN', candidate !== null && !account.openPositions.some(position => position.symbol === candidate.symbol),
    'Position already open in requested symbol');
  gate('AVAILABLE_BALANCE', notionalValid && proposedNotional <= account.availableQuoteBalance,
    'Notional exceeds available quote balance or is nonpositive');
  gate('PROTECTION_VALID', protection !== null && candidate !== null && protection.symbol === candidate.symbol,
    'ATR stop invalid or protection unavailable');
  gate('DUPLICATE_CLIENT_ORDER_ID', input.clientOrderId.trim().length > 0
    && !input.knownClientOrderIds.includes(input.clientOrderId)
    && input.cycleId.trim().length > 0 && input.decisionId.trim().length > 0,
    'Duplicate or missing client order/decision identifier');
  gate('KILL_SWITCH', !input.killSwitchActive, 'Kill switch active');
  gate('RISK_MODE', mode !== 'LOCKDOWN', 'Risk mode LOCKDOWN');

  // Report the hard portfolio invariant even when zero remaining capacity also
  // makes an earlier sizing gate fail. Every failed gate remains in the certificate.
  const failed = gates.find(result => result.name === 'CROSS_SYMBOL_POSITION_CAP' && result.status === 'FAIL')
    ?? gates.find(result => result.name === 'DAILY_LOSS' && result.status === 'FAIL')
    ?? gates.find(result => result.name === 'PEAK_DRAWDOWN' && result.status === 'FAIL')
    ?? gates.find(result => result.status === 'FAIL');
  const certificate: RiskCertificate = {
    requestedSymbol: candidate?.symbol ?? market.symbol,
    existingOpenPositionSymbols: account.openPositions.map(position => position.symbol),
    gates, verdict: failed ? 'REJECT' : 'ALLOW', riskMode: mode,
    calculatedNotional: notionalValid ? proposedNotional : null,
    protectionPlan: protection,
  };
  if (failed) return {
    decision: { approved: false, mode, reason: failed.reason, rejectionCategory: failed.name },
    certificate,
  };
  // All gates passed, so the following values are finite and symbol-consistent.
  return {
    decision: { approved: true, mode, reason: 'All entry gates passed', rejectionCategory: null },
    plan: {
      symbol: candidate!.symbol, side: 'BUY', quantity: proposedNotional / market.referencePrice,
      estimatedNotional: proposedNotional, referencePrice: market.referencePrice,
      protection: protection!, cycleId: input.cycleId, decisionId: input.decisionId,
      clientOrderId: input.clientOrderId,
    },
    certificate,
  };
}

import { describe, expect, it } from 'vitest';
import { riskConfigFromEnv } from '../../src/risk/config.js';
import { evaluateEntryRisk } from '../../src/risk/evaluate.js';
import { decideSubmissionRecovery, evaluateProtectiveExit } from '../../src/risk/protective.js';
import type { PreTradeRiskInput, RiskOpenPosition } from '../../src/risk/types.js';
import type { CandidateSignal } from '../../src/signal/types.js';

const now = 1_000_000;
const decision = {
  action: 'AGREE' as const, confidence: 0.51, regime_confirmation: 'TRENDING_UP' as const,
  setup_quality: 'A' as const, risk_flag: 'LOW' as const, reason: 'Coherent',
  counter_thesis: 'May fade', memory_signal: 'NONE' as const,
};
const llmResult = { status: 'SUCCESS' as const, decision, latencyMs: 100,
  usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, estimatedCostUsd: 0.0001 } };

function candidate(symbol: string): CandidateSignal {
  return {
    symbol, action: 'BUY', intent: 'OPEN_LONG', setupType: 'TREND_CONTINUATION', regime: 'TRENDING_UP',
    opportunityScore: 78, scoreBreakdown: {
      regimeStructure: 15, momentumOrReversion: 12, volumeQuality: 10,
      orderBookImbalance: 10, micropriceQuality: 10, spreadQuality: 11,
      dataQuality: 10, total: 78,
    },
    estimatedMoveBps: 30, estimatedRoundTripCostBps: 10, edgeToCostRatio: 3,
    clearsEstimatedCosts: true, bullEvidence: [], bearEvidence: [], reasons: [],
    rejectionCategories: [], timestamp: now,
  };
}

function input(symbol = 'BTC-USDT'): PreTradeRiskInput {
  return {
    candidate: candidate(symbol),
    market: { symbol, referencePrice: 100, spreadBps: 2, atr: 2, atrPctPercentile: 0.5, dataAgeMs: 0, timestamp: now },
    account: {
      equity: 10_000, availableQuoteBalance: 10_000, dayStartEquity: 10_000,
      peakEquity: 10_000, consecutiveLosses: 0, lastLossTimestamp: null,
      openPositions: [], timestamp: now,
    },
    config: riskConfigFromEnv({ MAX_SPREAD_BPS: '10' }),
    llmResult, timestamp: now, clientOrderId: 'order-1', knownClientOrderIds: [],
    cycleId: 'cycle-1', decisionId: 'decision-1', killSwitchActive: false,
    cooldownUntil: null, protectionMode: 'EXCHANGE_SIDE',
  };
}

function position(symbol: string, notional = 1_000): RiskOpenPosition {
  return { symbol, quantity: notional / 100, notional, exposurePct: notional / 10_000 };
}

function assertRejected(entry: PreTradeRiskInput, gate: string): void {
  const result = evaluateEntryRisk(entry);
  expect(result.decision.approved).toBe(false);
  expect(result.certificate.verdict).toBe('REJECT');
  expect(result.certificate.gates.find(item => item.name === gate)?.status).toBe('FAIL');
  expect(result).not.toHaveProperty('plan');
}

describe('deterministic entry risk', () => {
  it.each(['BTC-USDT', 'ETH-USDT'])('allows safe %s with a symbol-matched ATR protection plan', symbol => {
    const result = evaluateEntryRisk(input(symbol));
    expect(result.decision.approved).toBe(true);
    expect(result.certificate.verdict).toBe('ALLOW');
    expect(result.certificate.gates.every(gate => gate.status === 'PASS')).toBe(true);
    expect(result.certificate.requestedSymbol).toBe(symbol);
    expect(result.certificate.existingOpenPositionSymbols).toEqual([]);
    if (!result.plan) throw new Error('Expected approval');
    expect(result.plan.symbol).toBe(symbol);
    expect(result.plan.clientOrderId).toBe('order-1');
    expect(result.plan.estimatedNotional).toBeCloseTo(10_000 * 0.005 / 0.03);
    expect(result.plan.quantity).toBeCloseTo(result.plan.estimatedNotional / 100);
    expect(result.plan.protection).toMatchObject({ symbol, initialStopPrice: 97,
      stopDistanceAbsolute: 3, stopDistanceFraction: 0.03,
      breakEvenTriggerR: 1, trailingActivationR: 1.5, takeProfitR: 2.5 });
  });

  it.each(['DISAGREE', 'ABSTAIN'] as const)('rejects LLM %s', action => {
    const entry = input();
    entry.llmResult = { ...llmResult, decision: { ...decision, action } };
    assertRejected(entry, 'LLM_AGREE');
  });

  it.each(['TIMEOUT', 'UNREACHABLE', 'MALFORMED_RESPONSE', 'SCHEMA_INVALID', 'BUDGET_EXCEEDED'] as const)(
    'rejects LLM %s', status => {
      const entry = input();
      entry.llmResult = { status };
      assertRejected(entry, 'LLM_REACHABLE');
    },
  );

  it('revalidates even a claimed SUCCESS and rejects HIGH risk', () => {
    const malformed = input();
    malformed.llmResult = { status: 'SUCCESS', decision: { ...decision, confidence: 2 } };
    assertRejected(malformed, 'LLM_SCHEMA');
    const high = input();
    high.llmResult = { ...llmResult, decision: { ...decision, risk_flag: 'HIGH' } };
    assertRejected(high, 'LLM_RISK');
  });

  it('rejects missing/HOLD candidates, low OQS, and inadequate edge', () => {
    const missing = input(); missing.candidate = null;
    assertRejected(missing, 'CANDIDATE_EXISTS');
    const hold = input(); hold.candidate = { ...hold.candidate!, action: 'HOLD', intent: 'NONE' };
    assertRejected(hold, 'CANDIDATE_EXISTS');
    const low = input(); low.candidate = { ...low.candidate!, opportunityScore: 64 };
    assertRejected(low, 'OPPORTUNITY_SCORE');
    const cost = input(); cost.candidate = { ...cost.candidate!, clearsEstimatedCosts: false };
    assertRejected(cost, 'EDGE_COST');
    const inconsistentRatio = input();
    inconsistentRatio.candidate = { ...inconsistentRatio.candidate!, estimatedMoveBps: 11, estimatedRoundTripCostBps: 10 };
    assertRejected(inconsistentRatio, 'EDGE_COST');
  });

  it('rejects stale data, wide spread, and excessive volatility', () => {
    const stale = input(); stale.market = { ...stale.market, dataAgeMs: 10_001 };
    assertRejected(stale, 'DATA_FRESH');
    const spread = input(); spread.market = { ...spread.market, spreadBps: 11 };
    assertRejected(spread, 'SPREAD');
    const volatility = input(); volatility.market = { ...volatility.market, atrPctPercentile: 0.96 };
    assertRejected(volatility, 'VOLATILITY');
  });

  it('rejects requested notional above the separate single-position and raw-risk caps', () => {
    const entry = input(); entry.requestedNotional = 3_000;
    assertRejected(entry, 'SINGLE_POSITION_CAP');
    const rawRisk = input(); rawRisk.requestedNotional = 2_000;
    assertRejected(rawRisk, 'SINGLE_POSITION_CAP');
  });

  it('clips calculated sizing to the single-position cap without raising risk', () => {
    const entry = input();
    entry.market = { ...entry.market, atr: 0.4 }; // raw sizing = 8,333; cap = 2,500
    const result = evaluateEntryRisk(entry);
    expect(result.decision.approved).toBe(true);
    if (!result.plan) throw new Error('Expected approval');
    expect(result.plan.estimatedNotional).toBe(2_500);
  });

  it('rejects BTC when ETH is open and ETH when BTC is open, independent of loop ranking', () => {
    for (const [selected, held] of [['BTC-USDT', 'ETH-USDT'], ['ETH-USDT', 'BTC-USDT']] as const) {
      const entry = input(selected);
      entry.config = { ...entry.config, maxConcurrentPositions: 1 };
      entry.account = { ...entry.account, openPositions: [position(held)] };
      const result = evaluateEntryRisk(entry);
      expect(result.decision.rejectionCategory).toBe('CROSS_SYMBOL_POSITION_CAP');
      expect(result.decision.reason).toContain('CROSS_SYMBOL_POSITION_CAP');
      expect(result.certificate.existingOpenPositionSymbols).toEqual([held]);
      expect(result.certificate.gates.find(gate => gate.name === 'CROSS_SYMBOL_POSITION_CAP')?.status).toBe('FAIL');
      expect(result.certificate.gates.find(gate => gate.name === 'TOTAL_EXPOSURE_CAP')?.status).toBe('PASS');
    }
  });

  it('uses maxConcurrentPositions configuration while still blocking averaging down', () => {
    const entry = input('BTC-USDT');
    entry.config = { ...entry.config, maxConcurrentPositions: 2 };
    entry.account = { ...entry.account, openPositions: [position('ETH-USDT', 500)] };
    const allowed = evaluateEntryRisk(entry);
    expect(allowed.decision.approved).toBe(true);
    entry.account = { ...entry.account, openPositions: [position('BTC-USDT', 500)] };
    assertRejected(entry, 'NO_AVERAGE_DOWN');
  });

  it('rejects total exposure above its own cap, separately from the single-position cap', () => {
    const entry = input();
    entry.config = { ...entry.config, maxConcurrentPositions: 2 };
    entry.account = { ...entry.account, openPositions: [position('ETH-USDT', 2_000)] };
    entry.requestedNotional = 1_000;
    const result = evaluateEntryRisk(entry);
    expect(result.certificate.gates.find(gate => gate.name === 'SINGLE_POSITION_CAP')?.status).toBe('PASS');
    expect(result.certificate.gates.find(gate => gate.name === 'TOTAL_EXPOSURE_CAP')?.status).toBe('FAIL');
    expect(result.decision.rejectionCategory).toBe('TOTAL_EXPOSURE_CAP');
  });

  it('rejects daily-loss and peak-drawdown breaches with LOCKDOWN', () => {
    const daily = input(); daily.account = { ...daily.account, equity: 9_700 };
    const dailyResult = evaluateEntryRisk(daily);
    expect(dailyResult.decision.rejectionCategory).toBe('DAILY_LOSS');
    expect(dailyResult.certificate.riskMode).toBe('LOCKDOWN');
    const peak = input(); peak.account = { ...peak.account, equity: 9_600, dayStartEquity: 9_600, peakEquity: 10_000 };
    const peakResult = evaluateEntryRisk(peak);
    expect(peakResult.decision.rejectionCategory).toBe('PEAK_DRAWDOWN');
    expect(peakResult.certificate.riskMode).toBe('LOCKDOWN');
  });

  it('rejects duplicate clientOrderId before any execution and a kill switch in every symbol', () => {
    const duplicate = input(); duplicate.knownClientOrderIds = ['order-1'];
    assertRejected(duplicate, 'DUPLICATE_CLIENT_ORDER_ID');
    for (const symbol of ['BTC-USDT', 'ETH-USDT']) {
      const killed = input(symbol); killed.killSwitchActive = true;
      assertRejected(killed, 'KILL_SWITCH');
      expect(evaluateEntryRisk(killed).certificate.riskMode).toBe('LOCKDOWN');
    }
  });

  it('rejects invalid ATR/stop, mismatched market symbol, and unavailable protection', () => {
    const atr = input(); atr.market = { ...atr.market, atr: 0 };
    assertRejected(atr, 'PROTECTION_VALID');
    const stop = input(); stop.market = { ...stop.market, atr: 100 };
    assertRejected(stop, 'PROTECTION_VALID');
    const symbol = input(); symbol.market = { ...symbol.market, symbol: 'ETH-USDT' };
    assertRejected(symbol, 'SYMBOL_MATCH');
    const unavailable = input(); unavailable.protectionMode = 'UNAVAILABLE';
    assertRejected(unavailable, 'PROTECTION_VALID');
  });

  it('uses a two-loss 0.50 multiplier, pauses after three losses, then expires', () => {
    const baseline = evaluateEntryRisk(input());
    const two = input(); two.account = { ...two.account, consecutiveLosses: 2, lastLossTimestamp: now };
    const reduced = evaluateEntryRisk(two);
    expect(reduced.decision.approved).toBe(true);
    if (baseline.plan && reduced.plan) {
      expect(reduced.plan.estimatedNotional).toBeCloseTo(baseline.plan.estimatedNotional * 0.5);
    }
    const three = input(); three.account = { ...three.account, consecutiveLosses: 3, lastLossTimestamp: now };
    assertRejected(three, 'COOLDOWN');
    const expiry = now + 20 * 60_000;
    three.timestamp = expiry;
    three.account = { ...three.account, timestamp: expiry };
    three.market = { ...three.market, timestamp: expiry };
    three.candidate = { ...three.candidate!, timestamp: expiry };
    expect(evaluateEntryRisk(three).decision.approved).toBe(true);
  });

  it('does not let LLM confidence change position size', () => {
    const low = input(); low.llmResult = { ...llmResult, decision: { ...decision, confidence: 0.51 } };
    const high = input(); high.llmResult = { ...llmResult, decision: { ...decision, confidence: 0.99 } };
    const a = evaluateEntryRisk(low), b = evaluateEntryRisk(high);
    expect(a.decision.approved).toBe(true);
    expect(b.decision.approved).toBe(true);
    if (a.plan && b.plan) expect(a.plan.estimatedNotional).toBe(b.plan.estimatedNotional);
  });

  it('raises a small-account order to the floor only within hard risk and exposure caps', () => {
    const entry = input('SOL-USDT');
    entry.account = { ...entry.account, equity: 30, dayStartEquity: 30, peakEquity: 30,
      availableQuoteBalance: 30 };
    entry.config = { ...entry.config, minTradeNotionalUsd: 6 };
    const result = evaluateEntryRisk(entry);
    expect(result.decision.approved).toBe(true);
    expect(result.plan?.estimatedNotional).toBe(6);
    expect(result.certificate.gates.find(item => item.name === 'MIN_TRADE_NOTIONAL')?.status).toBe('PASS');
  });

  it('rejects the floor clearly when position, total-exposure, or hard-risk capacity is too small', () => {
    const entry = input('SOL-USDT');
    entry.account = { ...entry.account, equity: 30, dayStartEquity: 30, peakEquity: 30,
      availableQuoteBalance: 30 };
    entry.config = { ...entry.config, minTradeNotionalUsd: 6, maxPositionPct: 0.15 };
    assertRejected(entry, 'MIN_TRADE_NOTIONAL');
    entry.config = { ...entry.config, maxPositionPct: 0.25 };
    entry.account = { ...entry.account, openPositions: [{ symbol: 'ETH-USDT', quantity: 0.02,
      notional: 2, exposurePct: 2 / 30 }] };
    assertRejected(entry, 'MIN_TRADE_NOTIONAL');
    entry.account = { ...entry.account, openPositions: [] };
    entry.market = { ...entry.market, atr: 4 };
    assertRejected(entry, 'MIN_TRADE_NOTIONAL');
  });

  it('counts separate positions and enforces aggregate exposure before a third entry', () => {
    const entry = input('SOL-USDT');
    entry.account = { ...entry.account, openPositions: [position('BTC-USDT', 1_000),
      position('ETH-USDT', 1_000)] };
    const allowed = evaluateEntryRisk(entry);
    expect(allowed.decision.approved).toBe(true);
    expect(allowed.plan?.estimatedNotional).toBeCloseTo(500);
    entry.account = { ...entry.account, openPositions: [position('BTC-USDT', 1_250),
      position('ETH-USDT', 1_248)] };
    expect(evaluateEntryRisk(entry).decision.rejectionCategory).toBe('MIN_TRADE_NOTIONAL');
    entry.account = { ...entry.account, openPositions: [position('BTC-USDT', 100),
      position('ETH-USDT', 100), position('XRP-USDT', 100)] };
    expect(evaluateEntryRisk(entry).decision.rejectionCategory).toBe('CROSS_SYMBOL_POSITION_CAP');
  });

  it('loads independent position-count and portfolio caps from environment', () => {
    const config = riskConfigFromEnv({});
    expect(config.maxConcurrentPositions).toBe(3);
    expect(config.maxTotalExposurePct).toBe(0.25);
    expect(config.maxPositionPct).toBe(0.25);
    expect(config.minEdgeCostRatio).toBe(1.3);
    expect(riskConfigFromEnv({ MAX_CONCURRENT_POSITIONS: '2', MAX_TOTAL_EXPOSURE_PCT: '0.30', MAX_POSITION_PCT: '0.10' }))
      .toMatchObject({ maxConcurrentPositions: 2, maxTotalExposurePct: 0.3, maxPositionPct: 0.1 });
  });
});

describe('protective exits and ambiguous execution', () => {
  const protective = () => ({
    position: position('BTC-USDT'), marketPrice: 98,
    protection: { symbol: 'BTC-USDT', initialStopPrice: 97, stopDistanceFraction: 0.03,
      stopDistanceAbsolute: 3, breakEvenTriggerR: 1, trailingActivationR: 1.5,
      takeProfitR: 2.5, protectionMode: 'EXCHANGE_SIDE' as const },
    emergencyExit: false, volatilityExit: false, regimeInvalidated: false,
    drawdownProtection: false, lockdownClose: false, killSwitchActive: false,
  });

  it('keeps hard stop and every deterministic protective exit active without LLM input', () => {
    const cases = [
      [{ marketPrice: 96 }, 'HARD_STOP'],
      [{ emergencyExit: true }, 'EMERGENCY_EXIT'],
      [{ volatilityExit: true }, 'VOLATILITY_EXIT'],
      [{ regimeInvalidated: true }, 'REGIME_INVALIDATION'],
      [{ drawdownProtection: true }, 'DRAWDOWN_PROTECTION'],
      [{ lockdownClose: true }, 'LOCKDOWN_CLOSE'],
      [{ killSwitchActive: true }, 'KILL_SWITCH_CLOSE'],
    ] as const;
    for (const [change, reason] of cases) {
      expect(evaluateProtectiveExit({ ...protective(), ...change })).toEqual({ action: 'EXIT', reason });
    }
    expect(evaluateProtectiveExit(protective())).toEqual({ action: 'HOLD', reason: 'NONE' });
    expect(evaluateProtectiveExit({ ...protective(), protection: null })).toEqual({ action: 'EXIT', reason: 'PROTECTION_MISSING' });
  });

  it('requires reconciliation after possible exchange submission timeout, never a blind retry', () => {
    expect(decideSubmissionRecovery('SUBMITTED_TIMEOUT')).toEqual({ action: 'RECONCILE', retry: false });
    expect(decideSubmissionRecovery('CONFIRMED')).toEqual({ action: 'NONE', retry: false });
  });
});

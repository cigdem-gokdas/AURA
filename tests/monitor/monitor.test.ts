import { describe, expect, it } from 'vitest';
import { InMemoryPositionMonitor } from '../../src/monitor/monitor.js';
import {
  MonitorSymbolError, activateTrailing, emergencyRiskExit, hardStopBreached,
  promoteBreakEven, regimeInvalidated, takeProfitReached, takeProfitReference,
  timeStopReached, updateAtrTrailingStop,
} from '../../src/monitor/protection.js';
import type { Fill, FillPolicy } from '../../src/monitor/types.js';
import type { ProtectionPlan } from '../../src/risk/types.js';
import type { DecisionMemorySummary } from '../../src/memory/types.js';
import type { StartupExchangeSnapshot } from '../../src/execution/types.js';

const start = 1_000;
function plan(symbol: string): ProtectionPlan {
  return { symbol, initialStopPrice: 97, stopDistanceAbsolute: 3,
    stopDistanceFraction: 0.03, breakEvenTriggerR: 1,
    trailingActivationR: 1.5, takeProfitR: 2.5,
    protectionMode: 'EXCHANGE_SIDE' };
}
function policy(symbol: string, allowSameSymbolIncrease = false): FillPolicy {
  return { allowSameSymbolIncrease, protectionPlan: plan(symbol), protectionMode: 'EXCHANGE_SIDE' };
}
function fill(symbol: string, side: 'BUY' | 'SELL', quantity = 2, price = 100,
  fee = 1, timestamp = start, fillId = `${symbol}-${side}-${timestamp}`): Fill {
  return { symbol, side, quantity, price, fee, timestamp, fillId,
    clientOrderId: `client-${fillId}`, exchangeOrderId: `order-${fillId}` };
}
function snapshot(symbol: string): StartupExchangeSnapshot {
  return {
    profile: 'demo', totalEquityUsd: 10_000,
    positions: [{ symbol, quantity: 2, averageEntryPrice: 100, updatedAt: 1_500 }],
    openOrders: [], balances: [{ currency: 'USDT', equity: 9_780, available: 9_780 }],
    recentFills: [], feeRates: [], orderLookupSupported: true, timestamp: 2_000,
  };
}
function startupContext(symbol: string) {
  return {
    referencePrices: { [symbol]: 110 }, openedAtBySymbol: { [symbol]: 1_200 },
    protectionPlans: { [symbol]: plan(symbol) }, protectionModes: { [symbol]: 'EXCHANGE_SIDE' as const },
  };
}
function memory(symbol: string, timestamp: number, resultCategory: DecisionMemorySummary['resultCategory'] = 'CLOSED'): DecisionMemorySummary {
  return { symbol, setupType: 'TREND_CONTINUATION', regime: 'TRENDING_UP',
    resultCategory, outcomeR: symbol === 'BTC-USDT' ? -1 : 1,
    stopHit: symbol === 'BTC-USDT', timestamp };
}

describe('symbol-aware monitor fills and performance', () => {
  it('tracks three positions with independent marks, stops, exits and aggregate equity', async () => {
    const monitor = new InMemoryPositionMonitor(10_000, start, 10_000, 3);
    for (const [symbol, timestamp] of [['BTC-USDT', start], ['ETH-USDT', start + 1],
      ['SOL-USDT', start + 2]] as const) {
      expect(monitor.processFill(fill(symbol, 'BUY', 1, 100, 0, timestamp), policy(symbol)).status)
        .toBe('APPLIED');
    }
    expect((await monitor.getOpenPositions()).map(item => item.symbol))
      .toEqual(['BTC-USDT', 'ETH-USDT', 'SOL-USDT']);
    monitor.updateMark('BTC-USDT', 90, start + 3);
    monitor.updateMark('ETH-USDT', 120, start + 4);
    expect((await monitor.getOpenPosition('SOL-USDT'))?.markPrice).toBe(100);
    expect((await monitor.getOpenPosition('BTC-USDT'))?.protection.currentStopPrice).toBe(97);
    expect((await monitor.getEquitySnapshot())).toMatchObject({ currentEquity: 10_010,
      openPositionSymbols: ['BTC-USDT', 'ETH-USDT', 'SOL-USDT'] });
    expect(monitor.processFill(fill('ETH-USDT', 'SELL', 1, 120, 0, start + 5), undefined).status)
      .toBe('APPLIED');
    expect((await monitor.getOpenPositions()).map(item => item.symbol)).toEqual(['BTC-USDT', 'SOL-USDT']);
    expect((await monitor.getOpenPosition('BTC-USDT'))?.quantity).toBe(1);
    expect((await monitor.getOpenPosition('SOL-USDT'))?.quantity).toBe(1);
  });

  it.each(['BTC-USDT', 'ETH-USDT'])('%s BUY opens the supplied symbol and preserves it through snapshots', async symbol => {
    const monitor = new InMemoryPositionMonitor(10_000, start);
    expect(monitor.processFill(fill(symbol, 'BUY'), policy(symbol)).status).toBe('APPLIED');
    const position = await monitor.getOpenPosition();
    expect(position).toMatchObject({ symbol, quantity: 2, weightedAverageEntryPrice: 100,
      markPrice: 100, referencePrice: 100, openedAt: start, updatedAt: start,
      protectionPlan: { symbol }, protectionMode: 'EXCHANGE_SIDE' });
    expect((await monitor.getEquitySnapshot())).toMatchObject({ startingEquity: 10_000,
      currentEquity: 9_999, peakEquity: 10_000, openPositionSymbol: symbol,
      unrealizedPnl: -1, dailyPnl: -1 });
    position!.quantity = 99;
    expect((await monitor.getOpenPosition())?.quantity).toBe(2);
  });

  it('weights same-symbol increases only with explicit upstream permission', async () => {
    const monitor = new InMemoryPositionMonitor(10_000, start);
    monitor.processFill(fill('BTC-USDT', 'BUY'), policy('BTC-USDT'));
    const next = fill('BTC-USDT', 'BUY', 1, 130, 2, start + 1, 'buy-2');
    expect(monitor.processFill(next, policy('BTC-USDT')).status).toBe('SAME_SYMBOL_INCREASE_NOT_ALLOWED');
    expect((await monitor.getOpenPosition())?.quantity).toBe(2);
    expect(monitor.processFill(next, policy('BTC-USDT', true)).status).toBe('APPLIED');
    expect(await monitor.getOpenPosition()).toMatchObject({
      symbol: 'BTC-USDT', quantity: 3, weightedAverageEntryPrice: 110,
      entryFeeBalance: 3, unrealizedPnl: 57,
    });
    expect((await monitor.getEquitySnapshot()).currentEquity).toBe(10_057);
  });

  it('aggregates partial BUY fills from the same approved order without enabling a second order', async () => {
    const monitor = new InMemoryPositionMonitor(10_000, start);
    const first = { ...fill('XLM-USDT', 'BUY', 10, 0.19, 0.01, start, 'partial-1'),
      exchangeOrderId: 'entry-order', clientOrderId: 'entry-client' };
    const second = { ...fill('XLM-USDT', 'BUY', 15, 0.2, 0.02, start + 1, 'partial-2'),
      exchangeOrderId: 'entry-order', clientOrderId: 'entry-client' };
    expect(monitor.processFill(first, policy('XLM-USDT')).status).toBe('APPLIED');
    expect(monitor.processFill(second, policy('XLM-USDT')).status).toBe('APPLIED');
    expect(await monitor.getOpenPosition('XLM-USDT')).toMatchObject({
      quantity: 25, weightedAverageEntryPrice: 0.196,
      entryOrderId: 'entry-order', entryClientOrderId: 'entry-client',
    });

    const separateOrder = { ...fill('XLM-USDT', 'BUY', 1, 0.2, 0, start + 2, 'separate'),
      exchangeOrderId: 'another-order', clientOrderId: 'another-client' };
    expect(monitor.processFill(separateOrder, policy('XLM-USDT')).status)
      .toBe('SAME_SYMBOL_INCREASE_NOT_ALLOWED');
  });

  it('rejects cross-symbol BUY merging without mutating BTC state', async () => {
    const monitor = new InMemoryPositionMonitor(10_000, start, 10_000, 1);
    monitor.processFill(fill('BTC-USDT', 'BUY'), policy('BTC-USDT'));
    const before = await monitor.getEquitySnapshot();
    expect(monitor.processFill(fill('ETH-USDT', 'BUY', 1, 100, 0, start + 1), policy('ETH-USDT')).status)
      .toBe('SYMBOL_CONFLICT');
    expect((await monitor.getOpenPosition())?.symbol).toBe('BTC-USDT');
    expect(await monitor.getEquitySnapshot()).toEqual(before);
  });

  it.each([['BTC-USDT', 'ETH-USDT'], ['ETH-USDT', 'BTC-USDT']] as const)(
    '%s SELL cannot reduce a %s position', async (sellSymbol, heldSymbol) => {
      const monitor = new InMemoryPositionMonitor(10_000, start);
      monitor.processFill(fill(heldSymbol, 'BUY'), policy(heldSymbol));
      expect(monitor.processFill(fill(sellSymbol, 'SELL', 1, 120, 1, start + 1)).status)
        .toBe('NO_MATCHING_POSITION');
      expect((await monitor.getOpenPosition())?.quantity).toBe(2);
      expect((await monitor.getOpenPosition())?.symbol).toBe(heldSymbol);
    },
  );

  it('handles partial and full SELL with fees, realized PnL, R, and explicit FLAT state', async () => {
    const monitor = new InMemoryPositionMonitor(10_000, start);
    monitor.processFill(fill('BTC-USDT', 'BUY'), policy('BTC-USDT'));
    const partial = monitor.processFill(fill('BTC-USDT', 'SELL', 1, 110, 1, start + 1, 'sell-1'));
    expect(partial).toMatchObject({ status: 'APPLIED', closedTradePnl: null,
      position: { symbol: 'BTC-USDT', quantity: 1, realizedPnl: 8.5,
        entryFeeBalance: 0.5, unrealizedPnl: 9.5 } });
    expect((await monitor.getPerformanceState()).closedTradeCount).toBe(0);
    const closed = monitor.processFill(fill('BTC-USDT', 'SELL', 1, 120, 1, start + 2, 'sell-2'));
    expect(closed.status).toBe('APPLIED');
    expect(closed.closedTradePnl).toBe(27);
    expect(closed.closedTradeOutcomeR).toBe(27 / 6);
    expect(closed.position).toBeNull();
    expect(await monitor.getEquitySnapshot()).toMatchObject({ currentEquity: 10_027,
      realizedPnlToday: 27, dailyPnl: 27, dailyReturn: 0.0027,
      openPositionSymbol: null, peakEquity: 10_027 });
    expect(await monitor.getPerformanceState()).toMatchObject({
      completedTrades: 1, closedTradeCount: 1, winningTrades: 1,
      consecutiveWins: 1, consecutiveLosses: 0,
    });
  });

  it('rejects oversell, duplicate fills, invalid quantities, and keeps equity unchanged', async () => {
    const monitor = new InMemoryPositionMonitor(10_000, start);
    const buy = fill('ETH-USDT', 'BUY');
    expect(monitor.processFill(buy, policy('ETH-USDT')).status).toBe('APPLIED');
    const before = await monitor.getEquitySnapshot();
    expect(monitor.processFill(buy, policy('ETH-USDT')).status).toBe('DUPLICATE_FILL');
    expect(monitor.processFill(fill('ETH-USDT', 'SELL', 2.0000000001, 120, 0, start + 1)).status).toBe('OVERSELL');
    expect(monitor.processFill(fill('ETH-USDT', 'SELL', -1, 120, 0, start + 1)).status).toBe('INVALID_FILL');
    expect(await monitor.getEquitySnapshot()).toEqual(before);
  });

  it('recognizes an already-applied fill after a newer mark advanced the monitor clock', () => {
    const monitor = new InMemoryPositionMonitor(10_000, start);
    const buy = fill('ETH-USDT', 'BUY');
    expect(monitor.processFill(buy, policy('ETH-USDT')).status).toBe('APPLIED');
    monitor.updateMark('ETH-USDT', 101, start + 10);
    expect(monitor.processFill(buy, policy('ETH-USDT')).status).toBe('DUPLICATE_FILL');
  });

  it('tracks mark-to-market equity, daily return, drawdown, max drawdown, and win/loss streaks', async () => {
    const monitor = new InMemoryPositionMonitor(10_000, start);
    monitor.processFill(fill('BTC-USDT', 'BUY'), policy('BTC-USDT'));
    monitor.updateMark('BTC-USDT', 120, start + 1);
    expect(await monitor.getEquitySnapshot()).toMatchObject({ currentEquity: 10_039, peakEquity: 10_039,
      unrealizedPnl: 39, dailyPnl: 39 });
    monitor.updateMark('BTC-USDT', 90, start + 2);
    const low = await monitor.getEquitySnapshot();
    expect(low.currentEquity).toBe(9_979);
    expect(low.currentDrawdown).toBeCloseTo(60 / 10_039);
    expect(low.maximumDrawdown).toBeCloseTo(60 / 10_039);
    monitor.processFill(fill('BTC-USDT', 'SELL', 2, 90, 1, start + 3));
    expect(await monitor.getPerformanceState()).toMatchObject({ losingTrades: 1,
      consecutiveLosses: 1, consecutiveWins: 0 });
    monitor.processFill(fill('ETH-USDT', 'BUY', 2, 100, 1, start + 4), policy('ETH-USDT'));
    monitor.processFill(fill('ETH-USDT', 'SELL', 2, 120, 1, start + 5));
    expect(await monitor.getPerformanceState()).toMatchObject({
      completedTrades: 2, winningTrades: 1, losingTrades: 1,
      consecutiveWins: 1, consecutiveLosses: 0,
    });
  });

  it('rolls the daily equity baseline forward without erasing peak drawdown', async () => {
    const monitor = new InMemoryPositionMonitor(10_000, start);
    monitor.processFill(fill('BTC-USDT', 'BUY'), policy('BTC-USDT'));
    monitor.updateMark('BTC-USDT', 90, start + 1);
    const priorMax = (await monitor.getEquitySnapshot()).maximumDrawdown;
    const nextDay = 86_400_000 + start;
    monitor.updateMark('BTC-USDT', 95, nextDay);
    const daily = await monitor.getEquitySnapshot();
    expect(daily.dailyPnl).toBe(10);
    expect(daily.dailyReturn).toBeCloseTo(10 / 9_979);
    expect(daily.maximumDrawdown).toBe(priorMax);
  });
});

describe('deterministic symbol-aware protection', () => {
  it.each(['BTC-USDT', 'ETH-USDT'])('%s hard stop, break-even, trailing, TP, time, regime, and emergency helpers', async symbol => {
    const monitor = new InMemoryPositionMonitor(10_000, start);
    monitor.processFill(fill(symbol, 'BUY'), policy(symbol));
    const opened = (await monitor.getOpenPosition())!;
    expect(hardStopBreached(symbol, opened, 97)).toBe(true);
    expect(hardStopBreached(symbol, opened, 98)).toBe(false);
    const promoted = promoteBreakEven(symbol, opened, 103, start + 1);
    expect(promoted.protection).toMatchObject({ breakEvenActivated: true, currentStopPrice: 100 });
    const trailing = activateTrailing(symbol, promoted, 105, start + 2);
    expect(trailing.protection.trailingActivated).toBe(true);
    const raised = updateAtrTrailingStop(symbol, trailing, 110, 2, 1.5, start + 3);
    expect(raised.protection.currentStopPrice).toBe(107);
    expect(updateAtrTrailingStop(symbol, raised, 105, 2, 1.5, start + 4).protection.currentStopPrice).toBe(107);
    expect(takeProfitReference(symbol, opened)).toBe(107.5);
    expect(takeProfitReached(symbol, opened, 108)).toBe(true);
    expect(timeStopReached(symbol, opened, start + 1_000, 1_000)).toBe(true);
    expect(regimeInvalidated(symbol, opened, 'TRENDING_UP', 'RANGE')).toBe(true);
    expect(emergencyRiskExit(symbol, opened, { killSwitch: true, hardDrawdown: false,
      emergencyExit: false, volatilityExit: false })).toBe(true);
    expect(Object.keys(opened)).not.toContain('llmDecision');
  });

  it('never applies BTC protection to ETH or ETH protection to BTC, without any LLM dependency', async () => {
    for (const [held, wrong] of [['BTC-USDT', 'ETH-USDT'], ['ETH-USDT', 'BTC-USDT']] as const) {
      const monitor = new InMemoryPositionMonitor(10_000, start);
      monitor.processFill(fill(held, 'BUY'), policy(held));
      const position = (await monitor.getOpenPosition())!;
      expect(() => hardStopBreached(wrong, position, 90)).toThrow(MonitorSymbolError);
      expect(() => promoteBreakEven(wrong, position, 120, start + 1)).toThrow(MonitorSymbolError);
      expect(() => emergencyRiskExit(wrong, position, { killSwitch: true, hardDrawdown: false,
        emergencyExit: false, volatilityExit: false })).toThrow(MonitorSymbolError);
    }
  });
});

describe('compact decision memory and startup reconciliation', () => {
  it('keeps latest five by timestamp with BTC and ETH outcomes distinguishable', () => {
    const monitor = new InMemoryPositionMonitor(10_000, start);
    for (const [i, symbol] of ['BTC-USDT', 'ETH-USDT', 'BTC-USDT', 'ETH-USDT', 'BTC-USDT', 'ETH-USDT'].entries()) {
      monitor.recordDecision(memory(symbol, i + 1, i % 2 ? 'REJECTED_LLM' : 'CLOSED'));
    }
    const latest = monitor.getRecentDecisionMemory();
    expect(latest).toHaveLength(5);
    expect(latest.map(item => item.timestamp)).toEqual([6, 5, 4, 3, 2]);
    expect(latest[0]).toMatchObject({ symbol: 'ETH-USDT', outcomeR: 1, stopHit: false });
    expect(latest[1]).toMatchObject({ symbol: 'BTC-USDT', outcomeR: -1, stopHit: true });
    expect(latest.every(item => item.symbol && item.setupType && item.regime && item.resultCategory)).toBe(true);
    latest[0]!.symbol = 'MUTATED';
    expect(monitor.getRecentDecisionMemory()[0]?.symbol).toBe('ETH-USDT');
    monitor.recordDecision(memory('BTC-USDT', 0));
    expect(monitor.getRecentDecisionMemory().map(item => item.timestamp)).toEqual([6, 5, 4, 3, 2]);
  });

  it.each(['BTC-USDT', 'ETH-USDT'])('reconstructs %s explicitly from exchange truth', async symbol => {
    const monitor = new InMemoryPositionMonitor(10_000, start);
    const result = monitor.reconcileStartup(snapshot(symbol), startupContext(symbol));
    expect(result.status).toBe('RESTORED');
    expect(result.position).toMatchObject({ symbol, quantity: 2, weightedAverageEntryPrice: 100,
      markPrice: 110, openedAt: 1_200, protectionPlan: { symbol }, tradePerformanceComplete: false });
    expect((await monitor.getEquitySnapshot())).toMatchObject({ openPositionSymbol: symbol,
      currentEquity: 10_000, availableQuoteBalance: 9_780 });
  });

  it('does not invent a complete trade PnL or win streak for an exchange-only restored holding', async () => {
    const monitor = new InMemoryPositionMonitor(10_000, start);
    monitor.reconcileStartup(snapshot('ETH-USDT'), startupContext('ETH-USDT'));
    const result = monitor.processFill(fill('ETH-USDT', 'SELL', 2, 120, 1, 2_001));
    expect(result).toMatchObject({ status: 'APPLIED', closedTradePnl: null, closedTradeOutcomeR: null });
    expect(await monitor.getPerformanceState()).toMatchObject({
      closedTradeCount: 1, winningTrades: 0, losingTrades: 0,
      consecutiveWins: 0, consecutiveLosses: 0,
    });
  });

  it('reports BTC-local/ETH-exchange discrepancy and does not overwrite local state', async () => {
    const monitor = new InMemoryPositionMonitor(10_000, start);
    monitor.processFill(fill('BTC-USDT', 'BUY'), policy('BTC-USDT'));
    const before = await monitor.getEquitySnapshot();
    const result = monitor.reconcileStartup(snapshot('ETH-USDT'), startupContext('ETH-USDT'));
    expect(result).toMatchObject({ status: 'DISCREPANCY', localPositionSymbol: 'BTC-USDT',
      exchangePositionSymbols: ['ETH-USDT'], position: { symbol: 'BTC-USDT' } });
    expect(await monitor.getEquitySnapshot()).toEqual(before);
  });

  it('refuses to invent a missing opening time, cost basis, or protection plan on restart', async () => {
    const monitor = new InMemoryPositionMonitor(10_000, start);
    const context = startupContext('ETH-USDT');
    const invalid = monitor.reconcileStartup(snapshot('ETH-USDT'), {
      ...context, openedAtBySymbol: {},
    });
    expect(invalid.status).toBe('INVALID_SNAPSHOT');
    expect(await monitor.getOpenPosition()).toBeNull();
    const missingBasis = snapshot('ETH-USDT');
    missingBasis.positions = [{ symbol: 'ETH-USDT', quantity: 2, averageEntryPrice: null, updatedAt: 1_500 }];
    expect(monitor.reconcileStartup(missingBasis, context).status).toBe('INVALID_SNAPSHOT');
  });
});

describe('residual dust write-off', () => {
  it('finalizes a sub-lot remainder at zero value and releases the position budget', async () => {
    const monitor = new InMemoryPositionMonitor(10_000, start);
    expect(monitor.processFill(fill('ETH-USDT', 'BUY', 2, 100, 1, start), policy('ETH-USDT')).status).toBe('APPLIED');
    const sold = monitor.processFill(fill('ETH-USDT', 'SELL', 1.9999995, 110, 1, start + 1));
    expect(sold.status).toBe('APPLIED');
    expect(sold.closedTradePnl).toBeNull();
    expect(monitor.closeResidualDust('BTC-USDT', 0.000001, start + 2).status).toBe('NO_MATCHING_POSITION');
    expect(monitor.closeResidualDust('ETH-USDT', 0.0000001, start + 2).status).toBe('INVALID_FILL');
    const closed = monitor.closeResidualDust('ETH-USDT', 0.000001, start + 2);
    expect(closed.status).toBe('APPLIED');
    expect(closed.closedTradePnl).toBeCloseTo(1.9999995 * 10 - 1 - 1 - 0.0000005 * 100, 6);
    expect(closed.closedTradeOutcomeR).not.toBeNull();
    expect(await monitor.getOpenPosition()).toBeNull();
    expect((await monitor.getPerformanceState()).completedTrades).toBe(1);
    expect((await monitor.getEquitySnapshot()).currentEquity).toBeCloseTo(10_000 - 201 + 1.9999995 * 110 - 1, 6);
  });
});

describe('attached protection identity on positions', () => {
  it('records entry identities on open and restores them from checkpoint links', async () => {
    const monitor = new InMemoryPositionMonitor(10_000, start);
    const opened = monitor.processFill(fill('ETH-USDT', 'BUY'), { ...policy('ETH-USDT'), entryProtectionIds: ['algo-7'] });
    expect(opened.position).toMatchObject({ entryOrderId: 'order-ETH-USDT-BUY-1000',
      entryClientOrderId: 'client-ETH-USDT-BUY-1000', attachedProtectionIds: ['algo-7'] });
    const copy = (await monitor.getOpenPosition())!;
    (copy.attachedProtectionIds as string[]).push('tampered');
    expect((await monitor.getOpenPosition())?.attachedProtectionIds).toEqual(['algo-7']);

    const fresh = new InMemoryPositionMonitor(10_000, start);
    const restored = fresh.reconcileStartup(snapshot('ETH-USDT'), { ...startupContext('ETH-USDT'),
      exchangeLinks: { 'ETH-USDT': { entryOrderId: 'order-x', entryClientOrderId: 'AURAENTRYabc', attachedProtectionIds: ['algo-x'] } } });
    expect(restored.status).toBe('RESTORED');
    expect(restored.position).toMatchObject({ entryOrderId: 'order-x', entryClientOrderId: 'AURAENTRYabc', attachedProtectionIds: ['algo-x'] });
  });
});

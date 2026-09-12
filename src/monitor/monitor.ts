import type { DecisionMemorySummary } from '../memory/types.js';
import type { ProtectionPlan } from '../risk/types.js';
import { MonitorSymbolError } from './protection.js';
import type {
  EquitySnapshot, Fill, FillPolicy, FillProcessingResult, OpenPosition,
  PerformanceState, PositionMonitor, PositionProtectionState,
  StartupMonitorContext, StartupMonitorResult,
} from './types.js';
import type { StartupExchangeSnapshot } from '../execution/types.js';

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const positive = (value: unknown): value is number => finite(value) && value > 0;
const utcDay = (timestamp: number): number => Math.floor(timestamp / 86_400_000);

function copyPosition(position: OpenPosition | null): OpenPosition | null {
  return position ? {
    ...position,
    protectionPlan: { ...position.protectionPlan },
    protection: { ...position.protection },
  } : null;
}

function validProtection(symbol: string, plan: ProtectionPlan | null): plan is ProtectionPlan {
  return plan !== null && plan.symbol === symbol && positive(plan.initialStopPrice)
    && positive(plan.stopDistanceAbsolute) && positive(plan.stopDistanceFraction)
    && positive(plan.breakEvenTriggerR) && positive(plan.trailingActivationR)
    && positive(plan.takeProfitR);
}

function protectionState(plan: ProtectionPlan, entryPrice: number, timestamp: number): PositionProtectionState {
  return {
    mode: plan.protectionMode, initialStopPrice: plan.initialStopPrice,
    currentStopPrice: plan.initialStopPrice,
    takeProfitPrice: entryPrice + plan.stopDistanceAbsolute * plan.takeProfitR,
    breakEvenActivated: false, trailingActivated: false, lastUpdatedAt: timestamp,
  };
}

export class InMemoryPositionMonitor implements PositionMonitor {
  private position: OpenPosition | null = null;
  private cashBalance: number;
  private availableQuoteBalance: number;
  private dayStartEquity: number;
  private peakEquity: number;
  private maximumDrawdown = 0;
  private realizedPnlToday = 0;
  private completedTrades = 0;
  private winningTrades = 0;
  private losingTrades = 0;
  private consecutiveWins = 0;
  private consecutiveLosses = 0;
  private timestamp: number;
  private readonly seenFills = new Set<string>();
  private memory: DecisionMemorySummary[] = [];

  constructor(readonly startingEquity: number, timestamp: number, availableQuoteBalance = startingEquity) {
    if (!positive(startingEquity) || !finite(timestamp) || timestamp < 0
      || !finite(availableQuoteBalance) || availableQuoteBalance < 0) {
      throw new RangeError('Invalid monitor starting state');
    }
    this.cashBalance = startingEquity;
    this.availableQuoteBalance = availableQuoteBalance;
    this.dayStartEquity = startingEquity;
    this.peakEquity = startingEquity;
    this.timestamp = timestamp;
  }

  private currentEquity(): number {
    return this.cashBalance + (this.position ? this.position.quantity * this.position.markPrice : 0);
  }

  private rollDay(timestamp: number): void {
    if (utcDay(timestamp) !== utcDay(this.timestamp)) {
      this.dayStartEquity = this.currentEquity();
      this.realizedPnlToday = 0;
    }
  }

  private updateEquityMetrics(): void {
    const equity = this.currentEquity();
    this.peakEquity = Math.max(this.peakEquity, equity);
    const drawdown = this.peakEquity > 0 ? Math.max(0, (this.peakEquity - equity) / this.peakEquity) : 0;
    this.maximumDrawdown = Math.max(this.maximumDrawdown, drawdown);
  }

  async getOpenPosition(): Promise<OpenPosition | null> {
    return copyPosition(this.position);
  }

  async getEquitySnapshot(): Promise<EquitySnapshot> {
    const currentEquity = this.currentEquity();
    const dailyPnl = currentEquity - this.dayStartEquity;
    return {
      startingEquity: this.startingEquity, currentEquity, peakEquity: this.peakEquity,
      equity: currentEquity, availableQuoteBalance: this.availableQuoteBalance,
      unrealizedPnl: this.position?.unrealizedPnl ?? 0,
      realizedPnlToday: this.realizedPnlToday, dailyPnl,
      dailyReturn: this.dayStartEquity > 0 ? dailyPnl / this.dayStartEquity : 0,
      currentDrawdown: this.peakEquity > 0 ? Math.max(0, (this.peakEquity - currentEquity) / this.peakEquity) : 0,
      maximumDrawdown: this.maximumDrawdown,
      openPositionSymbol: this.position?.symbol ?? null, timestamp: this.timestamp,
    };
  }

  async getPerformanceState(): Promise<PerformanceState> {
    const equity = await this.getEquitySnapshot();
    return {
      equity, dayStartEquity: this.dayStartEquity, peakEquity: this.peakEquity,
      completedTrades: this.completedTrades, closedTradeCount: this.completedTrades,
      winningTrades: this.winningTrades, losingTrades: this.losingTrades,
      consecutiveWins: this.consecutiveWins, consecutiveLosses: this.consecutiveLosses,
      dailyPnl: equity.dailyPnl, dailyReturn: equity.dailyReturn,
      currentDrawdown: equity.currentDrawdown, maximumDrawdown: equity.maximumDrawdown,
      timestamp: this.timestamp,
    };
  }

  processFill(fill: Fill, policy?: FillPolicy): FillProcessingResult {
    const result = (status: FillProcessingResult['status'], closedTradePnl: number | null = null,
      closedTradeOutcomeR: number | null = null): FillProcessingResult => ({
      status, position: copyPosition(this.position), closedTradePnl, closedTradeOutcomeR,
    });
    if (!fill.symbol || !fill.fillId || !positive(fill.quantity) || !positive(fill.price)
      || !finite(fill.fee) || fill.fee < 0 || !finite(fill.timestamp)
      || fill.timestamp < this.timestamp || (fill.side !== 'BUY' && fill.side !== 'SELL')) {
      return result('INVALID_FILL');
    }
    const fillKey = `${fill.symbol}:${fill.fillId}`;
    if (this.seenFills.has(fillKey)) return result('DUPLICATE_FILL');
    const current = this.position;
    if (fill.side === 'BUY') {
      if (current && current.symbol !== fill.symbol) return result('SYMBOL_CONFLICT');
      if (current && !policy?.allowSameSymbolIncrease) return result('SAME_SYMBOL_INCREASE_NOT_ALLOWED');
      const plan = policy?.protectionPlan ?? null;
      if (!validProtection(fill.symbol, plan) || policy?.protectionMode !== plan.protectionMode) {
        return result('PROTECTION_MISMATCH');
      }
      this.rollDay(fill.timestamp);
      this.cashBalance -= fill.quantity * fill.price + fill.fee;
      this.availableQuoteBalance -= fill.quantity * fill.price + fill.fee;
      if (!current) {
        this.position = {
          symbol: fill.symbol, quantity: fill.quantity, weightedAverageEntryPrice: fill.price,
          markPrice: fill.price, referencePrice: fill.price,
          realizedPnl: 0, unrealizedPnl: -fill.fee, tradePerformanceComplete: true,
          entryFeeBalance: fill.fee,
          riskCapital: fill.quantity * plan.stopDistanceAbsolute,
          openedAt: fill.timestamp, updatedAt: fill.timestamp,
          protectionPlan: { ...plan }, protectionMode: policy.protectionMode,
          protection: protectionState(plan, fill.price, fill.timestamp),
        };
      } else {
        const quantity = current.quantity + fill.quantity;
        const weightedAverageEntryPrice =
          (current.quantity * current.weightedAverageEntryPrice + fill.quantity * fill.price) / quantity;
        const entryFeeBalance = current.entryFeeBalance + fill.fee;
        this.position = {
          ...current, quantity, weightedAverageEntryPrice,
          markPrice: fill.price, referencePrice: fill.price,
          unrealizedPnl: (fill.price - weightedAverageEntryPrice) * quantity - entryFeeBalance,
          entryFeeBalance, riskCapital: current.riskCapital + fill.quantity * plan.stopDistanceAbsolute,
          updatedAt: fill.timestamp, protectionPlan: { ...plan },
          protectionMode: policy.protectionMode,
          protection: protectionState(plan, weightedAverageEntryPrice, fill.timestamp),
        };
      }
    } else {
      if (!current || current.symbol !== fill.symbol) return result('NO_MATCHING_POSITION');
      if (fill.quantity > current.quantity) return result('OVERSELL');
      this.rollDay(fill.timestamp);
      const closedQuantity = Math.min(fill.quantity, current.quantity);
      const entryFeeShare = current.entryFeeBalance * (closedQuantity / current.quantity);
      const realized = (fill.price - current.weightedAverageEntryPrice) * closedQuantity
        - entryFeeShare - fill.fee;
      this.cashBalance += closedQuantity * fill.price - fill.fee;
      this.availableQuoteBalance += closedQuantity * fill.price - fill.fee;
      this.realizedPnlToday += realized;
      const remaining = current.quantity - closedQuantity;
      if (remaining <= 1e-12) {
        const netSinceTracking = current.realizedPnl + realized;
        const closedTradePnl = current.tradePerformanceComplete ? netSinceTracking : null;
        const closedTradeOutcomeR = closedTradePnl !== null && current.riskCapital > 0
          ? closedTradePnl / current.riskCapital : null;
        this.position = null;
        this.completedTrades += 1;
        if (closedTradePnl !== null && closedTradePnl > 0) {
          this.winningTrades += 1; this.consecutiveWins += 1; this.consecutiveLosses = 0;
        } else if (closedTradePnl !== null && closedTradePnl < 0) {
          this.losingTrades += 1; this.consecutiveLosses += 1; this.consecutiveWins = 0;
        } else if (closedTradePnl === 0) {
          this.consecutiveWins = 0; this.consecutiveLosses = 0;
        }
        this.timestamp = fill.timestamp;
        this.seenFills.add(fillKey);
        this.updateEquityMetrics();
        return result('APPLIED', closedTradePnl, closedTradeOutcomeR);
      }
      const entryFeeBalance = current.entryFeeBalance - entryFeeShare;
      this.position = {
        ...current, quantity: remaining, markPrice: fill.price, referencePrice: fill.price,
        realizedPnl: current.realizedPnl + realized,
        unrealizedPnl: (fill.price - current.weightedAverageEntryPrice) * remaining - entryFeeBalance,
        entryFeeBalance, updatedAt: fill.timestamp,
      };
    }
    this.timestamp = fill.timestamp;
    this.seenFills.add(fillKey);
    this.updateEquityMetrics();
    return result('APPLIED');
  }

  updateMark(symbol: string, price: number, timestamp: number): void {
    const position = this.position;
    if (!position) throw new Error('No open position');
    if (position.symbol !== symbol) throw new MonitorSymbolError(symbol, position.symbol);
    if (!positive(price) || !finite(timestamp) || timestamp < this.timestamp) {
      throw new RangeError('Invalid mark price or timestamp');
    }
    this.rollDay(timestamp);
    this.position = {
      ...position, markPrice: price, referencePrice: price,
      unrealizedPnl: (price - position.weightedAverageEntryPrice) * position.quantity
        - position.entryFeeBalance,
      updatedAt: timestamp,
    };
    this.timestamp = timestamp;
    this.updateEquityMetrics();
  }

  recordDecision(summary: DecisionMemorySummary): void {
    if (!summary.symbol || !finite(summary.timestamp) || summary.timestamp < 0
      || (summary.outcomeR !== null && !finite(summary.outcomeR))) {
      throw new RangeError('Invalid decision summary');
    }
    this.memory.push({ ...summary });
    this.memory.sort((a, b) => b.timestamp - a.timestamp);
    this.memory = this.memory.slice(0, 5);
  }

  getRecentDecisionMemory(): readonly DecisionMemorySummary[] {
    return this.memory.map(item => ({ ...item }));
  }

  reconcileStartup(snapshot: StartupExchangeSnapshot, context: StartupMonitorContext): StartupMonitorResult {
    const symbols = snapshot.positions.filter(item => item.quantity > 0).map(item => item.symbol);
    const localSymbol = this.position?.symbol ?? null;
    const response = (status: StartupMonitorResult['status'], reason: string): StartupMonitorResult => ({
      status, reason, exchangePositionSymbols: symbols,
      localPositionSymbol: localSymbol, position: copyPosition(this.position),
    });
    if (!positive(snapshot.totalEquityUsd) || !finite(snapshot.timestamp)
      || snapshot.timestamp < this.timestamp || snapshot.positions.length > 1
      || snapshot.positions.some(item => !item.symbol || !positive(item.quantity))) {
      return response('INVALID_SNAPSHOT', 'Invalid or multi-position exchange snapshot');
    }
    const exchangePosition = snapshot.positions[0] ?? null;
    if (localSymbol && localSymbol !== (exchangePosition?.symbol ?? null)) {
      return response('DISCREPANCY', `Local ${localSymbol} differs from exchange ${exchangePosition?.symbol ?? 'FLAT'}`);
    }
    if (localSymbol && exchangePosition && this.position?.quantity !== exchangePosition.quantity) {
      return response('DISCREPANCY', 'Local and exchange quantities differ');
    }
    if (localSymbol && exchangePosition && positive(exchangePosition.averageEntryPrice)
      && this.position?.weightedAverageEntryPrice !== exchangePosition.averageEntryPrice) {
      return response('DISCREPANCY', 'Local and exchange average entry prices differ');
    }
    const quoteBalance = snapshot.balances.find(item => item.currency === 'USDT');
    if (quoteBalance && (!finite(quoteBalance.available) || quoteBalance.available < 0)) {
      return response('INVALID_SNAPSHOT', 'Invalid quote balance');
    }
    let restored: OpenPosition | null = null;
    if (exchangePosition) {
      const symbol = exchangePosition.symbol;
      const matchingLocal = this.position?.symbol === symbol ? this.position : null;
      const reference = context.referencePrices[symbol];
      const openedAt = matchingLocal?.openedAt ?? context.openedAtBySymbol[symbol];
      const plan = context.protectionPlans[symbol] ?? null;
      const mode = context.protectionModes[symbol];
      if (!positive(reference) || !positive(exchangePosition.averageEntryPrice)
        || !finite(openedAt) || openedAt > snapshot.timestamp || openedAt < 0
        || !validProtection(symbol, plan) || mode !== plan.protectionMode) {
        return response('INVALID_SNAPSHOT', 'Missing explicit price, opening time, cost basis, or symbol-matched protection');
      }
      const cash = snapshot.totalEquityUsd - exchangePosition.quantity * reference;
      if (!finite(cash) || cash < 0) return response('INVALID_SNAPSHOT', 'Exchange equity cannot cover marked position');
      restored = {
        symbol, quantity: exchangePosition.quantity,
        weightedAverageEntryPrice: exchangePosition.averageEntryPrice,
        markPrice: reference, referencePrice: reference,
        realizedPnl: matchingLocal?.realizedPnl ?? 0,
        unrealizedPnl: (reference - exchangePosition.averageEntryPrice) * exchangePosition.quantity
          - (matchingLocal?.entryFeeBalance ?? 0),
        tradePerformanceComplete: matchingLocal?.tradePerformanceComplete ?? false,
        entryFeeBalance: matchingLocal?.entryFeeBalance ?? 0,
        riskCapital: matchingLocal?.riskCapital ?? exchangePosition.quantity * plan.stopDistanceAbsolute,
        openedAt, updatedAt: snapshot.timestamp,
        protectionPlan: { ...plan }, protectionMode: mode,
        protection: matchingLocal ? {
          ...matchingLocal.protection, mode,
          currentStopPrice: Math.max(matchingLocal.protection.currentStopPrice, plan.initialStopPrice),
          lastUpdatedAt: snapshot.timestamp,
        } : protectionState(plan, exchangePosition.averageEntryPrice, snapshot.timestamp),
      };
      this.cashBalance = cash;
    } else {
      this.cashBalance = snapshot.totalEquityUsd;
    }
    this.position = restored;
    this.availableQuoteBalance = quoteBalance?.available ?? 0;
    this.dayStartEquity = snapshot.totalEquityUsd;
    this.realizedPnlToday = 0;
    this.timestamp = snapshot.timestamp;
    this.updateEquityMetrics();
    return response('RESTORED', 'Exchange truth restored; daily performance baseline reset at startup');
  }
}

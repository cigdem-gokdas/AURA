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
    ...(position.attachedProtectionIds ? { attachedProtectionIds: [...position.attachedProtectionIds] } : {}),
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
  private readonly positions = new Map<string, OpenPosition>();
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

  constructor(readonly startingEquity: number, timestamp: number, availableQuoteBalance = startingEquity,
    readonly maxConcurrentPositions = 3) {
    if (!positive(startingEquity) || !finite(timestamp) || timestamp < 0
      || !finite(availableQuoteBalance) || availableQuoteBalance < 0
      || !Number.isSafeInteger(maxConcurrentPositions) || maxConcurrentPositions < 1) {
      throw new RangeError('Invalid monitor starting state');
    }
    this.cashBalance = startingEquity;
    this.availableQuoteBalance = availableQuoteBalance;
    this.dayStartEquity = startingEquity;
    this.peakEquity = startingEquity;
    this.timestamp = timestamp;
  }

  private currentEquity(): number {
    return this.cashBalance + [...this.positions.values()].reduce((sum, item) => sum + item.quantity * item.markPrice, 0);
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

  async getOpenPosition(symbol?: string): Promise<OpenPosition | null> {
    return copyPosition(symbol ? this.positions.get(symbol) ?? null
      : this.positions.values().next().value ?? null);
  }

  async getOpenPositions(): Promise<readonly OpenPosition[]> {
    return [...this.positions.values()].map(item => copyPosition(item)!);
  }

  async getEquitySnapshot(): Promise<EquitySnapshot> {
    const currentEquity = this.currentEquity();
    const dailyPnl = currentEquity - this.dayStartEquity;
    return {
      startingEquity: this.startingEquity, currentEquity, peakEquity: this.peakEquity,
      equity: currentEquity, availableQuoteBalance: this.availableQuoteBalance,
      unrealizedPnl: [...this.positions.values()].reduce((sum, item) => sum + item.unrealizedPnl, 0),
      realizedPnlToday: this.realizedPnlToday, dailyPnl,
      dailyReturn: this.dayStartEquity > 0 ? dailyPnl / this.dayStartEquity : 0,
      currentDrawdown: this.peakEquity > 0 ? Math.max(0, (this.peakEquity - currentEquity) / this.peakEquity) : 0,
      maximumDrawdown: this.maximumDrawdown,
      openPositionSymbol: this.positions.size === 1 ? this.positions.keys().next().value ?? null : null,
      openPositionSymbols: [...this.positions.keys()], timestamp: this.timestamp,
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
      status, position: copyPosition(this.positions.get(fill.symbol) ?? null), closedTradePnl, closedTradeOutcomeR,
    });
    if (!fill.symbol || !fill.fillId || !positive(fill.quantity) || !positive(fill.price)
      || !finite(fill.fee) || fill.fee < 0 || !finite(fill.timestamp)
      || fill.timestamp < this.timestamp || (fill.side !== 'BUY' && fill.side !== 'SELL')) {
      return result('INVALID_FILL');
    }
    const fillKey = `${fill.symbol}:${fill.fillId}`;
    if (this.seenFills.has(fillKey)) return result('DUPLICATE_FILL');
    const current = this.positions.get(fill.symbol) ?? null;
    if (fill.side === 'BUY') {
      if (!current && this.positions.size >= this.maxConcurrentPositions) return result('SYMBOL_CONFLICT');
      if (current && !policy?.allowSameSymbolIncrease) return result('SAME_SYMBOL_INCREASE_NOT_ALLOWED');
      const plan = policy?.protectionPlan ?? null;
      if (!validProtection(fill.symbol, plan) || policy?.protectionMode !== plan.protectionMode) {
        return result('PROTECTION_MISMATCH');
      }
      this.rollDay(fill.timestamp);
      this.cashBalance -= fill.quantity * fill.price + fill.fee;
      this.availableQuoteBalance -= fill.quantity * fill.price + fill.fee;
      if (!current) {
        this.positions.set(fill.symbol, {
          symbol: fill.symbol, quantity: fill.quantity, weightedAverageEntryPrice: fill.price,
          markPrice: fill.price, referencePrice: fill.price,
          realizedPnl: 0, unrealizedPnl: -fill.fee, tradePerformanceComplete: true,
          entryFeeBalance: fill.fee,
          riskCapital: fill.quantity * plan.stopDistanceAbsolute,
          openedAt: fill.timestamp, updatedAt: fill.timestamp,
          protectionPlan: { ...plan }, protectionMode: policy.protectionMode,
          protection: protectionState(plan, fill.price, fill.timestamp),
          entryOrderId: fill.exchangeOrderId || null,
          entryClientOrderId: fill.clientOrderId || null,
          attachedProtectionIds: [...(policy.entryProtectionIds ?? [])],
        });
      } else {
        const quantity = current.quantity + fill.quantity;
        const weightedAverageEntryPrice =
          (current.quantity * current.weightedAverageEntryPrice + fill.quantity * fill.price) / quantity;
        const entryFeeBalance = current.entryFeeBalance + fill.fee;
        this.positions.set(fill.symbol, {
          ...current, quantity, weightedAverageEntryPrice,
          markPrice: fill.price, referencePrice: fill.price,
          unrealizedPnl: (fill.price - weightedAverageEntryPrice) * quantity - entryFeeBalance,
          entryFeeBalance, riskCapital: current.riskCapital + fill.quantity * plan.stopDistanceAbsolute,
          updatedAt: fill.timestamp, protectionPlan: { ...plan },
          protectionMode: policy.protectionMode,
          protection: protectionState(plan, weightedAverageEntryPrice, fill.timestamp),
        });
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
        const closed = this.finalizeClose(current, realized, fill.timestamp);
        this.seenFills.add(fillKey);
        return result('APPLIED', closed.closedTradePnl, closed.closedTradeOutcomeR);
      }
      const entryFeeBalance = current.entryFeeBalance - entryFeeShare;
      this.positions.set(fill.symbol, {
        ...current, quantity: remaining, markPrice: fill.price, referencePrice: fill.price,
        realizedPnl: current.realizedPnl + realized,
        unrealizedPnl: (fill.price - current.weightedAverageEntryPrice) * remaining - entryFeeBalance,
        entryFeeBalance, updatedAt: fill.timestamp,
      });
    }
    this.timestamp = fill.timestamp;
    this.seenFills.add(fillKey);
    this.updateEquityMetrics();
    return result('APPLIED');
  }

  private finalizeClose(current: OpenPosition, realized: number, timestamp: number):
  { closedTradePnl: number | null; closedTradeOutcomeR: number | null } {
    const netSinceTracking = current.realizedPnl + realized;
    const closedTradePnl = current.tradePerformanceComplete ? netSinceTracking : null;
    const closedTradeOutcomeR = closedTradePnl !== null && current.riskCapital > 0
      ? closedTradePnl / current.riskCapital : null;
    this.positions.delete(current.symbol);
    this.completedTrades += 1;
    if (closedTradePnl !== null && closedTradePnl > 0) {
      this.winningTrades += 1; this.consecutiveWins += 1; this.consecutiveLosses = 0;
    } else if (closedTradePnl !== null && closedTradePnl < 0) {
      this.losingTrades += 1; this.consecutiveLosses += 1; this.consecutiveWins = 0;
    } else if (closedTradePnl === 0) {
      this.consecutiveWins = 0; this.consecutiveLosses = 0;
    }
    this.timestamp = timestamp;
    this.updateEquityMetrics();
    return { closedTradePnl, closedTradeOutcomeR };
  }

  /**
   * Writes off a remainder smaller than one exchange lot at zero value. Such dust
   * cannot be sold; it stays in the wallet as unmanaged inventory and the trade
   * is finalized so the single-position budget is released.
   */
  closeResidualDust(symbol: string, maxQuantity: number, timestamp: number): FillProcessingResult {
    const result = (status: FillProcessingResult['status'], closedTradePnl: number | null = null,
      closedTradeOutcomeR: number | null = null): FillProcessingResult => ({
      status, position: copyPosition(this.positions.get(symbol) ?? null), closedTradePnl, closedTradeOutcomeR,
    });
    const current = this.positions.get(symbol) ?? null;
    if (!current || current.symbol !== symbol) return result('NO_MATCHING_POSITION');
    if (!positive(maxQuantity) || current.quantity >= maxQuantity || !finite(timestamp)
      || timestamp < this.timestamp) return result('INVALID_FILL');
    this.rollDay(timestamp);
    const realized = -current.quantity * current.weightedAverageEntryPrice - current.entryFeeBalance;
    this.realizedPnlToday += realized;
    const closed = this.finalizeClose(current, realized, timestamp);
    return result('APPLIED', closed.closedTradePnl, closed.closedTradeOutcomeR);
  }

  updateMark(symbol: string, price: number, timestamp: number): void {
    const position = this.positions.get(symbol) ?? null;
    if (!position) throw new Error('No open position');
    if (position.symbol !== symbol) throw new MonitorSymbolError(symbol, position.symbol);
    if (!positive(price) || !finite(timestamp) || timestamp < this.timestamp) {
      throw new RangeError('Invalid mark price or timestamp');
    }
    this.rollDay(timestamp);
    this.positions.set(symbol, {
      ...position, markPrice: price, referencePrice: price,
      unrealizedPnl: (price - position.weightedAverageEntryPrice) * position.quantity
        - position.entryFeeBalance,
      updatedAt: timestamp,
    });
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
    const localSymbol = this.positions.size === 1 ? this.positions.keys().next().value ?? null : null;
    const response = (status: StartupMonitorResult['status'], reason: string): StartupMonitorResult => ({
      status, reason, exchangePositionSymbols: symbols,
      localPositionSymbol: localSymbol, position: copyPosition(this.positions.values().next().value ?? null),
      positions: [...this.positions.values()].map(item => copyPosition(item)!),
    });
    if (!positive(snapshot.totalEquityUsd) || !finite(snapshot.timestamp)
      || snapshot.timestamp < this.timestamp || snapshot.positions.length > this.maxConcurrentPositions
      || new Set(symbols).size !== symbols.length
      || snapshot.positions.some(item => !item.symbol || !positive(item.quantity))) {
      return response('INVALID_SNAPSHOT', 'Invalid or over-cap exchange snapshot');
    }
    if (this.positions.size > 0 && (this.positions.size !== snapshot.positions.length
      || [...this.positions.keys()].some(symbol => !symbols.includes(symbol)))) {
      return response('DISCREPANCY', 'Local managed-position symbols differ from exchange');
    }
    for (const exchangePosition of snapshot.positions) {
      const local = this.positions.get(exchangePosition.symbol);
      if (local && (local.quantity !== exchangePosition.quantity
        || (positive(exchangePosition.averageEntryPrice)
          && local.weightedAverageEntryPrice !== exchangePosition.averageEntryPrice))) {
        return response('DISCREPANCY', `Local and exchange ${exchangePosition.symbol} quantities or entry prices differ`);
      }
    }
    const quoteBalance = snapshot.balances.find(item => item.currency === 'USDT');
    if (quoteBalance && (!finite(quoteBalance.available) || quoteBalance.available < 0)) {
      return response('INVALID_SNAPSHOT', 'Invalid quote balance');
    }
    const restored = new Map<string, OpenPosition>();
    for (const exchangePosition of snapshot.positions) {
      const symbol = exchangePosition.symbol;
      const matchingLocal = this.positions.get(symbol) ?? null;
      const reference = context.referencePrices[symbol];
      const openedAt = matchingLocal?.openedAt ?? context.openedAtBySymbol[symbol];
      const plan = context.protectionPlans[symbol] ?? null;
      const mode = context.protectionModes[symbol];
      if (!positive(reference) || !positive(exchangePosition.averageEntryPrice)
        || !finite(openedAt) || openedAt > snapshot.timestamp || openedAt < 0
        || !validProtection(symbol, plan) || mode !== plan.protectionMode) {
        return response('INVALID_SNAPSHOT', 'Missing explicit price, opening time, cost basis, or symbol-matched protection');
      }
      const links = matchingLocal
        ? { entryOrderId: matchingLocal.entryOrderId ?? null, entryClientOrderId: matchingLocal.entryClientOrderId ?? null,
          attachedProtectionIds: matchingLocal.attachedProtectionIds ?? [] }
        : context.exchangeLinks?.[symbol] ?? null;
      restored.set(symbol, {
        ...(links ? { entryOrderId: links.entryOrderId, entryClientOrderId: links.entryClientOrderId,
          attachedProtectionIds: [...links.attachedProtectionIds] } : {}),
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
      });
    }
    const cash = snapshot.totalEquityUsd - [...restored.values()]
      .reduce((sum, item) => sum + item.quantity * item.markPrice, 0);
    if (!finite(cash) || cash < 0) return response('INVALID_SNAPSHOT', 'Exchange equity cannot cover marked positions');
    this.positions.clear();
    for (const [symbol, item] of restored) this.positions.set(symbol, item);
    this.cashBalance = cash;
    this.availableQuoteBalance = quoteBalance?.available ?? 0;
    this.dayStartEquity = snapshot.totalEquityUsd;
    this.realizedPnlToday = 0;
    this.timestamp = snapshot.timestamp;
    this.updateEquityMetrics();
    return response('RESTORED', 'Exchange truth restored; daily performance baseline reset at startup');
  }
}

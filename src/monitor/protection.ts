import type { MarketRegime } from '../regime/types.js';
import type { OpenPosition } from './types.js';

export class MonitorSymbolError extends Error {
  readonly code = 'SYMBOL_MISMATCH';
  constructor(symbol: string, held: string) {
    super(`Requested ${symbol} but monitor position belongs to ${held}`);
    this.name = 'MonitorSymbolError';
  }
}

function assertPositionSymbol(symbol: string, position: OpenPosition): void {
  if (position.symbol !== symbol || position.protectionPlan.symbol !== symbol) {
    throw new MonitorSymbolError(symbol, position.symbol);
  }
}

function positive(value: number): boolean { return Number.isFinite(value) && value > 0; }

export function hardStopBreached(symbol: string, position: OpenPosition, price: number): boolean {
  assertPositionSymbol(symbol, position);
  if (!positive(price)) throw new RangeError('Invalid mark price');
  return price <= position.protection.currentStopPrice;
}

export function promoteBreakEven(symbol: string, position: OpenPosition, price: number, timestamp: number): OpenPosition {
  assertPositionSymbol(symbol, position);
  if (!positive(price) || !Number.isFinite(timestamp)) throw new RangeError('Invalid price or timestamp');
  const trigger = position.weightedAverageEntryPrice
    + position.protectionPlan.stopDistanceAbsolute * position.protectionPlan.breakEvenTriggerR;
  if (price < trigger) return position;
  return {
    ...position, updatedAt: timestamp,
    protection: { ...position.protection, breakEvenActivated: true,
      currentStopPrice: Math.max(position.protection.currentStopPrice, position.weightedAverageEntryPrice),
      lastUpdatedAt: timestamp },
  };
}

export function activateTrailing(symbol: string, position: OpenPosition, price: number, timestamp: number): OpenPosition {
  assertPositionSymbol(symbol, position);
  if (!positive(price) || !Number.isFinite(timestamp)) throw new RangeError('Invalid price or timestamp');
  const trigger = position.weightedAverageEntryPrice
    + position.protectionPlan.stopDistanceAbsolute * position.protectionPlan.trailingActivationR;
  if (price < trigger) return position;
  return { ...position, updatedAt: timestamp,
    protection: { ...position.protection, trailingActivated: true, lastUpdatedAt: timestamp } };
}

export function updateAtrTrailingStop(
  symbol: string, position: OpenPosition, price: number, atr: number, multiplier: number, timestamp: number,
): OpenPosition {
  assertPositionSymbol(symbol, position);
  if (!positive(price) || !positive(atr) || !positive(multiplier) || !Number.isFinite(timestamp)) {
    throw new RangeError('Invalid ATR trailing inputs');
  }
  if (!position.protection.trailingActivated) return position;
  const candidateStop = price - atr * multiplier;
  if (!positive(candidateStop)) return position;
  return { ...position, updatedAt: timestamp,
    protection: { ...position.protection,
      currentStopPrice: Math.max(position.protection.currentStopPrice, candidateStop),
      lastUpdatedAt: timestamp } };
}

export function takeProfitReference(symbol: string, position: OpenPosition): number {
  assertPositionSymbol(symbol, position);
  return position.weightedAverageEntryPrice
    + position.protectionPlan.stopDistanceAbsolute * position.protectionPlan.takeProfitR;
}

export function takeProfitReached(symbol: string, position: OpenPosition, price: number): boolean {
  if (!positive(price)) throw new RangeError('Invalid mark price');
  return price >= takeProfitReference(symbol, position);
}

export function timeStopReached(symbol: string, position: OpenPosition, evaluationTime: number, maxHoldingMs: number): boolean {
  assertPositionSymbol(symbol, position);
  if (!Number.isFinite(evaluationTime) || !positive(maxHoldingMs) || evaluationTime < position.openedAt) {
    throw new RangeError('Invalid time-stop inputs');
  }
  return evaluationTime - position.openedAt >= maxHoldingMs;
}

export function regimeInvalidated(
  symbol: string, position: OpenPosition, entryRegime: MarketRegime, currentRegime: MarketRegime,
): boolean {
  assertPositionSymbol(symbol, position);
  return entryRegime !== currentRegime;
}

export function emergencyRiskExit(
  symbol: string, position: OpenPosition,
  flags: { killSwitch: boolean; hardDrawdown: boolean; emergencyExit: boolean; volatilityExit: boolean },
): boolean {
  assertPositionSymbol(symbol, position);
  return flags.killSwitch || flags.hardDrawdown || flags.emergencyExit || flags.volatilityExit;
}

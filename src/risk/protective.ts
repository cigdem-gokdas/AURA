import type { ProtectionPlan, RiskOpenPosition } from './types.js';

export interface ProtectiveExitInput {
  position: RiskOpenPosition | null;
  marketPrice: number;
  protection: ProtectionPlan | null;
  emergencyExit: boolean;
  volatilityExit: boolean;
  regimeInvalidated: boolean;
  drawdownProtection: boolean;
  lockdownClose: boolean;
  killSwitchActive: boolean;
}

export type ProtectiveExitReason =
  | 'NO_POSITION' | 'NONE' | 'HARD_STOP' | 'PROTECTION_MISSING' | 'PROTECTION_MISMATCH'
  | 'EMERGENCY_EXIT' | 'VOLATILITY_EXIT' | 'REGIME_INVALIDATION'
  | 'DRAWDOWN_PROTECTION' | 'LOCKDOWN_CLOSE' | 'KILL_SWITCH_CLOSE';

/** Deliberately has no LLM input: protective exits remain live during LLM failure. */
export function evaluateProtectiveExit(input: ProtectiveExitInput): {
  action: 'EXIT' | 'HOLD'; reason: ProtectiveExitReason;
} {
  if (!input.position) return { action: 'HOLD', reason: 'NO_POSITION' };
  if (input.emergencyExit) return { action: 'EXIT', reason: 'EMERGENCY_EXIT' };
  if (input.killSwitchActive) return { action: 'EXIT', reason: 'KILL_SWITCH_CLOSE' };
  if (input.lockdownClose) return { action: 'EXIT', reason: 'LOCKDOWN_CLOSE' };
  if (input.drawdownProtection) return { action: 'EXIT', reason: 'DRAWDOWN_PROTECTION' };
  if (!input.protection) return { action: 'EXIT', reason: 'PROTECTION_MISSING' };
  if (input.protection && input.protection.symbol !== input.position.symbol) return { action: 'EXIT', reason: 'PROTECTION_MISMATCH' };
  if (input.protection && Number.isFinite(input.marketPrice) && input.marketPrice <= input.protection.initialStopPrice) {
    return { action: 'EXIT', reason: 'HARD_STOP' };
  }
  if (input.volatilityExit) return { action: 'EXIT', reason: 'VOLATILITY_EXIT' };
  if (input.regimeInvalidated) return { action: 'EXIT', reason: 'REGIME_INVALIDATION' };
  return { action: 'HOLD', reason: 'NONE' };
}

export type SubmissionOutcome = 'NOT_SUBMITTED' | 'CONFIRMED' | 'SUBMITTED_TIMEOUT';
export function decideSubmissionRecovery(outcome: SubmissionOutcome): {
  action: 'NONE' | 'RECONCILE'; retry: false;
} {
  return { action: outcome === 'SUBMITTED_TIMEOUT' ? 'RECONCILE' : 'NONE', retry: false };
}

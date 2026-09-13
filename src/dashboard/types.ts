import type { JudgeSnapshot } from '../agent/judge.js';

/** Transport adds only observation history; trading state remains JudgeSnapshot. */
export interface EquityPoint {
  timestamp: number;
  equity: number;
  dailyPnl: number;
  drawdownPct: number;
  /** OKX profile this observation belongs to; keeps demo and live equity history from mixing. */
  profile: 'demo' | 'live' | null;
}

export interface DashboardState {
  snapshot: JudgeSnapshot | null;
  equityHistory: readonly EquityPoint[];
  critic: { setupQuality: 'A' | 'B' | 'C' | 'D' | null };
  /** Matching LOCKDOWN event for the snapshot's decision cycle was found in the audit log. */
  lockdownAuditConfirmed: boolean;
  bridgeStatus: 'READY' | 'OFFLINE';
  receivedAt: number | null;
}

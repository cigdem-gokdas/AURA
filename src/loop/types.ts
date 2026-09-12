import type { MarketRegime } from '../regime/types.js';
import type { SetupType, SignalAction } from '../signal/types.js';
import type { RiskMode } from '../risk/types.js';

export type AgentState =
  | 'BOOTING'
  | 'PREFLIGHT'
  | 'OBSERVE_ONLY'
  | 'LIVE_READY'
  | 'LIVE'
  | 'DEGRADED'
  | 'HALTED';

export interface SymbolMarketSummary {
  symbol: string;
  marketTimestamp: number | null;
  lastPrice: number | null;
  dataAgeMs: number | null;
  regime: MarketRegime | null;
  candidateAction: SignalAction | null;
  candidateSetupType: SetupType | null;
  candidateOpportunityScore: number | null;
}

export interface AgentStateSnapshot {
  state: AgentState;
  riskMode: RiskMode;
  trackedSymbols: readonly string[];
  perSymbol: readonly SymbolMarketSummary[];
  selectedSymbol: string | null;
  currentOpenPositionSymbol: string | null;
  cycleId: string | null;
  timestamp: number;
}

export interface AuditEvent {
  eventId: string;
  category: string;
  message: string;
  symbol: string | null;
  cycleId: string | null;
  decisionId: string | null;
  timestamp: number;
  details?: Readonly<Record<string, unknown>>;
}

/** Contract only; no persistence or logging implementation exists. */
export interface AuditLogger {
  record(event: AuditEvent): Promise<void>;
}

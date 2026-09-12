import type { MarketRegime } from '../regime/types.js';
import type { SetupType } from '../signal/types.js';

export type DecisionResultCategory =
  | 'ACCEPTED'
  | 'REJECTED_RISK'
  | 'REJECTED_LLM'
  | 'REJECTED_COST'
  | 'SKIPPED'
  | 'CLOSED'
  | 'UNKNOWN';

export interface DecisionMemorySummary {
  symbol: string;
  setupType: SetupType;
  regime: MarketRegime;
  resultCategory: DecisionResultCategory;
  outcomeR: number | null;
  stopHit: boolean | null;
  timestamp: number;
}

import { z } from 'zod';
import type { MarketRegime } from '../regime/types.js';
import type { CandidateSignal } from '../signal/types.js';
import type { DecisionMemorySummary } from '../memory/types.js';
import type { AtkContextPulse, AtkCrossMarketContext, AtkIndicatorCrossCheck } from '../agent/atk-evidence.js';

export const LlmDecisionSchema = z.strictObject({
  action: z.enum(['AGREE', 'DISAGREE', 'ABSTAIN']),
  confidence: z.number().min(0).max(1),
  regime_confirmation: z.enum([
    'TRENDING_UP',
    'TRENDING_DOWN',
    'RANGE',
    'HIGH_VOLATILITY',
    'UNCERTAIN',
  ]),
  setup_quality: z.enum(['A', 'B', 'C', 'D']),
  risk_flag: z.enum(['LOW', 'MEDIUM', 'HIGH']),
  reason: z.string().max(280),
  counter_thesis: z.string().max(180),
  memory_signal: z.enum([
    'NONE',
    'CHOP_RISK',
    'REPEATED_LOSS_PATTERN',
    'MOMENTUM_DECAY',
  ]),
});

export type LlmDecision = z.infer<typeof LlmDecisionSchema>;

/** Informational context only. Symbol selection is outside the LLM contract. */
export interface CrossMarketContext {
  selectedSymbol: string;
  selectedOQS: number;
  otherSymbol: string;
  otherOQS: number;
  otherRegime: MarketRegime;
}

/** The deterministic selector has already chosen this one entry candidate. */
export interface SelectedCandidateContext {
  candidate: CandidateSignal;
  crossMarket: CrossMarketContext;
  microstructure: {
    spreadBps: number;
    obiTop5: number;
    micropriceLeanBps: number;
  };
  /** Position size is deliberately absent from the LLM boundary. */
  position: { hasOpenLong: boolean; openLongSymbol: string | null };
  recentMemory: readonly DecisionMemorySummary[];
  indicatorCrossChecks?: readonly AtkIndicatorCrossCheck[];
  atkCrossMarket?: AtkCrossMarketContext;
  contextPulse?: AtkContextPulse | null;
}

export interface LlmTokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
}

/** A critic only validates an existing candidate; it cannot place or size orders. */
export interface LlmClient {
  evaluateSelectedCandidate(context: SelectedCandidateContext): Promise<LlmDecisionResult>;
}

export type LlmDecisionStatus =
  | 'SUCCESS'
  | 'TIMEOUT'
  | 'UNREACHABLE'
  | 'HTTP_ERROR'
  | 'MALFORMED_RESPONSE'
  | 'SCHEMA_INVALID'
  | 'CONFIG_ERROR'
  | 'BUDGET_EXCEEDED';

export interface LlmValidationIssue {
  path: readonly (string | number)[];
  code: string;
  message: string;
  expected: string;
  received: string;
}

export interface LlmProseTruncation {
  field: 'reason' | 'counter_thesis';
  originalLength: number;
  truncatedLength: number;
}

export type LlmDecisionResult =
  | { status: 'SUCCESS'; decision: LlmDecision; latencyMs: number; usage: LlmTokenUsage;
      proseTruncations?: readonly LlmProseTruncation[] }
  | {
      status: Exclude<LlmDecisionStatus, 'SUCCESS'>;
      decision?: never;
      error?: string;
      latencyMs?: number;
      rawResponse?: string;
      validationSource?: 'ZOD' | 'OTHER_SYMBOL_RECOMMENDATION';
      validationIssues?: readonly LlmValidationIssue[];
      validationIssueCount?: number;
      proseTruncations?: readonly LlmProseTruncation[];
    };

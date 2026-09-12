import type { AtkContextPulse, AtkCrossMarketContext, AtkIndicatorCrossCheck } from './atk-evidence.js';
import type { ObserverSnapshot, PreflightReport } from './agent.js';
import type { DecisionProvenance } from './provenance.js';
import type { AtkToolTrace } from '../okx/telemetry.js';

export interface JudgeSnapshot {
  timestamp: number;
  functional: ObserverSnapshot;
  reasoning: {
    selectedSymbol: string | null;
    perSymbolOqs: Readonly<Record<string, number>>;
    criticVerdict: string | null;
    counterThesis: string | null;
    riskCertificate: ObserverSnapshot['riskCertificate'];
  };
  atk: {
    readLane: PreflightReport['readLane'] | null;
    writeLane: PreflightReport['writeLane'] | null;
    uniqueToolsUsed: readonly string[];
    recentTraces: readonly AtkToolTrace[];
    latestProvenance: DecisionProvenance | null;
    indicatorCrossChecks: readonly AtkIndicatorCrossCheck[];
    crossMarket: AtkCrossMarketContext | null;
    contextPulse: AtkContextPulse | null;
  };
  safety: {
    liveArmed: boolean;
    riskMode: string | null;
    protectionMode: string | null;
    reconciliationPending: boolean;
    degradedReason: string | null;
  };
}

export type ExplainIntent = 'WHY_SELECTED' | 'WHY_REJECTED' | 'WHY_NOT_TRADING'
  | 'CURRENT_RISK' | 'CURRENT_POSITION' | 'CURRENT_PROTECTION' | 'MCP_EVIDENCE';

export interface ExplainAnswer { intent: ExplainIntent; text: string; timestamp: number; }

export function freezeJudgeSnapshot<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeJudgeSnapshot(child);
    Object.freeze(value);
  }
  return value;
}

/** Only a snapshot supplier is accepted; no connector or execution engine is reachable. */
export class ReadOnlyExplainService {
  constructor(private readonly snapshot: () => JudgeSnapshot | null) {}

  explainCurrentState(intent: ExplainIntent): ExplainAnswer {
    const state = this.snapshot();
    if (!state) return { intent, text: 'No completed AURA state snapshot is available yet.', timestamp: Date.now() };
    const f = state.functional;
    let text: string;
    switch (intent) {
      case 'WHY_SELECTED':
        text = state.reasoning.selectedSymbol
          ? `${state.reasoning.selectedSymbol} ranked first with OQS ${f.selectedOQS ?? 'unavailable'}; the deterministic selector made this choice.`
          : 'No eligible entry was selected in the latest completed cycle.';
        break;
      case 'WHY_REJECTED':
        text = state.reasoning.riskCertificate?.verdict === 'REJECT'
          ? `Risk rejected the proposal: ${state.reasoning.riskCertificate.gates.filter(gate => gate.status === 'FAIL').map(gate => gate.name).join(', ')}.`
          : state.reasoning.criticVerdict && state.reasoning.criticVerdict !== 'AGREE'
            ? `The Market Critic returned ${state.reasoning.criticVerdict}.` : 'The latest cycle has no recorded rejection.';
        break;
      case 'WHY_NOT_TRADING':
        text = f.state !== 'LIVE' ? `AURA is ${f.state}; ${f.degradedReason ?? 'live readiness is not active'}.`
          : f.openPositionSymbol ? `AURA already holds ${f.openPositionSymbol}; the one-position rule blocks new entries.`
            : f.selectedSymbol ? 'The selected proposal did not become an approved execution.'
              : 'No eligible entry was found in the latest cycle.';
        break;
      case 'CURRENT_RISK':
        text = `Risk mode ${state.safety.riskMode ?? 'unavailable'}; drawdown ${f.equity?.currentDrawdownPct ?? 'unavailable'}%; certificate ${state.reasoning.riskCertificate?.verdict ?? 'none'}.`;
        break;
      case 'CURRENT_POSITION':
        text = f.position ? `${f.position.symbol}: quantity ${f.position.quantity}, entry ${f.position.entryPrice}, mark ${f.position.markPrice}.`
          : 'No open position is recorded.';
        break;
      case 'CURRENT_PROTECTION':
        text = f.position ? `${f.position.symbol} stop ${f.position.stopPrice}; mode ${state.safety.protectionMode ?? 'unavailable'}.`
          : 'No position requires protection.';
        break;
      case 'MCP_EVIDENCE':
        text = `READ ${state.atk.readLane?.status ?? 'unknown'}, WRITE ${state.atk.writeLane?.status ?? 'unknown'}; ${state.atk.uniqueToolsUsed.length} actual MCP tools used recently.`;
        break;
    }
    return { intent, text, timestamp: state.timestamp };
  }
}

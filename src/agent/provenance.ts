import type { AtkToolTrace } from '../okx/telemetry.js';

export interface DecisionProvenanceNode {
  source: 'ATK_MCP' | 'LOCAL' | 'LLM' | 'RISK';
  lane: 'READ' | 'WRITE' | null;
  toolName: string | null;
  symbol: string | null;
  timestamp: number;
  description: string;
  latencyMs: number | null;
  success: boolean;
  result: string;
}

export interface DecisionProvenance {
  cycleId: string;
  timestamp: number;
  selectedSymbol: string | null;
  result: string;
  nodes: readonly DecisionProvenanceNode[];
}

export function traceNode(trace: AtkToolTrace): DecisionProvenanceNode {
  return { source: 'ATK_MCP', lane: trace.lane, toolName: trace.toolName,
    symbol: trace.symbol, timestamp: trace.timestamp,
    description: trace.purpose, latencyMs: trace.latencyMs,
    success: trace.success, result: trace.success ? 'OK' : trace.errorCode ?? 'FAILED' };
}

export class DecisionProvenanceBuffer {
  private readonly history: DecisionProvenance[] = [];
  constructor(private readonly limit = 20) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('Invalid provenance limit');
  }
  record(path: DecisionProvenance): void {
    this.history.push({ ...path, nodes: path.nodes.map(node => ({ ...node })) });
    if (this.history.length > this.limit) this.history.splice(0, this.history.length - this.limit);
  }
  latest(): DecisionProvenance | null {
    const item = this.history.at(-1);
    return item ? { ...item, nodes: item.nodes.map(node => ({ ...node })) } : null;
  }
  recent(): readonly DecisionProvenance[] {
    return this.history.map(item => ({ ...item, nodes: item.nodes.map(node => ({ ...node })) }));
  }
}

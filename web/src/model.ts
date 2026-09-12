import type { JudgeSnapshot } from '../../src/agent/judge.js';
import type { DashboardState, EquityPoint } from '../../src/dashboard/types.js';

export const symbols = ['BTC-USDT', 'ETH-USDT'] as const;
export const statusMcpTools = [
  'get_agent_state',
  'get_risk_certificate',
  'get_recent_decisions',
  'get_market_snapshot',
] as const;
export const pipelineNames = [
  'MARKET',
  'FEATURES',
  'REGIME',
  'CANDIDATE',
  'RANKING',
  'MARKET CRITIC',
  'RISK',
  'EXECUTION',
  'PROTECTION',
] as const;
export type PipelineStatus =
  'WAITING' | 'ACTIVE' | 'PASSED' | 'REJECTED' | 'FAILED' | 'SKIPPED';
export interface PipelineStage {
  name: (typeof pipelineNames)[number];
  status: PipelineStatus;
  detail: string;
}

const stages = (status: PipelineStatus, detail = ''): PipelineStage[] =>
  pipelineNames.map((name) => ({ name, status, detail }));
const successful = (value: string): boolean =>
  !/FAIL|BLOCK|ERROR|REJECT/i.test(value);

/** Status comes only from completed provenance and published agent state. */
export function derivePipeline(
  snapshot: JudgeSnapshot | null,
): PipelineStage[] {
  if (!snapshot) return stages('WAITING', 'Awaiting a completed AURA snapshot');
  const path = snapshot.atk.latestProvenance;
  if (!path) {
    const result = stages('WAITING', 'Awaiting the first decision');
    if (snapshot.functional.state === 'PREFLIGHT')
      result[0] = {
        name: 'MARKET',
        status: 'ACTIVE',
        detail: 'Preflight in progress',
      };
    return result;
  }
  const result = stages('SKIPPED', 'NOT CALLED');
  const set = (
    name: PipelineStage['name'],
    status: PipelineStatus,
    detail: string,
  ): void => {
    const index = pipelineNames.indexOf(name);
    result[index] = { name, status, detail };
  };
  const nodes = path.nodes;
  const market = nodes.filter(
    (node) => node.source === 'ATK_MCP' && node.lane === 'READ',
  );
  if (market.length)
    set(
      'MARKET',
      market.every((node) => node.success) ? 'PASSED' : 'FAILED',
      `${market.length} read-side MCP call${market.length === 1 ? '' : 's'}`,
    );
  const evaluated = nodes.filter(
    (node) =>
      node.source === 'LOCAL' && node.description.includes('Features, regime'),
  );
  for (const name of ['FEATURES', 'REGIME', 'CANDIDATE'] as const) {
    if (evaluated.length)
      set(
        name,
        evaluated.every((node) => node.success) ? 'PASSED' : 'FAILED',
        `${evaluated.length} symbol evaluation${evaluated.length === 1 ? '' : 's'}`,
      );
  }
  const ranking = nodes.find((node) =>
    node.description.includes('cross-symbol ranking'),
  );
  if (ranking)
    set('RANKING', ranking.success ? 'PASSED' : 'FAILED', ranking.result);
  const critic = nodes.find((node) => node.source === 'LLM');
  if (critic)
    set(
      'MARKET CRITIC',
      !critic.success
        ? 'FAILED'
        : successful(critic.result)
          ? 'PASSED'
          : 'REJECTED',
      critic.result,
    );
  const risk = nodes.find((node) => node.source === 'RISK');
  const certificate = snapshot.reasoning.riskCertificate;
  if (risk || certificate)
    set(
      'RISK',
      certificate?.verdict === 'REJECT'
        ? 'REJECTED'
        : risk?.success === false
          ? 'FAILED'
          : 'PASSED',
      path.summary?.primaryRejectionReason ??
        certificate?.gates.find((gate) => gate.status === 'FAIL')?.reason ??
        risk?.result ??
        'Certificate issued',
    );
  const execution = nodes.find((node) =>
    node.description.includes('Execution submission'),
  );
  const write = nodes.filter(
    (node) => node.source === 'ATK_MCP' && node.lane === 'WRITE',
  );
  if (execution || write.length)
    set(
      'EXECUTION',
      execution?.success === false || write.some((node) => !node.success)
        ? 'FAILED'
        : 'PASSED',
      execution?.result ??
        `${write.length} write-side MCP call${write.length === 1 ? '' : 's'}`,
    );
  const protection = nodes.find((node) =>
    node.description.includes('protection and reconciliation'),
  );
  if (protection)
    set(
      'PROTECTION',
      protection.success ? 'PASSED' : 'FAILED',
      protection.result,
    );
  else if (snapshot.functional.position && snapshot.safety.protectionMode)
    set('PROTECTION', 'PASSED', snapshot.safety.protectionMode);
  return result;
}

export function primaryRejection(
  snapshot: JudgeSnapshot | null,
): string | null {
  if (!snapshot) return null;
  return (
    snapshot.atk.latestProvenance?.summary?.primaryRejectionReason ??
    snapshot.reasoning.riskCertificate?.gates.find(
      (gate) => gate.status === 'FAIL',
    )?.reason ??
    null
  );
}

export function equityChart(
  points: readonly EquityPoint[],
  starting: number | null,
): {
  points: readonly EquityPoint[];
  min: number;
  max: number;
  peakIndex: number | null;
  starting: number | null;
} {
  const valid = points
    .filter(
      (point) =>
        Number.isFinite(point.equity) && Number.isFinite(point.timestamp),
    )
    .sort((a, b) => a.timestamp - b.timestamp);
  const values = valid.map((point) => point.equity);
  if (starting !== null && Number.isFinite(starting)) values.push(starting);
  const low = values.length ? Math.min(...values) : 0;
  const high = values.length ? Math.max(...values) : 1;
  const padding = Math.max((high - low) * 0.18, Math.abs(high) * 0.005, 1);
  const peak = valid.length
    ? valid.reduce(
        (best, point, index) =>
          point.equity > valid[best]!.equity ? index : best,
        0,
      )
    : null;
  return {
    points: valid,
    min: low - padding,
    max: high + padding,
    peakIndex: peak,
    starting: starting !== null && Number.isFinite(starting) ? starting : null,
  };
}

export function marketRows(snapshot: JudgeSnapshot | null) {
  return symbols.map((symbol) => ({
    symbol,
    market: snapshot?.functional.markets[symbol] ?? null,
    selected: snapshot?.functional.selectedSymbol === symbol,
  }));
}

export function recentDecisionRows(
  snapshot: JudgeSnapshot | null,
  filter: 'ALL' | 'EXECUTED' | 'REJECTED',
) {
  const rows = [...(snapshot?.atk.recentDecisions ?? [])].sort(
    (a, b) => b.timestamp - a.timestamp,
  );
  if (filter === 'ALL') return rows;
  if (filter === 'EXECUTED')
    return rows.filter((row) =>
      /SUBMIT|EXECUT|FILLED|CLOSED/.test(
        row.summary?.executionResult ?? row.result,
      ),
    );
  return rows.filter(
    (row) =>
      row.summary?.riskResult === 'REJECT' || /REJECT|BLOCK/.test(row.result),
  );
}

export function successfulMcpCalls(snapshot: JudgeSnapshot | null): number {
  return (
    snapshot?.atk.recentTraces.filter((trace) => trace.success).length ?? 0
  );
}

export function validateWireState(value: unknown): value is DashboardState {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return (
    (row.bridgeStatus === 'READY' || row.bridgeStatus === 'OFFLINE') &&
    Array.isArray(row.equityHistory) &&
    !!row.critic &&
    typeof row.critic === 'object' &&
    'setupQuality' in row.critic &&
    (row.snapshot === null || typeof row.snapshot === 'object')
  );
}

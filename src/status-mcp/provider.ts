import type { JudgeSnapshot } from '../agent/judge.js';
import { redactAudit } from '../memory/audit.js';

export interface AuraStatusProvider {
  getAgentState(): Promise<Record<string, unknown>>;
  getRiskCertificate(): Promise<Record<string, unknown>>;
  getRecentDecisions(limit: number): Promise<Record<string, unknown>>;
  getMarketSnapshot(symbol?: string): Promise<Record<string, unknown>>;
}

function safe<T>(value: T): T { return redactAudit(value) as T; }

/** A stateless projection of the existing JudgeSnapshot; never queries trading services. */
export class JudgeSnapshotStatusProvider implements AuraStatusProvider {
  constructor(private readonly readSnapshot: () => Promise<JudgeSnapshot | null>) {}

  private async snapshot(): Promise<JudgeSnapshot | null> {
    const snapshot = await this.readSnapshot();
    return snapshot ? safe(snapshot) : null;
  }

  async getAgentState(): Promise<Record<string, unknown>> {
    const snapshot = await this.snapshot();
    if (!snapshot) return { available: false };
    const { functional: f, safety, atk } = snapshot;
    return safe({ available: true, timestamp: f.timestamp, agentState: f.state,
      mode: atk.readLane?.profile ?? atk.writeLane?.profile ?? null,
      trackedSymbols: f.symbols, selectedSymbol: f.selectedSymbol,
      currentPosition: f.position, currentPositions: f.positions ?? (f.position ? [f.position] : []),
      maxConcurrentPositions: f.maxConcurrentPositions ?? 1,
      equity: f.equity?.current ?? null,
      dailyPnL: f.equity?.dailyPnl ?? null, dailyReturn: f.equity?.dailyReturnPct ?? null,
      currentDrawdown: f.equity?.currentDrawdownPct ?? null,
      maxDrawdown: f.equity?.maximumDrawdownPct ?? null,
      riskMode: safety.riskMode, protectionMode: safety.protectionMode,
      reconciliationPending: safety.reconciliationPending,
      atkReadLane: atk.readLane ? { status: atk.readLane.status, serverVersion: atk.readLane.serverVersion,
        readOnly: atk.readLane.readOnly } : null,
      atkWriteLane: atk.writeLane ? { status: atk.writeLane.status, serverVersion: atk.writeLane.serverVersion } : null });
  }

  async getRiskCertificate(): Promise<Record<string, unknown>> {
    const snapshot = await this.snapshot();
    const certificate = snapshot?.reasoning.riskCertificate;
    if (!snapshot || !certificate) return { available: false };
    return safe({ available: true, symbol: certificate.requestedSymbol,
      timestamp: snapshot.timestamp,
      gates: certificate.gates.map(gate => ({ name: gate.name, status: gate.status, reason: gate.reason })),
      verdict: certificate.verdict,
      primaryRejectionReason: snapshot.atk.latestProvenance?.summary?.primaryRejectionReason
        ?? certificate.gates.find(gate => gate.status === 'FAIL')?.reason ?? null,
      calculatedNotional: certificate.calculatedNotional,
      protection: certificate.protectionPlan ? { symbol: certificate.protectionPlan.symbol,
        initialStopPrice: certificate.protectionPlan.initialStopPrice,
        stopDistanceAbsolute: certificate.protectionPlan.stopDistanceAbsolute,
        protectionMode: certificate.protectionPlan.protectionMode } : null });
  }

  async getRecentDecisions(limit: number): Promise<Record<string, unknown>> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new RangeError('limit must be 1..20');
    const snapshot = await this.snapshot();
    const history = snapshot?.atk.recentDecisions ?? [];
    const evaluated = history.map(item => ({
      timestamp: item.timestamp, cycleId: item.cycleId,
      symbol: item.summary?.symbol ?? item.selectedSymbol,
      setupType: item.summary?.setupType ?? null, oqs: item.summary?.oqs ?? null,
      selection: item.summary?.selection ?? (item.selectedSymbol ? 'SELECTED' : 'NOT_SELECTED'),
      marketCriticVerdict: item.summary?.criticVerdict ?? null,
      counter_thesis: item.summary?.counterThesis ?? null,
      riskResult: item.summary?.riskResult ?? null,
      primaryRejectionReason: item.summary?.primaryRejectionReason ?? null,
      executionResult: item.summary?.executionResult ?? null,
      outcomeR: item.summary?.outcomeR ?? null, pnl: item.summary?.pnl ?? null,
    }));
    const closed = (snapshot?.atk.recentDecisionMemory ?? [])
      .filter(item => item.resultCategory === 'CLOSED')
      .map(item => ({ timestamp: item.timestamp, cycleId: null, symbol: item.symbol,
        setupType: item.setupType, oqs: null, selection: 'SELECTED',
        marketCriticVerdict: null, counter_thesis: null, riskResult: null,
        primaryRejectionReason: null, executionResult: 'CLOSED',
        outcomeR: item.outcomeR, pnl: null }));
    return safe({ decisions: [...evaluated, ...closed]
      .sort((a, b) => b.timestamp - a.timestamp).slice(0, limit) });
  }

  async getMarketSnapshot(symbol?: string): Promise<Record<string, unknown>> {
    const snapshot = await this.snapshot();
    if (!snapshot) return { available: false, markets: [] };
    if (symbol !== undefined && !snapshot.functional.symbols.includes(symbol)) throw new RangeError('Unknown tracked symbol');
    const symbols = symbol ? [symbol] : snapshot.functional.symbols;
    const markets = symbols.map(name => {
      const market = snapshot.functional.markets[name];
      if (!market) return { symbol: name, available: false };
      return { symbol: name, available: true, price: market.close,
        regime: market.regime, candidate: market.candidateAction,
        setupType: market.setupType ?? null, oqs: market.oqs,
        edgeCostRatio: market.edgeCostRatio, spreadBps: market.spreadBps,
        obiTop5: market.obiTop5 ?? null, micropriceLeanBps: market.micropriceLeanBps ?? null,
        dataAgeMs: market.dataAgeMs ?? null };
    });
    const sourceTools = snapshot.atk.recentTraces.filter(trace => trace.lane === 'READ').slice(-20).map(trace => ({
      toolName: trace.toolName, lane: trace.lane, symbol: trace.symbol,
      latencyMs: trace.latencyMs, success: trace.success,
    }));
    return safe({ available: true, timestamp: snapshot.timestamp, markets,
      latestAtkSources: sourceTools });
  }
}

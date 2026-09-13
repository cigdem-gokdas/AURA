import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JudgeSnapshot } from '../../src/agent/judge.js';
import { createStatusMcpServer } from '../../src/status-mcp/server.js';
import { JudgeSnapshotStatusProvider } from '../../src/status-mcp/provider.js';
import { publishJudgeSnapshot, readJudgeSnapshot } from '../../src/status-mcp/bridge.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

function fixture(): JudgeSnapshot {
  return {
    timestamp: 1000,
    functional: { timestamp: 1000, state: 'LIVE', mcpHealthy: true,
      symbols: ['BTC-USDT', 'ETH-USDT'], selectedSymbol: 'BTC-USDT', selectedOQS: 82,
      markets: { 'BTC-USDT': { close: 100, regime: 'TRENDING_UP', candidateAction: 'BUY',
        setupType: 'TREND_CONTINUATION', oqs: 82, edgeCostRatio: 3, spreadBps: 2,
        atrPctPercentile: 0.5, obiTop5: 0.1, micropriceLeanBps: 1, dataAgeMs: 100 },
      'ETH-USDT': { close: 200, regime: 'RANGE', candidateAction: 'HOLD',
        setupType: 'NONE', oqs: 25, edgeCostRatio: 1.2, spreadBps: 4,
        atrPctPercentile: 0.4, obiTop5: -0.1, micropriceLeanBps: -1, dataAgeMs: 120 } },
      llm: { status: 'SUCCESS', action: 'AGREE', riskFlag: 'LOW' },
      riskCertificate: { requestedSymbol: 'BTC-USDT', existingOpenPositionSymbols: [],
        gates: [{ name: 'SPREAD', status: 'PASS', reason: 'Passed' }], verdict: 'ALLOW',
        riskMode: 'NORMAL', calculatedNotional: 500, protectionPlan: null },
      openPositionSymbol: null, position: null,
      equity: { starting: 1000, current: 1010, peak: 1020, dailyPnl: 10,
        dailyReturnPct: 1, currentDrawdownPct: 0.98, maximumDrawdownPct: 2 },
      riskMode: 'NORMAL', degradedReason: null },
    reasoning: { selectedSymbol: 'BTC-USDT', perSymbolOqs: { 'BTC-USDT': 82, 'ETH-USDT': 25 },
      criticVerdict: 'AGREE', counterThesis: 'Momentum may fade',
      riskCertificate: { requestedSymbol: 'BTC-USDT', existingOpenPositionSymbols: [],
        gates: [{ name: 'SPREAD', status: 'PASS', reason: 'Passed' }], verdict: 'ALLOW',
        riskMode: 'NORMAL', calculatedNotional: 500, protectionPlan: null } },
    atk: { readLane: { status: 'READY', serverVersion: '1.4.6', profile: 'demo', readOnly: true, toolCount: 38 },
      writeLane: { status: 'READY', serverVersion: '1.4.6', profile: 'demo', tools: ['spot_place_order'] },
      uniqueToolsUsed: ['market_get_ticker'], recentTraces: [{ timestamp: 999, lane: 'READ',
        toolName: 'market_get_ticker', purpose: 'MARKET_TICKER', symbol: 'BTC-USDT', profile: 'demo',
        latencyMs: 3, success: true, errorCode: null, errorMessage: null, cycleId: 'cycle1', decisionId: null }],
      latestProvenance: { cycleId: 'cycle1', timestamp: 1000, selectedSymbol: 'BTC-USDT', result: 'SUBMITTED',
        nodes: [{ source: 'ATK_MCP', lane: 'READ', toolName: 'market_get_ticker', symbol: 'BTC-USDT',
          timestamp: 999, description: 'MARKET_TICKER', latencyMs: 3, success: true, result: 'OK' }] },
      recentDecisions: [{ cycleId: 'cycle1', timestamp: 1000, selectedSymbol: 'BTC-USDT', result: 'SUBMITTED',
        nodes: [], summary: { symbol: 'BTC-USDT', setupType: 'TREND_CONTINUATION', oqs: 82,
          selection: 'SELECTED', criticVerdict: 'AGREE', counterThesis: 'Momentum may fade',
          riskResult: 'ALLOW', primaryRejectionReason: null, executionResult: 'ACCEPTED',
          outcomeR: null, pnl: null } }],
      indicatorCrossChecks: [], crossMarket: null, contextPulse: null },
    safety: { liveArmed: false, riskMode: 'NORMAL', protectionMode: null,
      reconciliationPending: false, degradedReason: null },
  };
}

async function connect(snapshot: JudgeSnapshot) {
  const read = vi.fn(async () => snapshot);
  const provider = new JudgeSnapshotStatusProvider(read);
  const server = createStatusMcpServer(provider);
  const client = new Client({ name: 'aura-status-test', version: '1.0.0' });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { server, client, read };
}

describe('read-only AURA status MCP', () => {
  it('lists exactly four tools and projects existing JudgeSnapshot evidence for both symbols', async () => {
    const { server, client } = await connect(fixture());
    try {
      expect((await client.listTools()).tools.map(tool => tool.name).sort()).toEqual([
        'get_agent_state', 'get_market_snapshot', 'get_recent_decisions', 'get_risk_certificate']);
      const state = (await client.callTool({ name: 'get_agent_state', arguments: {} })).structuredContent;
      expect(state).toMatchObject({ agentState: 'LIVE', trackedSymbols: ['BTC-USDT', 'ETH-USDT'],
        selectedSymbol: 'BTC-USDT', mode: 'demo', atkReadLane: { status: 'READY', readOnly: true } });
      const risk = (await client.callTool({ name: 'get_risk_certificate', arguments: {} })).structuredContent;
      expect(risk).toMatchObject({ symbol: 'BTC-USDT', verdict: 'ALLOW', gates: [{ name: 'SPREAD', status: 'PASS' }] });
      const decisions = (await client.callTool({ name: 'get_recent_decisions', arguments: { limit: 1 } })).structuredContent;
      expect(decisions).toMatchObject({ decisions: [{ symbol: 'BTC-USDT', oqs: 82,
        counter_thesis: 'Momentum may fade', riskResult: 'ALLOW' }] });
      for (const [symbol, price] of [['BTC-USDT', 100], ['ETH-USDT', 200]] as const) {
        const market = (await client.callTool({ name: 'get_market_snapshot', arguments: { symbol } })).structuredContent;
        expect(market).toMatchObject({ markets: [{ symbol, price }], latestAtkSources: [{ toolName: 'market_get_ticker' }] });
      }
    } finally { await client.close(); await server.close(); }
  });

  it('bounds decision limit, rejects unknown authority, and never mutates the supplied snapshot', async () => {
    const snapshot = fixture();
    const before = JSON.stringify(snapshot);
    const { server, client, read } = await connect(snapshot);
    try {
      const tooMany = await client.callTool({ name: 'get_recent_decisions', arguments: { limit: 21 } });
      expect(tooMany.isError).toBe(true);
      const tooFew = await client.callTool({ name: 'get_recent_decisions', arguments: { limit: 0 } });
      expect(tooFew.isError).toBe(true);
      const invalidSymbol = await client.callTool({ name: 'get_market_snapshot', arguments: { symbol: 'DOGE-USDT' } });
      expect(invalidSymbol.isError).toBe(true);
      await expect(client.callTool({ name: 'place_order', arguments: { side: 'buy' } })).rejects.toThrow();
      expect(JSON.stringify(snapshot)).toBe(before);
      expect(read).toHaveBeenCalledTimes(1);
    } finally { await client.close(); await server.close(); }
  });

  it('accepts any selected liquid-universe symbol from the read-only snapshot', async () => {
    const snapshot = fixture();
    snapshot.functional.symbols = ['SOL-USDT'];
    snapshot.functional.markets = { 'SOL-USDT': { close: 150, regime: 'RANGE',
      candidateAction: 'HOLD', oqs: 25, edgeCostRatio: 1, spreadBps: 2,
      atrPctPercentile: 0.3 } };
    const { server, client } = await connect(snapshot);
    try {
      const result = (await client.callTool({ name: 'get_market_snapshot',
        arguments: { symbol: 'SOL-USDT' } })).structuredContent;
      expect(result).toMatchObject({ markets: [{ symbol: 'SOL-USDT', price: 150 }] });
    } finally { await client.close(); await server.close(); }
  });

  it('uses an atomic passive file bridge and redacts secrets before status exposure', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aura-status-'));
    directories.push(directory);
    const file = join(directory, 'status.json');
    expect(await readJudgeSnapshot(file)).toBeNull();
    const snapshot = fixture();
    (snapshot as unknown as { OPENAI_API_KEY: string }).OPENAI_API_KEY = 'secret-key';
    await publishJudgeSnapshot(file, snapshot);
    const restored = await readJudgeSnapshot(file);
    expect(restored?.functional.symbols).toEqual(['BTC-USDT', 'ETH-USDT']);
    expect(JSON.stringify(restored)).not.toContain('secret-key');
    expect((await new JudgeSnapshotStatusProvider(() => readJudgeSnapshot(file)).getAgentState()).agentState).toBe('LIVE');
  });

  it('includes an outcome in R from existing monitor decision memory when available', async () => {
    const snapshot = fixture();
    snapshot.atk.recentDecisionMemory = [{ symbol: 'ETH-USDT', setupType: 'DETERMINISTIC_EXIT',
      regime: 'RANGE', resultCategory: 'CLOSED', outcomeR: 1.2, stopHit: false, timestamp: 1001 }];
    const provider = new JudgeSnapshotStatusProvider(async () => snapshot);
    expect(await provider.getRecentDecisions(1)).toMatchObject({ decisions: [{ symbol: 'ETH-USDT',
      executionResult: 'CLOSED', outcomeR: 1.2 }] });
  });

  it('disconnects and reconnects clients without changing AURA state or importing trading services', async () => {
    const snapshot = fixture();
    const before = JSON.stringify(snapshot);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const { client, server } = await connect(snapshot);
      expect((await client.callTool({ name: 'get_agent_state', arguments: {} })).structuredContent)
        .toMatchObject({ selectedSymbol: 'BTC-USDT' });
      await client.close(); await server.close();
    }
    expect(JSON.stringify(snapshot)).toBe(before);
    const sources = await Promise.all(['server.ts', 'provider.ts', 'bridge.ts']
      .map(name => readFile(new URL(`../../src/status-mcp/${name}`, import.meta.url), 'utf8')));
    expect(sources.join('\n')).not.toMatch(/from ['"][^'"]*\/(?:okx|execution|llm|risk)\//);
    expect(sources.join('\n')).not.toContain('AtkWriteClient');
    expect(sources.join('\n')).not.toContain('ExecutionEngine');
  });
});

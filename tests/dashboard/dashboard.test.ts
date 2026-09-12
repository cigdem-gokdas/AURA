import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DashboardServer } from '../../src/dashboard/server.js';
import { publishJudgeSnapshot } from '../../src/status-mcp/bridge.js';
import { ReadOnlyExplainService } from '../../src/agent/judge.js';
import {
  derivePipeline,
  equityChart,
  marketRows,
  primaryRejection,
  recentDecisionRows,
  statusMcpTools,
  successfulMcpCalls,
} from '../../web/src/model.js';
import { fixture } from './fixture.js';
import {
  Ask,
  Chart,
  Critic,
  History,
  Markets,
  Mcp,
  Pipeline,
  Position,
  Risk,
  StatusMcp,
} from '../../web/src/main.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
async function setup(limit = 3) {
  const dir = await mkdtemp(join(tmpdir(), 'aura-dashboard-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const status = join(dir, 'status.json');
  const audit = join(dir, 'audit.jsonl');
  const server = new DashboardServer({
    statusPath: status,
    auditPath: audit,
    port: 0,
    pollMs: 25,
    historyLimit: limit,
    staticRoot: dir,
  });
  cleanup.push(() => server.close());
  return { dir, status, audit, server };
}
function next(ws: WebSocket): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Timed out waiting for frame')),
      2000,
    );
    ws.once('message', (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(String(data)));
    });
  });
}
async function connect(url: string): Promise<WebSocket> {
  const ws = new WebSocket(url);
  const first = next(ws);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  await first;
  cleanup.push(async () => {
    ws.terminate();
  });
  return ws;
}

async function eventually(
  check: () => boolean,
  refresh: () => Promise<void>,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    await refresh();
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Dashboard did not observe the expected status');
}

describe('read-only dashboard transport', () => {
  it('reads only a matching sanitized critic grade from the bounded audit tail', async () => {
    const { status, audit, server } = await setup();
    await publishJudgeSnapshot(status, fixture());
    await writeFile(
      audit,
      [
        JSON.stringify({
          eventType: 'MARKET_CRITIC_RESULT',
          cycleId: 'wrong',
          symbol: 'BTC-USDT',
          payload: { setupQuality: 'A' },
        }),
        JSON.stringify({
          eventType: 'MARKET_CRITIC_RESULT',
          cycleId: 'c1',
          symbol: 'BTC-USDT',
          payload: { setupQuality: 'B', apiKey: 'never-send' },
        }),
      ].join('\n') + '\n',
    );
    const { url } = await server.start();
    const body = await fetch(`${url}/api/state`).then((response) =>
      response.text(),
    );
    expect(JSON.parse(body).critic.setupQuality).toBe('B');
    expect(body).not.toContain('never-send');
  });
  it('binds 127.0.0.1, serves the latest snapshot immediately, and has no mutation endpoint', async () => {
    const { status, server } = await setup();
    await publishJudgeSnapshot(status, fixture());
    const endpoints = await server.start();
    expect(endpoints.url).toMatch(/^http:\/\/127\.0\.0\.1:/);
    expect(endpoints.websocketUrl).toMatch(/^ws:\/\/127\.0\.0\.1:/);
    const current = await fetch(`${endpoints.url}/api/state`).then((response) =>
      response.json(),
    );
    expect(current.snapshot.functional.selectedSymbol).toBe('BTC-USDT');
    const ws = new WebSocket(endpoints.websocketUrl);
    const first = next(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    cleanup.push(async () => {
      ws.terminate();
    });
    expect((await first).snapshot.timestamp).toBe(fixture().timestamp);
    expect(
      (await fetch(`${endpoints.url}/api/state`, { method: 'POST' })).status,
    ).toBe(405);
  });
  it('broadcasts subsequent snapshots to multiple clients and ignores disconnected clients', async () => {
    const { status, server } = await setup();
    await publishJudgeSnapshot(status, fixture());
    const { websocketUrl } = await server.start();
    const a = await connect(websocketUrl),
      b = await connect(websocketUrl);
    // Each connection receives initial data immediately; a new snapshot is then broadcast.
    const aNext = next(a),
      bNext = next(b);
    await publishJudgeSnapshot(status, fixture(fixture().timestamp + 1000));
    await server.refresh();
    expect((await aNext).snapshot.timestamp).toBe(fixture().timestamp + 1000);
    expect((await bNext).snapshot.timestamp).toBe(fixture().timestamp + 1000);
    a.terminate();
    await publishJudgeSnapshot(status, fixture(fixture().timestamp + 2000));
    const bNextAgain = next(b);
    await server.refresh();
    expect((await bNextAgain).snapshot.timestamp).toBe(
      fixture().timestamp + 2000,
    );
  });
  it('bounds real equity observations and marks the bridge offline without affecting the producer', async () => {
    const { status, server } = await setup(2);
    await publishJudgeSnapshot(status, fixture());
    await server.start();
    for (let i = 1; i <= 3; i++) {
      const s = fixture(fixture().timestamp + i * 1000);
      s.functional.equity!.current += i;
      await publishJudgeSnapshot(status, s);
      await eventually(
        () => server.current.snapshot?.timestamp === s.timestamp,
        () => server.refresh(),
      );
    }
    expect(server.current.equityHistory.map((p) => p.equity)).toEqual([
      10122, 10123,
    ]);
    expect(server.current.snapshot?.functional.equity?.current).toBe(10123);
    await rm(status);
    await eventually(
      () => server.current.bridgeStatus === 'OFFLINE',
      () => server.refresh(),
    );
    expect(server.current.bridgeStatus).toBe('OFFLINE');
    expect(server.current.snapshot?.functional.selectedSymbol).toBe('BTC-USDT');
  });
  it('redacts credential-like keys and values before any browser frame', async () => {
    const { status, server } = await setup();
    const unsafe = {
      ...fixture(),
      apiKey: 'key-secret',
      debug: 'Authorization: Bearer dangerous-secret',
    };
    await writeFile(status, JSON.stringify(unsafe));
    const { url } = await server.start();
    const body = await fetch(`${url}/api/state`).then((response) =>
      response.text(),
    );
    expect(body).not.toContain('key-secret');
    expect(body).not.toContain('dangerous-secret');
    expect(body).toContain('[REDACTED]');
  });
});

describe('rendered dashboard evidence and empty states', () => {
  const render = (component: React.ReactElement) =>
    renderToStaticMarkup(component);
  it('renders actual BTC/ETH values, selection, pipeline rejection and no write call', () => {
    const s = fixture();
    const markets = render(React.createElement(Markets, { s }));
    expect(markets).toContain('BTC-USDT');
    expect(markets).toContain('ETH-USDT');
    expect(markets).toContain('SELECTED OPPORTUNITY');
    const pipeline = render(React.createElement(Pipeline, { s }));
    expect(pipeline).toContain('REJECTED');
    expect(pipeline).toContain('NOT CALLED');
    s.functional.selectedSymbol = null;
    expect(render(React.createElement(Markets, { s }))).toContain(
      'NO ELIGIBLE OPPORTUNITY',
    );
    expect(render(React.createElement(Markets, { s: null }))).not.toContain(
      'NO ELIGIBLE OPPORTUNITY',
    );
  });
  it('renders critic verdict, counter-thesis, audited setup grade, and optional evidence', () => {
    const html = render(
      React.createElement(Critic, { s: fixture(), setupQuality: 'B' }),
    );
    expect(html).toContain('AGREE');
    expect(html).toContain('ETH microstructure is weakening');
    expect(html).toContain('Setup quality <b>B</b>');
    expect(html).toContain('MATCH');
    expect(html).toContain('AVAILABLE');
    expect(html).toContain('ACTIVE');
  });
  it('renders backend gate order and both risk verdicts', () => {
    const s = fixture();
    const reject = render(React.createElement(Risk, { s }));
    expect(reject.indexOf('CONFIG VALID')).toBeLessThan(
      reject.indexOf('SPREAD'),
    );
    expect(reject).toContain('ENTRY REJECTED');
    expect(reject).toContain('Spread too wide');
    s.reasoning.riskCertificate!.verdict = 'ALLOW';
    expect(render(React.createElement(Risk, { s }))).toContain('ENTRY ALLOWED');
  });
  it('renders actual trace/provenance and both MCP status labels', () => {
    const s = fixture();
    const data = {
      snapshot: s,
      equityHistory: [],
      critic: { setupQuality: 'B' as const },
      bridgeStatus: 'READY' as const,
      receivedAt: Date.now(),
    };
    const html = render(React.createElement(Mcp, { data }));
    expect(html).toContain('market_get_ticker');
    expect(html).toContain('ATK READ');
    expect(html).toContain('41');
    expect(html).toContain('REJECT');
    expect(html).toContain('NOT CALLED');
    expect(
      render(React.createElement(StatusMcp, { status: 'READY' })),
    ).toContain('get_agent_state');
    expect(
      render(React.createElement(StatusMcp, { status: 'OFFLINE' })),
    ).toContain('OFFLINE');
  });
  it('renders FLAT and LONG with exchange-side/client-side protection', () => {
    const s = fixture();
    expect(render(React.createElement(Position, { s: null }))).toContain(
      'POSITION STATE UNAVAILABLE',
    );
    expect(render(React.createElement(Position, { s }))).toContain(
      'NO OPEN POSITION',
    );
    s.functional.position = {
      symbol: 'ETH-USDT',
      quantity: 1.5,
      entryPrice: 3300,
      markPrice: 3400,
      stopPrice: 3200,
    };
    s.safety.protectionMode = 'EXCHANGE_SIDE';
    expect(render(React.createElement(Position, { s }))).toContain(
      'EXCHANGE-SIDE PROTECTED',
    );
    s.safety.protectionMode = 'CLIENT_SIDE';
    expect(render(React.createElement(Position, { s }))).toContain(
      'CLIENT-SIDE PROTECTION ACTIVE',
    );
  });
  it('renders equity empty state and read-only questions, plus recent rejection', () => {
    const s = fixture();
    expect(render(React.createElement(Chart, { s, points: [] }))).toContain(
      'WAITING FOR EQUITY HISTORY',
    );
    s.atk.recentDecisions = [s.atk.latestProvenance!];
    expect(render(React.createElement(History, { s }))).toContain(
      'Spread too wide',
    );
    const ask = render(React.createElement(Ask, { s }));
    expect(ask).toContain('What did the Market Critic challenge?');
    expect(ask).not.toContain('ARM LIVE');
  });
});

describe('read-only view models', () => {
  it('preserves BTC and ETH observations and selection; supports no eligible opportunity', () => {
    const s = fixture();
    expect(
      marketRows(s).map((x) => [x.symbol, x.market?.close, x.selected]),
    ).toEqual([
      ['BTC-USDT', 63000, true],
      ['ETH-USDT', 3400, false],
    ]);
    s.functional.selectedSymbol = null;
    expect(marketRows(s).every((x) => !x.selected)).toBe(true);
  });
  it('keeps actual equity points ordered, current point, peak and empty state', () => {
    const one = equityChart([], 10000);
    expect(one.points).toHaveLength(0);
    const chart = equityChart(
      [
        { timestamp: 3, equity: 10200, dailyPnl: 200, drawdownPct: 0, profile: 'demo' },
        { timestamp: 1, equity: 10000, dailyPnl: 0, drawdownPct: 0, profile: 'demo' },
        { timestamp: 2, equity: 10100, dailyPnl: 100, drawdownPct: 0, profile: 'demo' },
      ],
      10000,
    );
    expect(chart.points.map((x) => x.timestamp)).toEqual([1, 2, 3]);
    expect(chart.points.at(-1)?.equity).toBe(10200);
    expect(chart.peakIndex).toBe(2);
  });
  it('derives waiting, active, passed, rejected, failed and skipped without inventing execution', () => {
    expect(derivePipeline(null).every((x) => x.status === 'WAITING')).toBe(
      true,
    );
    const s = fixture();
    s.atk.latestProvenance = null;
    s.functional.state = 'PREFLIGHT';
    expect(derivePipeline(s)[0]?.status).toBe('ACTIVE');
    s.functional.state = 'LIVE';
    s.atk.latestProvenance = fixture().atk.latestProvenance;
    s.reasoning.riskCertificate = s.functional.riskCertificate;
    let stages = derivePipeline(s);
    expect(stages.find((x) => x.name === 'MARKET')?.status).toBe('PASSED');
    expect(stages.find((x) => x.name === 'RISK')?.status).toBe('REJECTED');
    expect(stages.find((x) => x.name === 'EXECUTION')).toMatchObject({
      status: 'SKIPPED',
      detail: 'NOT CALLED',
    });
    s.atk.latestProvenance!.nodes[0]!.success = false;
    stages = derivePipeline(s);
    expect(stages[0]?.status).toBe('FAILED');
  });
  it('preserves ordered backend gates and final result without recalculating risk', () => {
    const s = fixture();
    s.reasoning.riskCertificate = s.functional.riskCertificate;
    expect(s.reasoning.riskCertificate?.gates.map((x) => x.name)).toEqual([
      'CONFIG_VALID',
      'SPREAD',
    ]);
    expect(primaryRejection(s)).toBe('Spread too wide');
    expect(s.reasoning.riskCertificate?.verdict).toBe('REJECT');
    s.reasoning.riskCertificate!.verdict = 'ALLOW';
    expect(s.reasoning.riskCertificate?.verdict).toBe('ALLOW');
  });
  it('preserves actual MCP names, lanes, latency, provenance, and health', () => {
    const s = fixture();
    expect(s.atk.recentTraces[0]).toMatchObject({
      lane: 'READ',
      toolName: 'market_get_ticker',
      latencyMs: 41,
      success: true,
    });
    expect(s.atk.latestProvenance?.nodes[0]?.toolName).toBe(
      'market_get_ticker',
    );
    expect(s.atk.readLane?.readOnly).toBe(true);
    expect(successfulMcpCalls(s)).toBe(1);
    expect(statusMcpTools).toEqual([
      'get_agent_state',
      'get_risk_certificate',
      'get_recent_decisions',
      'get_market_snapshot',
    ]);
  });
  it('filters decisions locally and answers only read-only questions', () => {
    const s = fixture();
    s.atk.recentDecisions = [s.atk.latestProvenance!];
    expect(recentDecisionRows(s, 'REJECTED')).toHaveLength(1);
    expect(recentDecisionRows(s, 'EXECUTED')).toHaveLength(0);
    const service = new ReadOnlyExplainService(() => s);
    expect(service.explainCurrentState('WHY_REJECTED').text).toContain(
      'SPREAD',
    );
    expect(service.explainCurrentState('MCP_EVIDENCE').text).toContain('READ');
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(service))).toEqual([
      'constructor',
      'explainCurrentState',
    ]);
  });
});

import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from 'node:http';
import { open, readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import { readJudgeSnapshot } from '../status-mcp/bridge.js';
import { redactAudit } from '../memory/audit.js';
import type { JudgeSnapshot } from '../agent/judge.js';
import type { DashboardState, EquityPoint } from './types.js';

export interface DashboardServerOptions {
  statusPath?: string;
  auditPath?: string;
  staticRoot?: string;
  port?: number;
  pollMs?: number;
  historyLimit?: number;
  allowedHosts?: string;
}

const defaultStaticRoot = fileURLToPath(
  new URL('../../web/dist/', import.meta.url),
);
const contentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function parseAllowedHosts(value: string): ReadonlySet<string> {
  const hosts = value.split(',').map(host => host.trim().toLowerCase());
  if (hosts.some(host => host.length > 253 || host.split('.').some(label =>
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))))
    throw new RangeError('Invalid dashboard allowed host');
  return new Set(hosts);
}

function allowedHost(request: IncomingMessage, hosts: ReadonlySet<string>): boolean {
  const hostname = request.headers.host?.match(/^([a-z0-9.-]+)(?::\d{1,5})?$/i)?.[1];
  return !!hostname && hosts.has(hostname.toLowerCase());
}

function allowedOrigin(request: IncomingMessage, hosts: ReadonlySet<string>): boolean {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    const url = new URL(origin);
    return hosts.has(url.hostname.toLowerCase()) &&
      (url.protocol === 'http:' || url.protocol === 'https:');
  } catch {
    return false;
  }
}

/** Read-only transport: no trading client, execution engine, or agent reference. */
export class DashboardServer {
  private readonly http: HttpServer;
  private readonly sockets = new WebSocketServer({ noServer: true });
  private readonly statusPath: string;
  private readonly auditPath: string;
  private readonly staticRoot: string;
  private readonly pollMs: number;
  private readonly historyLimit: number;
  private readonly allowedHosts: ReadonlySet<string>;
  private interval: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private fingerprint = '';
  private state: DashboardState = {
    snapshot: null,
    equityHistory: [],
    critic: { setupQuality: null },
    lockdownAuditConfirmed: false,
    bridgeStatus: 'OFFLINE',
    receivedAt: null,
  };

  constructor(private readonly options: DashboardServerOptions = {}) {
    this.statusPath = options.statusPath ?? '.aura/status.json';
    this.auditPath = options.auditPath ?? '.aura/audit.jsonl';
    this.staticRoot = resolve(options.staticRoot ?? defaultStaticRoot);
    this.pollMs = options.pollMs ?? 1_000;
    this.historyLimit = options.historyLimit ?? 360;
    this.allowedHosts = parseAllowedHosts(options.allowedHosts ?? 'localhost,127.0.0.1');
    if (!Number.isSafeInteger(this.pollMs) || this.pollMs < 10)
      throw new RangeError('Invalid poll interval');
    if (
      !Number.isSafeInteger(this.historyLimit) ||
      this.historyLimit < 1 ||
      this.historyLimit > 10_000
    )
      throw new RangeError('Invalid history limit');
    this.http = createServer((request, response) => {
      if (!allowedHost(request, this.allowedHosts)) {
        response.writeHead(403).end();
        return;
      }
      if (request.method !== 'GET') {
        response.writeHead(405).end();
        return;
      }
      if (request.url === '/api/state') {
        response.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        });
        response.end(JSON.stringify(this.state));
        return;
      }
      void this.serveStatic(request.url ?? '/', response);
    });
    this.http.on('upgrade', (request, socket, head) => {
      if (
        request.url !== '/stream' ||
        !allowedHost(request, this.allowedHosts) ||
        !allowedOrigin(request, this.allowedHosts)
      ) {
        socket.destroy();
        return;
      }
      this.sockets.handleUpgrade(request, socket, head, (client) =>
        this.sockets.emit('connection', client, request),
      );
    });
    this.sockets.on('connection', (client) => {
      try {
        client.send(JSON.stringify(this.state));
      } catch {
        client.terminate();
      }
    });
  }

  get current(): DashboardState {
    return this.state;
  }

  async start(): Promise<{ url: string; websocketUrl: string }> {
    await this.refresh();
    await new Promise<void>((yes, no) => {
      this.http.once('error', no);
      this.http.listen(this.options.port ?? 8787, '127.0.0.1', () => {
        this.http.off('error', no);
        yes();
      });
    });
    this.interval = setInterval(() => {
      void this.refresh();
    }, this.pollMs);
    this.interval.unref();
    const address = this.http.address();
    if (!address || typeof address === 'string')
      throw new Error('Dashboard bind failed');
    return {
      url: `http://127.0.0.1:${address.port}`,
      websocketUrl: `ws://127.0.0.1:${address.port}/stream`,
    };
  }

  async refresh(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const raw = await readJudgeSnapshot(this.statusPath);
      if (!raw) {
        if (this.state.bridgeStatus !== 'OFFLINE') {
          this.state = { ...this.state, bridgeStatus: 'OFFLINE' };
          this.broadcast();
        }
        return;
      }
      const snapshot = redactAudit(raw) as JudgeSnapshot;
      const critic = { setupQuality: await this.latestSetupQuality(snapshot) };
      const lockdownAuditConfirmed = await this.lockdownEvidence(snapshot);
      const fingerprint = JSON.stringify([snapshot, critic, lockdownAuditConfirmed]);
      if (
        fingerprint === this.fingerprint &&
        this.state.bridgeStatus === 'READY'
      )
        return;
      if (fingerprint !== this.fingerprint) {
        const equity = snapshot.functional.equity;
        const rawProfile = snapshot.atk.readLane?.profile ?? snapshot.atk.writeLane?.profile ?? null;
        const profile: 'demo' | 'live' | null =
          rawProfile === 'demo' || rawProfile === 'live' ? rawProfile : null;
        // Demo and live are different accounts with unrelated equity scales; a profile
        // switch (or an old in-memory history from before a restart) must never let a
        // prior profile's points render alongside the currently active one.
        const history = this.state.equityHistory.filter((point) => point.profile === profile);
        if (
          equity &&
          Number.isFinite(equity.current) &&
          Number.isFinite(snapshot.timestamp) &&
          history.at(-1)?.timestamp !== snapshot.timestamp
        ) {
          history.push({
            timestamp: snapshot.timestamp,
            equity: equity.current,
            dailyPnl: equity.dailyPnl,
            drawdownPct: equity.currentDrawdownPct,
            profile,
          } satisfies EquityPoint);
        }
        this.state = {
          snapshot,
          equityHistory: history.slice(-this.historyLimit),
          critic,
          lockdownAuditConfirmed,
          bridgeStatus: 'READY',
          receivedAt: Date.now(),
        };
      } else
        this.state = {
          ...this.state,
          bridgeStatus: 'READY',
          receivedAt: Date.now(),
        };
      this.fingerprint = fingerprint;
      this.broadcast();
    } catch {
      if (this.state.bridgeStatus !== 'OFFLINE') {
        this.state = { ...this.state, bridgeStatus: 'OFFLINE' };
        this.broadcast();
      }
    } finally {
      this.busy = false;
    }
  }

  /** Reads one bounded audit tail and accepts only a matching, whitelisted grade. */
  private async latestSetupQuality(
    snapshot: JudgeSnapshot,
  ): Promise<'A' | 'B' | 'C' | 'D' | null> {
    const cycleId = snapshot.atk.latestProvenance?.cycleId;
    const symbol = snapshot.functional.selectedSymbol;
    if (!cycleId || !symbol) return null;
    let file: Awaited<ReturnType<typeof open>>;
    try {
      file = await open(this.auditPath, 'r');
    } catch {
      return null;
    }
    try {
      const size = (await file.stat()).size;
      const length = Math.min(size, 131_072);
      if (!length) return null;
      const bytes = Buffer.alloc(length);
      await file.read(bytes, 0, length, size - length);
      const tail = bytes.toString('utf8');
      const complete =
        size > length ? tail.slice(tail.indexOf('\n') + 1) : tail;
      for (const line of complete.trim().split('\n').reverse()) {
        try {
          const event = JSON.parse(line) as Record<string, unknown>;
          if (
            event.eventType !== 'MARKET_CRITIC_RESULT' ||
            event.cycleId !== cycleId ||
            event.symbol !== symbol
          )
            continue;
          const grade = (event.payload as Record<string, unknown> | null)
            ?.setupQuality;
          return grade === 'A' ||
            grade === 'B' ||
            grade === 'C' ||
            grade === 'D'
            ? grade
            : null;
        } catch {
          /* Ignore partial or unrelated audit lines. */
        }
      }
      return null;
    } catch {
      return null; // Optional audit enrichment cannot take the snapshot bridge offline.
    } finally {
      await file.close().catch(() => undefined);
    }
  }

  private async lockdownEvidence(snapshot: JudgeSnapshot): Promise<boolean> {
    if (snapshot.safety.riskMode !== 'LOCKDOWN') return false;
    const cycleId = snapshot.atk.latestProvenance?.cycleId;
    if (!cycleId) return false;
    let file: Awaited<ReturnType<typeof open>>;
    try { file = await open(this.auditPath, 'r'); } catch { return false; }
    try {
      const size = (await file.stat()).size;
      const length = Math.min(size, 131_072);
      if (!length) return false;
      const bytes = Buffer.alloc(length);
      await file.read(bytes, 0, length, size - length);
      const tail = bytes.toString('utf8');
      const complete = size > length ? tail.slice(tail.indexOf('\n') + 1) : tail;
      for (const line of complete.trim().split('\n').reverse()) {
        try {
          const event = JSON.parse(line) as Record<string, unknown>;
          if (event.eventType === 'LOCKDOWN' && event.cycleId === cycleId
            && typeof event.timestamp === 'number' && event.timestamp <= snapshot.timestamp)
            return true;
        } catch { /* Ignore incomplete or unrelated audit lines. */ }
      }
      return false;
    } catch { return false; } finally { await file.close().catch(() => undefined); }
  }

  private broadcast(): void {
    const body = JSON.stringify(this.state);
    for (const client of this.sockets.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      if (client.bufferedAmount > 1_048_576) {
        client.terminate();
        continue;
      }
      try {
        client.send(body);
      } catch {
        client.terminate();
      }
    }
  }

  private async serveStatic(
    pathname: string,
    response: ServerResponse,
  ): Promise<void> {
    let requested: string;
    try {
      requested = decodeURIComponent(
        new URL(pathname, 'http://127.0.0.1').pathname,
      );
    } catch {
      response.writeHead(400).end();
      return;
    }
    const file = resolve(
      this.staticRoot,
      `.${requested === '/' ? '/index.html' : requested}`,
    );
    if (file !== this.staticRoot && !file.startsWith(this.staticRoot + sep)) {
      response.writeHead(403).end();
      return;
    }
    try {
      const body = await readFile(file);
      response.writeHead(200, {
        'content-type':
          contentTypes[extname(file)] ?? 'application/octet-stream',
        'x-content-type-options': 'nosniff',
        'cache-control': 'no-store',
      });
      response.end(body);
    } catch {
      response
        .writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        .end('Dashboard build unavailable');
    }
  }

  async close(): Promise<void> {
    if (this.interval) clearInterval(this.interval);
    for (const client of this.sockets.clients) client.terminate();
    this.sockets.close();
    if (this.http.listening)
      await new Promise<void>((resolveClose) =>
        this.http.close(() => resolveClose()),
      );
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const server = new DashboardServer({
    ...(process.env.AURA_STATUS_SNAPSHOT_PATH
      ? { statusPath: process.env.AURA_STATUS_SNAPSHOT_PATH }
      : {}),
    ...(process.env.AURA_AUDIT_PATH
      ? { auditPath: process.env.AURA_AUDIT_PATH }
      : {}),
    ...(process.env.AURA_DASHBOARD_PORT
      ? { port: Number(process.env.AURA_DASHBOARD_PORT) }
      : {}),
    ...(process.env.AURA_DASHBOARD_ALLOWED_HOSTS
      ? { allowedHosts: process.env.AURA_DASHBOARD_ALLOWED_HOSTS }
      : {}),
  });
  server
    .start()
    .then(({ url, websocketUrl }) => {
      process.stdout.write(
        `AURA dashboard: ${url}\nAURA dashboard stream: ${websocketUrl}\n`,
      );
    })
    .catch((error) => {
      process.stderr.write(`Dashboard failed: ${String(error)}\n`);
      process.exitCode = 1;
    });
}

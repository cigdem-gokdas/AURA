import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ReadOnlyExplainService,
  type ExplainIntent,
  type JudgeSnapshot,
} from '../../src/agent/judge.js';
import type { DashboardState, EquityPoint } from '../../src/dashboard/types.js';
import {
  derivePipeline,
  equityChart,
  marketRows,
  primaryRejection,
  recentDecisionRows,
  statusMcpTools,
  successfulMcpCalls,
  validateWireState,
} from './model.js';
import './styles.css';

const empty: DashboardState = {
  snapshot: null,
  equityHistory: [],
  critic: { setupQuality: null },
  bridgeStatus: 'OFFLINE',
  receivedAt: null,
};
const money = (v: number | null | undefined, digits = 2) =>
  v == null || !Number.isFinite(v)
    ? '—'
    : new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      }).format(v);
const num = (v: number | null | undefined, digits = 2) =>
  v == null || !Number.isFinite(v)
    ? '—'
    : new Intl.NumberFormat('en-US', { maximumFractionDigits: digits }).format(
        v,
      );
const pct = (v: number | null | undefined) =>
  v == null || !Number.isFinite(v) ? '—' : `${num(v)}%`;
const label = (v: string | null | undefined) =>
  v ? v.replaceAll('_', ' ') : '—';
const when = (v: number | null | undefined) =>
  v == null || !Number.isFinite(v)
    ? '—'
    : new Date(v).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });

function useDashboard() {
  const [data, setData] = useState<DashboardState>(empty);
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    let alive = true,
      socket: WebSocket | null = null,
      retry: ReturnType<typeof setTimeout> | null = null;
    const port = import.meta.env.DEV
      ? ':8787'
      : window.location.port
        ? `:${window.location.port}`
        : '';
    const url = `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.hostname}${port}/stream`;
    const connect = () => {
      socket = new WebSocket(url);
      socket.onopen = () => {
        if (alive) setConnected(true);
      };
      socket.onmessage = (event) => {
        try {
          const parsed: unknown = JSON.parse(String(event.data));
          if (alive && validateWireState(parsed)) setData(parsed);
        } catch {
          /* ignore malformed frames */
        }
      };
      socket.onclose = () => {
        if (alive) {
          setConnected(false);
          retry = setTimeout(connect, 2000);
        }
      };
      socket.onerror = () => socket?.close();
    };
    connect();
    return () => {
      alive = false;
      if (retry) clearTimeout(retry);
      socket?.close();
    };
  }, []);
  return { data, connected };
}

function Pill({
  children,
  tone = 'neutral',
}: {
  children: React.ReactNode;
  tone?: string;
}) {
  return (
    <span className={`pill ${tone}`}>
      <i />
      {children}
    </span>
  );
}
function Heading({
  eyebrow,
  title,
  aside,
  id,
}: {
  eyebrow: string;
  title: string;
  aside?: string;
  id?: string;
}) {
  return (
    <div id={id} className="heading">
      <div>
        <span className="eyebrow">{eyebrow}</span>
        <h2>{title}</h2>
      </div>
      {aside && <p>{aside}</p>}
    </div>
  );
}
function CardMetric({
  name,
  value,
  note,
  tone = '',
}: {
  name: string;
  value: string;
  note: string;
  tone?: string;
}) {
  return (
    <article className={`metric ${tone}`}>
      <span>{name}</span>
      <strong>{value}</strong>
      <small>{note}</small>
    </article>
  );
}
function Banner({ s }: { s: JudgeSnapshot | null }) {
  if (!s)
    return (
      <div className="banner observe">
        <strong>WAITING FOR AURA</strong>
        <span>The dashboard is ready for a read-only status snapshot.</span>
      </div>
    );
  if (s.safety.reconciliationPending)
    return (
      <div className="banner danger">
        <strong>ORDER STATE UNCERTAIN</strong>
        <span>New entries blocked · Reconciling through ATK MCP</span>
      </div>
    );
  if (s.functional.state === 'HALTED' || s.safety.riskMode === 'LOCKDOWN')
    return (
      <div className="banner danger">
        <strong>RISK LOCKDOWN</strong>
        <span>New entries disabled · Position protection active</span>
      </div>
    );
  if (s.functional.state === 'DEGRADED')
    return (
      <div className="banner warning">
        <strong>DEGRADED MODE</strong>
        <span>New entries disabled · Position protection active</span>
      </div>
    );
  if (
    s.functional.state === 'OBSERVE_ONLY' ||
    s.functional.state === 'PREFLIGHT'
  )
    return (
      <div className="banner observe">
        <strong>OBSERVE ONLY</strong>
        <span>Live execution disabled</span>
      </div>
    );
  return null;
}

export function Chart({
  points,
  s,
}: {
  points: readonly EquityPoint[];
  s: JudgeSnapshot | null;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const equity = s?.functional.equity;
  const data = useMemo(
    () => equityChart(points, equity?.starting ?? null),
    [points, equity?.starting],
  );
  const W = 850,
    H = 250,
    L = 60,
    R = 18,
    T = 16,
    B = 35;
  const x = (i: number) =>
    L +
    (data.points.length < 2 ? 0.5 : i / (data.points.length - 1)) * (W - L - R);
  const y = (v: number) =>
    T + ((data.max - v) / (data.max - data.min)) * (H - T - B);
  const path = data.points
    .map(
      (p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.equity).toFixed(1)}`,
    )
    .join(' ');
  const active = hover === null ? null : data.points[hover];
  return (
    <article id="performance" className="card chart-card">
      <div className="chart-header">
        <div>
          <span className="eyebrow">PERFORMANCE</span>
          <h2>Equity, over time</h2>
          <p>Actual observations from AURA's read-only status stream.</p>
        </div>
        <div className="chart-value">
          <span>Current equity</span>
          <strong>{money(equity?.current)}</strong>
          <small>Peak equity {money(equity?.peak)}</small>
        </div>
      </div>
      {data.points.length ? (
        <div className="chart-wrap">
          <svg
            viewBox={`0 0 ${W} ${H}`}
            role="img"
            aria-label={`Equity history, ${data.points.length} actual observations`}
            onMouseLeave={() => setHover(null)}
            onMouseMove={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              const px = ((event.clientX - rect.left) / rect.width) * W;
              setHover(
                data.points.reduce(
                  (best, _p, i) =>
                    Math.abs(x(i) - px) < Math.abs(x(best) - px) ? i : best,
                  0,
                ),
              );
            }}
          >
            {[0, 1, 2, 3].map((i) => {
              const value = data.min + ((data.max - data.min) * i) / 3;
              return (
                <g key={i}>
                  <line
                    className="gridline"
                    x1={L}
                    x2={W - R}
                    y1={y(value)}
                    y2={y(value)}
                  />
                  <text
                    className="axis"
                    x={L - 8}
                    y={y(value) + 4}
                    textAnchor="end"
                  >
                    {money(value, 0)}
                  </text>
                </g>
              );
            })}
            {data.starting !== null && (
              <g>
                <line
                  className="baseline"
                  x1={L}
                  x2={W - R}
                  y1={y(data.starting)}
                  y2={y(data.starting)}
                />
                <text
                  className="axis"
                  x={W - R}
                  y={y(data.starting) - 6}
                  textAnchor="end"
                >
                  Starting equity
                </text>
              </g>
            )}
            {data.points.length > 1 && (
              <path className="equity-line" d={path} fill="none" />
            )}
            {data.points.map(
              (p, i) =>
                (i === 0 ||
                  i === data.points.length - 1 ||
                  i === data.peakIndex ||
                  i === hover) && (
                  <circle
                    key={`${p.timestamp}-${i}`}
                    className={
                      i === data.peakIndex ? 'peak-point' : 'chart-point'
                    }
                    cx={x(i)}
                    cy={y(p.equity)}
                    r={i === hover ? 7 : 4.5}
                  />
                ),
            )}
            <text className="axis" x={L} y={H - 8}>
              First · {when(data.points[0]?.timestamp)}
            </text>
            <text className="axis" x={W - R} y={H - 8} textAnchor="end">
              Latest · {when(data.points.at(-1)?.timestamp)}
            </text>
          </svg>
          {active && (
            <div className="tooltip">
              <strong>{money(active.equity)}</strong>
              <span>{when(active.timestamp)}</span>
              <span>Daily PnL {money(active.dailyPnl)}</span>
              <span>Drawdown {pct(active.drawdownPct)}</span>
            </div>
          )}
        </div>
      ) : (
        <div className="chart-empty">
          <div className="empty-curve" />
          <strong>WAITING FOR EQUITY HISTORY</strong>
          <p>
            The curve begins with the first real observation. No sample values
            are shown.
          </p>
        </div>
      )}
      <div className="chart-footer">
        <span>
          <i className="line-key" /> Recorded equity
        </span>
        <span>
          <i className="dash-key" /> Starting equity {money(equity?.starting)}
        </span>
        <span>
          Observed peak{' '}
          {data.peakIndex === null
            ? '—'
            : money(data.points[data.peakIndex]?.equity)}
        </span>
      </div>
    </article>
  );
}

export function Markets({ s }: { s: JudgeSnapshot | null }) {
  return (
    <section className="section" id="markets">
      <Heading
        eyebrow="THE LIQUID UNIVERSE"
        title="One risk budget. Two opportunities."
        aside="AURA compares BTC and ETH, then allocates its single risk budget to the strongest eligible setup."
      />
      {s && !s.functional.selectedSymbol && (
        <div className="notice">
          <strong>NO ELIGIBLE OPPORTUNITY</strong>
          <span>{primaryRejection(s) ?? 'Awaiting a qualifying setup.'}</span>
        </div>
      )}
      <div className="market-grid">
        {marketRows(s).map(({ symbol, market, selected }) => (
          <article
            className={`card market ${selected ? 'selected' : ''}`}
            key={symbol}
          >
            <div className="market-head">
              <div>
                <span className="eyebrow">SPOT MARKET</span>
                <h3>{symbol}</h3>
              </div>
              <Pill tone={selected ? 'good' : 'neutral'}>
                {selected
                  ? 'SELECTED OPPORTUNITY'
                  : market
                    ? 'UNDER REVIEW'
                    : 'WAITING'}
              </Pill>
            </div>
            <div className="market-price">
              {money(market?.close)}
              <small>{label(market?.regime)} regime</small>
            </div>
            <div className="market-setup">
              <span>Candidate / setup</span>
              <strong>
                {label(market?.candidateAction)}
                {market?.setupType ? ` · ${label(market.setupType)}` : ''}
              </strong>
            </div>
            <div className="market-facts">
              <div>
                <span>OQS</span>
                <strong>{num(market?.oqs, 0)}</strong>
              </div>
              <div>
                <span>Edge / cost</span>
                <strong>{num(market?.edgeCostRatio)}×</strong>
              </div>
              <div>
                <span>Spread</span>
                <strong>{num(market?.spreadBps)} bps</strong>
              </div>
              <div>
                <span>Top-5 OBI</span>
                <strong>{num(market?.obiTop5, 3)}</strong>
              </div>
              <div>
                <span>Microprice lean</span>
                <strong>{num(market?.micropriceLeanBps)} bps</strong>
              </div>
              <div>
                <span>Freshness</span>
                <strong>
                  {market?.dataAgeMs == null
                    ? '—'
                    : `${num(market.dataAgeMs, 0)} ms`}
                </strong>
              </div>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

export function Pipeline({ s }: { s: JudgeSnapshot | null }) {
  return (
    <section className="section" id="decision">
      <Heading
        eyebrow="CURRENT DECISION"
        title="From evidence to action"
        aside="Every stage reflects the latest published decision path."
      />
      <div className="pipeline">
        {derivePipeline(s).map((stage, i) => (
          <div
            className={`stage ${stage.status.toLowerCase()}`}
            key={stage.name}
          >
            <b>{String(i + 1).padStart(2, '0')}</b>
            <div>
              <span>{stage.name}</span>
              <strong>{stage.status}</strong>
              <small>{stage.detail}</small>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

export function Critic({
  s,
  setupQuality,
}: {
  s: JudgeSnapshot | null;
  setupQuality: string | null;
}) {
  const symbol = s?.functional.selectedSymbol;
  const market = symbol ? s?.functional.markets[symbol] : null;
  const checks = s?.atk.indicatorCrossChecks ?? [];
  const check = !checks.length
    ? 'UNAVAILABLE'
    : checks.some((x) => x.status.includes('DIVERGENCE'))
      ? 'DIVERGENCE'
      : checks.every((x) => x.status === 'MATCH')
        ? 'MATCH'
        : 'UNAVAILABLE';
  return (
    <article className="card critic">
      <div className="panel-head">
        <div>
          <span className="eyebrow">SECOND OPINION</span>
          <h2>Market Critic</h2>
        </div>
        <Pill tone={s?.reasoning.criticVerdict === 'AGREE' ? 'good' : 'warn'}>
          {s?.reasoning.criticVerdict ?? 'AWAITING REVIEW'}
        </Pill>
      </div>
      <div className="thesis">
        <span>AURA THESIS</span>
        <strong>{symbol ?? 'No selected setup yet'}</strong>
        <p>
          {market?.setupType
            ? label(market.setupType)
            : 'A candidate must pass deterministic selection first.'}
          {market ? ` · OQS ${num(market.oqs, 0)}` : ''}
        </p>
      </div>
      <div className="counter">
        <span>COUNTER-THESIS</span>
        <blockquote>
          {s?.reasoning.counterThesis ??
            'The Market Critic has not published a counter-thesis yet.'}
        </blockquote>
      </div>
      <div className="critic-details">
        <span>
          Risk flag <b>{label(s?.functional.llm?.riskFlag)}</b>
        </span>
        <span>
          Setup quality{' '}
          <b>{s?.functional.llm?.setupQuality ?? setupQuality ?? '—'}</b>
        </span>
        <span>
          Confidence{' '}
          <b>
            {s?.functional.llm?.confidence == null
              ? '—'
              : pct(s.functional.llm.confidence * 100)}
          </b>
        </span>
        <span>
          Regime confirmation{' '}
          <b>{label(s?.functional.llm?.regimeConfirmation)}</b>
        </span>
        <span className="critic-reason">
          Short reason <b>{s?.functional.llm?.reason ?? '—'}</b>
        </span>
      </div>
      <div className="evidence">
        <span>
          ATK indicator check <b>{check}</b>
        </span>
        <span>
          Cross-market <b>{s?.atk.crossMarket?.status ?? 'UNAVAILABLE'}</b>
        </span>
        <span>
          Context Pulse <b>{s?.atk.contextPulse ? 'ACTIVE' : 'OFF'}</b>
        </span>
      </div>
    </article>
  );
}
export function Risk({ s }: { s: JudgeSnapshot | null }) {
  const cert = s?.reasoning.riskCertificate;
  return (
    <article id="risk" className="card risk">
      <div className="panel-head">
        <div>
          <span className="eyebrow">HARD INVARIANTS</span>
          <h2>Pre-trade risk certificate</h2>
        </div>
        <span className="mono muted">
          {cert?.requestedSymbol ?? 'NO PROPOSAL'}
        </span>
      </div>
      <div className={`risk-result ${cert?.verdict?.toLowerCase() ?? ''}`}>
        <span>FINAL RESULT</span>
        <strong>
          {cert
            ? cert.verdict === 'ALLOW'
              ? 'ENTRY ALLOWED'
              : 'ENTRY REJECTED'
            : 'AWAITING CERTIFICATE'}
        </strong>
        <p>
          {cert?.verdict === 'REJECT'
            ? `Primary reason · ${primaryRejection(s) ?? 'Risk gate failed'}`
            : cert?.verdict === 'ALLOW'
              ? 'Every published hard gate passed.'
              : 'The next completed risk decision appears here.'}
        </p>
      </div>
      <div className="gates">
        {cert?.gates.length ? (
          cert.gates.map((gate, i) => (
            <div className="gate" key={`${gate.name}-${i}`}>
              <span>{String(i + 1).padStart(2, '0')}</span>
              <b className={gate.status === 'PASS' ? 'pass-text' : 'fail-text'}>
                {gate.status === 'PASS' ? '✓' : '!'} {gate.status}
              </b>
              <div>
                <strong>{label(gate.name)}</strong>
                <small>{gate.reason}</small>
              </div>
            </div>
          ))
        ) : (
          <div className="empty-small">
            No risk certificate has been published.
          </div>
        )}
      </div>
    </article>
  );
}
export function Mcp({ data }: { data: DashboardState }) {
  const s = data.snapshot;
  const traces = [...(s?.atk.recentTraces ?? [])].reverse().slice(0, 18);
  const path = s?.atk.latestProvenance;
  return (
    <section className="section" id="mcp">
      <Heading
        eyebrow="INTEGRATION EVIDENCE"
        title="ATK MCP, in the open"
        aside="Actual read and write tool calls, plus the causal path of the latest decision."
      />
      <div className="card health">
        <div>
          <span className="eyebrow">MCP INTEGRATION HEALTH</span>
          <h3>Independent lanes</h3>
          <p>
            Server version{' '}
            {s?.atk.readLane?.serverVersion ??
              s?.atk.writeLane?.serverVersion ??
              '—'}
          </p>
        </div>
        <div>
          <span>READ LANE</span>
          <strong>{s?.atk.readLane?.status ?? 'UNKNOWN'}</strong>
          <small>
            {s?.atk.readLane?.readOnly
              ? 'SERVER-LEVEL READ ONLY'
              : 'Read-only status unconfirmed'}
          </small>
        </div>
        <div>
          <span>WRITE LANE</span>
          <strong>{s?.atk.writeLane?.status ?? 'UNKNOWN'}</strong>
          <small>
            {s?.atk.writeLane?.profile
              ? `${s.atk.writeLane.profile.toUpperCase()} profile`
              : 'No profile'}
          </small>
        </div>
        <div>
          <span>TOOLS USED</span>
          <strong>{s?.atk.uniqueToolsUsed.length ?? 0}</strong>
          <small>{successfulMcpCalls(s)} successful recent calls</small>
        </div>
        <div>
          <span>STATUS MCP</span>
          <strong>{data.bridgeStatus}</strong>
          <small>
            Snapshot{' '}
            {data.bridgeStatus === 'READY' ? 'available' : 'unavailable'}
          </small>
        </div>
      </div>
      <div className="mcp-grid">
        <article className="card trace-card">
          <div className="panel-head">
            <div>
              <span className="eyebrow">RECENT MCP CALLS</span>
              <h3>ATK MCP live trace</h3>
            </div>
            <span className="muted">{traces.length} shown</span>
          </div>
          {traces.length ? (
            <div className="traces">
              {traces.map((t, i) => (
                <div
                  className="trace"
                  key={`${t.timestamp}-${t.toolName}-${i}`}
                >
                  <Pill tone={t.lane === 'READ' ? 'info' : 'warn'}>
                    {t.lane}
                  </Pill>
                  <div>
                    <strong className="mono">{t.toolName}</strong>
                    <small>{t.purpose}</small>
                  </div>
                  <div className="trace-time">
                    <strong>{t.symbol ?? 'GLOBAL'}</strong>
                    <small>
                      {num(t.latencyMs, 0)} ms · {when(t.timestamp)}
                    </small>
                  </div>
                  <b className={t.success ? 'pass-text' : 'fail-text'}>
                    {t.success ? '✓ PASS' : '! FAIL'}
                  </b>
                </div>
              ))}
            </div>
          ) : (
            <div className="empty-small">
              No ATK MCP calls recorded. A write call appears only after
              approved execution.
            </div>
          )}
        </article>
        <article className="card provenance">
          <div className="panel-head">
            <div>
              <span className="eyebrow">CAUSAL RECORD</span>
              <h3>Decision provenance</h3>
            </div>
            <span className="mono muted">{path?.cycleId ?? 'NO CYCLE'}</span>
          </div>
          {path ? (
            <div className="prov-list">
              {path.nodes.map((n, i) => {
                const outcome =
                  n.source === 'RISK' || n.source === 'LLM'
                    ? n.result
                    : n.success
                      ? 'PASS'
                      : 'FAIL';
                return (
                  <div className="prov" key={`${i}-${n.timestamp}`}>
                    <span className={`source ${n.source.toLowerCase()}`}>
                      {n.source === 'ATK_MCP' ? `ATK ${n.lane}` : n.source}
                    </span>
                    <div>
                      <strong>{n.toolName ?? n.description}</strong>
                      <small>
                        {n.toolName ? n.description : (n.symbol ?? 'System')}
                      </small>
                    </div>
                    <b
                      className={
                        !n.success || /REJECT|FAIL|BLOCK/.test(outcome)
                          ? 'fail-text'
                          : 'pass-text'
                      }
                    >
                      {outcome}
                    </b>
                  </div>
                );
              })}
              {!path.nodes.some(
                (n) =>
                  n.lane === 'WRITE' ||
                  n.description.includes('Execution submission'),
              ) && (
                <div className="prov not-called">
                  <span className="source">ATK WRITE</span>
                  <div>
                    <strong>Execution</strong>
                    <small>
                      {path.nodes.some((n) =>
                        n.description.includes('observe-only'),
                      )
                        ? 'Observe-only mode: analysis complete, execution withheld'
                        : 'Risk did not reach write authority'}
                    </small>
                  </div>
                  <b>NOT CALLED</b>
                </div>
              )}
            </div>
          ) : (
            <div className="empty-small">
              Provenance appears after the first completed cycle.
            </div>
          )}
        </article>
      </div>
    </section>
  );
}
export function Position({ s }: { s: JudgeSnapshot | null }) {
  const p = s?.functional.position,
    plan = s?.reasoning.riskCertificate?.protectionPlan,
    mode = s?.safety.protectionMode;
  return (
    <section className="section" id="position">
      <Heading eyebrow="CAPITAL IN MARKET" title="Position & protection" />
      <article className="card position">
        {p ? (
          <>
            <div className="panel-head">
              <div>
                <span className="eyebrow">OPEN POSITION</span>
                <h3>LONG · {p.symbol}</h3>
              </div>
              <Pill tone={mode ? 'good' : 'warn'}>
                {mode === 'EXCHANGE_SIDE'
                  ? 'EXCHANGE-SIDE PROTECTED'
                  : mode === 'CLIENT_SIDE'
                    ? 'CLIENT-SIDE PROTECTION ACTIVE'
                    : label(mode)}
              </Pill>
            </div>
            <div className="position-facts">
              <div>
                <span>Quantity</span>
                <strong>{num(p.quantity, 8)}</strong>
              </div>
              <div>
                <span>Average entry</span>
                <strong>{money(p.entryPrice)}</strong>
              </div>
              <div>
                <span>Mark price</span>
                <strong>{money(p.markPrice)}</strong>
              </div>
              <div>
                <span>Initial stop</span>
                <strong>
                  {plan?.symbol === p.symbol
                    ? money(plan.initialStopPrice)
                    : '—'}
                </strong>
              </div>
              <div>
                <span>Current protective stop</span>
                <strong>{money(p.stopPrice)}</strong>
              </div>
              <div>
                <span>Protection mode</span>
                <strong>{label(mode)}</strong>
              </div>
              <div>
                <span>Realized / unrealized PnL</span>
                <strong>
                  {money(p.realizedPnl)} / {money(p.unrealizedPnl)}
                </strong>
              </div>
              <div>
                <span>Break-even / trailing state</span>
                <strong>
                  {p.breakEvenActivated == null
                    ? '—'
                    : `${p.breakEvenActivated ? 'BREAK-EVEN ON' : 'BREAK-EVEN OFF'} · ${
                        p.trailingActivated ? 'TRAILING ON' : 'TRAILING OFF'
                      }`}
                </strong>
              </div>
              <div>
                <span>Take-profit reference</span>
                <strong>{money(p.takeProfitPrice)}</strong>
              </div>
            </div>
          </>
        ) : s ? (
          <div className="flat">
            <span className="flat-symbol">○</span>
            <div>
              <span className="eyebrow">CURRENT EXPOSURE</span>
              <h3>NO OPEN POSITION</h3>
              <p>
                AURA is flat. Its single-position risk budget is available only
                to an eligible, approved opportunity.
              </p>
            </div>
            <Pill>FLAT</Pill>
          </div>
        ) : (
          <div className="flat">
            <span className="flat-symbol">○</span>
            <div>
              <span className="eyebrow">CURRENT EXPOSURE</span>
              <h3>POSITION STATE UNAVAILABLE</h3>
              <p>Waiting for AURA's first read-only position snapshot.</p>
            </div>
            <Pill>WAITING</Pill>
          </div>
        )}
      </article>
    </section>
  );
}
export function History({ s }: { s: JudgeSnapshot | null }) {
  const [filter, setFilter] = useState<'ALL' | 'EXECUTED' | 'REJECTED'>('ALL');
  const rows = recentDecisionRows(s, filter);
  return (
    <section className="section" id="history">
      <Heading
        eyebrow="RECENT MEMORY"
        title="Decisions worth remembering"
        aside="Rejections stay visible: disciplined refusal is part of the record."
      />
      <article className="card history">
        <div className="filters" role="group" aria-label="Filter decisions">
          {(['ALL', 'EXECUTED', 'REJECTED'] as const).map((x) => (
            <button
              type="button"
              className={filter === x ? 'active-filter' : ''}
              onClick={() => setFilter(x)}
              key={x}
            >
              {x}
            </button>
          ))}
        </div>
        {rows.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>WHEN</th>
                  <th>SYMBOL / SETUP</th>
                  <th>OQS</th>
                  <th>SELECTION</th>
                  <th>CRITIC</th>
                  <th>RISK</th>
                  <th>EXECUTION</th>
                  <th>OUTCOME</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.cycleId}>
                    <td>{when(r.timestamp)}</td>
                    <td>
                      <strong>
                        {r.summary?.symbol ?? r.selectedSymbol ?? '—'}
                      </strong>
                      <small>{label(r.summary?.setupType)}</small>
                    </td>
                    <td>{num(r.summary?.oqs, 0)}</td>
                    <td>{label(r.summary?.selection)}</td>
                    <td title={r.summary?.counterThesis ?? undefined}>
                      {label(r.summary?.criticVerdict)}
                      <small className="clamp">
                        {r.summary?.counterThesis ?? '—'}
                      </small>
                    </td>
                    <td>
                      <strong
                        className={
                          r.summary?.riskResult === 'REJECT' ? 'fail-text' : ''
                        }
                      >
                        {label(r.summary?.riskResult)}
                      </strong>
                      <small>{r.summary?.primaryRejectionReason ?? '—'}</small>
                    </td>
                    <td>{label(r.summary?.executionResult)}</td>
                    <td>
                      {r.summary?.outcomeR == null
                        ? '—'
                        : `${num(r.summary.outcomeR)} R`}
                      <small>{money(r.summary?.pnl)}</small>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-small">
            {filter === 'ALL'
              ? 'No completed decisions have been published yet.'
              : `No ${filter.toLowerCase()} decisions in the recent record.`}
          </div>
        )}
      </article>
    </section>
  );
}
const questions: {
  title: string;
  intent: ExplainIntent | 'BLOCKING' | 'CRITIC';
}[] = [
  { title: 'Why did you select this asset?', intent: 'WHY_SELECTED' },
  { title: 'Why did you reject the last trade?', intent: 'WHY_REJECTED' },
  { title: 'Why are you not trading?', intent: 'WHY_NOT_TRADING' },
  { title: 'What is blocking the next entry?', intent: 'BLOCKING' },
  { title: 'What did the Market Critic challenge?', intent: 'CRITIC' },
  {
    title: 'How is the current position protected?',
    intent: 'CURRENT_PROTECTION',
  },
  {
    title: 'Which ATK MCP tools powered the last decision?',
    intent: 'MCP_EVIDENCE',
  },
];
export function Ask({ s }: { s: JudgeSnapshot | null }) {
  const [q, setQ] = useState<(typeof questions)[number] | null>(null);
  const service = new ReadOnlyExplainService(() => s);
  const answer =
    q?.intent === 'CRITIC'
      ? (s?.reasoning.counterThesis ??
        'No Market Critic counter-thesis is available yet.')
      : q?.intent === 'BLOCKING'
        ? `${service.explainCurrentState('WHY_NOT_TRADING').text}${primaryRejection(s) ? ` Latest rejection: ${primaryRejection(s)}.` : ''}`
        : q
          ? service.explainCurrentState(q.intent).text
          : null;
  return (
    <section className="section" id="ask">
      <Heading
        eyebrow="READ-ONLY EXPLANATION"
        title="Ask AURA"
        aside="Answers come from the current structured snapshot. Questions never reach trading authority."
      />
      <article className="card ask">
        <div className="ask-title">
          <span>✳</span>
          <div>
            <strong>What would you like to understand?</strong>
            <p>Choose a question about AURA's latest observed state.</p>
          </div>
        </div>
        <div className="questions">
          {questions.map((item) => (
            <button
              type="button"
              key={item.title}
              onClick={() => setQ(item)}
              className={q?.title === item.title ? 'selected-question' : ''}
            >
              {item.title}
              <span aria-hidden="true">↗</span>
            </button>
          ))}
        </div>
        <div className="answer" aria-live="polite">
          <span className="eyebrow">AURA EXPLAINS</span>
          <strong>{q?.title ?? 'Select a question above'}</strong>
          <p>
            {answer ??
              'A concise explanation will appear here using only published AURA state.'}
          </p>
        </div>
      </article>
    </section>
  );
}
export function StatusMcp({
  status,
}: {
  status: DashboardState['bridgeStatus'];
}) {
  return (
    <section className="section">
      <Heading eyebrow="OPEN OBSERVABILITY" title="AURA Status MCP" />
      <article className="card status-card">
        <div>
          <Pill tone={status === 'READY' ? 'good' : 'bad'}>{status}</Pill>
          <span className="eyebrow">READ-ONLY MCP INTERFACE</span>
          <h3>Inspect AURA from another MCP client.</h3>
          <p>
            External MCP clients can inspect live state, risk and decisions.
            They cannot trade or change configuration.
          </p>
        </div>
        <div className="tools">
          {statusMcpTools.map((t) => (
            <div className="mono" key={t}>
              {t}
            </div>
          ))}
        </div>
      </article>
    </section>
  );
}
function App() {
  const { data, connected } = useDashboard();
  const s = data.snapshot,
    f = s?.functional,
    e = f?.equity;
  const profile = s?.atk.readLane?.profile ?? s?.atk.writeLane?.profile;
  const recentClosed =
    s?.atk.recentDecisionMemory?.filter(
      (item) => item.resultCategory === 'CLOSED',
    ) ?? [];
  const recentWins = recentClosed.filter(
    (item) => item.outcomeR !== null && item.outcomeR > 0,
  ).length;
  const recentLosses = recentClosed.filter(
    (item) => item.outcomeR !== null && item.outcomeR < 0,
  ).length;
  return (
    <div className="shell">
      <aside className="sidebar">
        <a className="brand" href="#overview">
          <span className="brand-icon">✳</span>
          <span>
            AURA<small>INTELLIGENCE DESK</small>
          </span>
        </a>
        <span className="nav-caption">WORKSPACE</span>
        <nav aria-label="Dashboard sections">
          <a href="#overview">
            <span>◫</span> Overview
          </a>
          <a href="#markets">
            <span>◎</span> Markets
          </a>
          <a href="#decision">
            <span>◇</span> Decision
          </a>
          <a href="#risk">
            <span>◈</span> Risk
          </a>
          <a href="#mcp">
            <span>⌁</span> MCP Evidence
          </a>
          <a href="#history">
            <span>≡</span> History
          </a>
        </nav>
        <div className="sidebar-bottom">
          <div>
            <i className={connected ? 'online-dot' : 'offline-dot'} />{' '}
            {connected ? 'LOCAL STREAM CONNECTED' : 'STREAM DISCONNECTED'}
          </div>
          <p>
            One liquid universe.
            <br />
            One position at a time.
          </p>
          <small>READ-ONLY OBSERVATION</small>
        </div>
      </aside>
      <main id="overview">
        <div className="topline">
          <span>TRADING INTELLIGENCE / OVERVIEW</span>
          <span>Latest snapshot · {when(s?.timestamp)}</span>
        </div>
        <header className="hero">
          <div>
            <span>A CLEAR VIEW OF EVERY DECISION</span>
            <h1>
              AURA<em>✳</em>
            </h1>
            <p>Autonomous Liquid-Universe Opportunity Selector</p>
          </div>
          <div className="mode">
            <span className="eyebrow">CURRENT MODE</span>
            <strong>{profile?.toUpperCase() ?? 'AWAITING PROFILE'}</strong>
            <small>{label(f?.state)}</small>
          </div>
        </header>
        <div className="status-row">
          <Pill tone={profile === 'live' ? 'warn' : 'info'}>
            {profile?.toUpperCase() ?? 'NO'} PROFILE
          </Pill>
          <Pill
            tone={
              f?.state === 'LIVE' || f?.state === 'LIVE_READY'
                ? 'good'
                : 'neutral'
            }
          >
            AGENT {label(f?.state)}
          </Pill>
          <Pill tone={s?.atk.readLane?.status === 'READY' ? 'good' : 'warn'}>
            ATK READ {s?.atk.readLane?.status ?? 'UNKNOWN'}
          </Pill>
          <Pill tone={s?.atk.writeLane?.status === 'READY' ? 'good' : 'warn'}>
            ATK WRITE {s?.atk.writeLane?.status ?? 'UNKNOWN'}
          </Pill>
          <Pill tone={data.bridgeStatus === 'READY' ? 'good' : 'bad'}>
            STATUS MCP {data.bridgeStatus}
          </Pill>
          <Pill>RISK {label(s?.safety.riskMode)}</Pill>
          <Pill>PROTECTION {label(s?.safety.protectionMode)}</Pill>
        </div>
        {s && (!connected || data.bridgeStatus === 'OFFLINE') && (
          <div className="banner warning">
            <strong>STATUS SNAPSHOT UNAVAILABLE</strong>
            <span>
              Showing last known values · Verify AURA before relying on this
              view
            </span>
          </div>
        )}
        <Banner s={s} />
        <div className="overview-title">
          <div>
            <span className="eyebrow">AT A GLANCE</span>
            <h2>The state of AURA</h2>
          </div>
          <span>One position maximum across BTC-USDT and ETH-USDT</span>
        </div>
        <div className="metrics">
          <CardMetric
            name="CURRENT EQUITY"
            value={money(e?.current)}
            note={`Starting ${money(e?.starting)}`}
          />
          <CardMetric
            name="DAILY PNL"
            value={money(e?.dailyPnl)}
            note={`Daily return ${pct(e?.dailyReturnPct)}`}
            tone="sage"
          />
          <CardMetric
            name="CURRENT DRAWDOWN"
            value={pct(e?.currentDrawdownPct)}
            note={`Maximum ${pct(e?.maximumDrawdownPct)}`}
          />
          <CardMetric
            name="SELECTED OPPORTUNITY"
            value={s ? (f?.selectedSymbol ?? 'None') : 'Waiting'}
            note={
              !s
                ? 'Awaiting market state'
                : f?.selectedSymbol
                  ? `OQS ${num(f.selectedOQS, 0)}`
                  : 'No eligible setup'
            }
            tone="yellow"
          />
          <CardMetric
            name="POSITION"
            value={
              !s
                ? 'Unknown'
                : f?.position
                  ? `${f.position.symbol} LONG`
                  : 'Flat'
            }
            note={
              !s
                ? 'Awaiting position state'
                : f?.position
                  ? `${num(f.position.quantity, 6)} units`
                  : 'Risk budget available'
            }
          />
          <CardMetric
            name="RISK DECISION"
            value={s?.reasoning.riskCertificate?.verdict ?? 'Pending'}
            note={primaryRejection(s) ?? 'Awaiting certificate'}
            tone="lavender"
          />
        </div>
        <Chart points={data.equityHistory} s={s} />
        <div className="performance-strip">
          <div>
            <span>Starting equity</span>
            <strong>{money(e?.starting)}</strong>
          </div>
          <div>
            <span>Daily return</span>
            <strong>{pct(e?.dailyReturnPct)}</strong>
          </div>
          <div>
            <span>Current / max drawdown</span>
            <strong>
              {pct(e?.currentDrawdownPct)} / {pct(e?.maximumDrawdownPct)}
            </strong>
          </div>
          <div>
            <span>Realized / unrealized</span>
            <strong>Not published</strong>
          </div>
          <div>
            <span>Recent closed · W / L</span>
            <strong>
              {recentClosed.length
                ? `${recentClosed.length} · ${recentWins} / ${recentLosses}`
                : '—'}
            </strong>
          </div>
        </div>
        <Markets s={s} />
        <Pipeline s={s} />
        <div className="major-grid">
          <Critic s={s} setupQuality={data.critic.setupQuality} />
          <Risk s={s} />
        </div>
        <Mcp data={data} />
        <Position s={s} />
        <History s={s} />
        <Ask s={s} />
        <StatusMcp status={data.bridgeStatus} />
        <footer>
          AURA · READ-ONLY OBSERVABILITY{' '}
          <span>Clear, accountable autonomous trading.</span>
        </footer>
      </main>
    </div>
  );
}
const root =
  typeof document === 'undefined' ? null : document.getElementById('root');
if (root)
  createRoot(root).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );

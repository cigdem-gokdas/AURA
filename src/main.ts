import 'dotenv/config';
import { AuraAgent, type PreflightReport } from './agent/agent.js';
import { agentConfigFromEnv } from './agent/config.js';
import { AgentRecoveryStore } from './agent/recovery.js';
import { agentControlPath, sendAgentControl, startAgentControl } from './agent/control.js';
import { DemoSmokeRecoveryStore } from './agent/demo-smoke-recovery.js';
import { OkxExecutionEngine } from './execution/engine.js';
import { DashboardServer, type DashboardServerOptions } from './dashboard/server.js';
import { createLlmClient } from './llm/openai.js';
import { OkxMarketAdapter } from './market/okx-market-adapter.js';
import { AtkReadClient, AtkWriteClient } from './okx/lanes.js';
import { AuditLog, type AuditEvent } from './memory/audit.js';
import { publishJudgeSnapshot } from './status-mcp/bridge.js';

export type AgentCommand = 'preflight' | 'calibrate' | 'demo-smoke' | 'attached-protection-smoke'
  | 'run' | 'kill' | 'disarm';

export function dashboardOptionsFromEnv(env: NodeJS.ProcessEnv): DashboardServerOptions {
  return { statusPath: env.AURA_STATUS_SNAPSHOT_PATH ?? '.aura/status.json',
    auditPath: env.AURA_AUDIT_PATH ?? '.aura/audit.jsonl',
    ...(env.AURA_DASHBOARD_ALLOWED_HOSTS
      ? { allowedHosts: env.AURA_DASHBOARD_ALLOWED_HOSTS } : {}),
    ...(env.AURA_DASHBOARD_PORT ? { port: Number(env.AURA_DASHBOARD_PORT) } : {}) };
}

/** Dashboard reads only the passive snapshot/audit bridge; no trading port is supplied. */
export async function startRunDashboard(env: NodeJS.ProcessEnv,
  server = new DashboardServer(dashboardOptionsFromEnv(env))): Promise<{
    server: DashboardServer; url: string; websocketUrl: string;
  }> {
  try {
    const endpoints = await server.start();
    return { server, ...endpoints };
  } catch (error) {
    await server.close();
    throw error;
  }
}

/** Two independent MCP stdio processes: read-only evidence and spot execution. */
export function createProductionAgent(env: NodeJS.ProcessEnv = process.env,
  observability?: { audit?: (event: AuditEvent) => void | Promise<void>;
    statusPath?: string }): AuraAgent {
  const config = agentConfigFromEnv(env);
  const connector = new AtkReadClient(env);
  const writeConnector = new AtkWriteClient(env);
  const market = new OkxMarketAdapter(connector);
  const execution = new OkxExecutionEngine(writeConnector, config.symbols, Date.now,
    connector, env.LIVE_TRADING_ARMED === 'false', config.liveEntryProtectionVerified);
  const recovery = new AgentRecoveryStore(env.AURA_RECOVERY_STATE_PATH);
  const smokeRecovery = new DemoSmokeRecoveryStore(`${recovery.path}.smoke`);
  let agent: AuraAgent;
  let statusQueue = Promise.resolve();
  agent = new AuraAgent(config, { connector, market, execution, llm: createLlmClient(env),
    demoSmokeNotice: line => process.stdout.write(`${line}\n`),
    smokeRecovery,
    ...(observability?.audit ? { audit: observability.audit } : {}),
    ...(observability?.statusPath ? { observer: () => {
      const snapshot = agent.getJudgeSnapshot();
      if (!snapshot) return;
      statusQueue = statusQueue.then(() => publishJudgeSnapshot(observability.statusPath!, snapshot))
        .catch(error => { process.stderr.write(`AURA status publication failed: ${error instanceof Error ? error.message : 'Unknown error'}\n`); });
      return statusQueue;
    } } : {}),
    startupContext: async (snapshot, references) => {
      await smokeRecovery.assertClear();
      return recovery.context(snapshot, references);
    },
    recoverySymbols: () => recovery.ownedSymbols(),
    persistPosition: position => recovery.save(position),
    persistPositions: positions => recovery.savePositions(positions),
    killSwitch: () => env.AURA_KILL_SWITCH === 'true' });
  return agent;
}

function printReport(report: PreflightReport): void {
  if (report.readLane) process.stdout.write(`ATK READ ${report.readLane.status} version=${report.readLane.serverVersion ?? 'unknown'} profile=${report.readLane.profile} readOnly=${report.readLane.readOnly} tools=${report.readLane.toolCount}\n`);
  if (report.writeLane) process.stdout.write(`ATK WRITE ${report.writeLane.status} version=${report.writeLane.serverVersion ?? 'unknown'} profile=${report.writeLane.profile} scope=spot tools=${report.writeLane.tools.length}\n`);
  for (const check of report.checks) process.stdout.write(`${check.passed ? 'PASS' : 'FAIL'} ${check.name}: ${check.detail}\n`);
  for (const holding of report.unmanagedInventory ?? []) process.stdout.write(
    `UNMANAGED_INVENTORY ${holding.symbol} quantity=${holding.quantity}\n`);
  if (report.universe) {
    process.stdout.write(`UNIVERSE threshold24hUSDT=${report.universe.minimumQuoteVolume24h} `
      + `excludedLiquidity=${report.universe.excludedForLiquidity} `
      + `excludedStatus=${report.universe.excludedForStatus} `
      + `excludedStaleness=${report.universe.excludedForStaleness}\n`);
    for (const item of report.universe.selected) process.stdout.write(
      `UNIVERSE_PAIR ${item.symbol} volume24hUSDT=${item.quoteVolume24h}\n`);
  }
  process.stdout.write(`${report.passed ? 'PASS' : 'FAIL'} PREFLIGHT readiness=${report.readiness ?? 'BLOCKED'} state=${report.state} position=${report.positionSymbol ?? 'FLAT'} blockers=${report.blockers?.join(',') || 'none'}\n`);
}

export async function main(command: string | undefined = process.argv[2], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  if (!['preflight', 'calibrate', 'demo-smoke', 'attached-protection-smoke', 'run', 'kill', 'disarm'].includes(command ?? '')) {
    process.stderr.write('Usage: npm run agent:{preflight|calibrate|demo-smoke|attached-protection-smoke|run|kill|disarm}\n');
    return 2;
  }
  if (command === 'kill' || command === 'disarm') {
    const reply = await sendAgentControl(agentControlPath(env), command === 'kill' ? 'KILL' : 'DISARM');
    process.stdout.write(`${reply}\n`);
    return 0;
  }
  let audit: AuditLog | null = null;
  let auditDegraded = false;
  const auditFailure = (error: unknown): void => {
    if (auditDegraded) return;
    auditDegraded = true;
    process.stderr.write(`AURA audit degraded: ${error instanceof Error ? error.message : 'Unknown error'}\n`);
  };
  try { audit = await AuditLog.open(env.AURA_AUDIT_PATH ?? '.aura/audit.jsonl'); }
  catch (error) { auditFailure(error); }
  const record = (event: AuditEvent): void => {
    if (!audit || auditDegraded) return;
    void audit.append(event).catch(auditFailure);
  };
  record({ eventType: 'STARTUP', payload: { command, profile: env.OKX_PROFILE,
    universeSize: env.UNIVERSE_SIZE ?? 12,
    min24hQuoteVolumeUsdt: env.MIN_24H_QUOTE_VOLUME_USDT ?? 10_000_000 }, timestamp: Date.now() });
  const closeAudit = async (): Promise<void> => {
    try { await audit?.close(); } catch (error) { auditFailure(error); }
  };
  let agent: AuraAgent;
  try { agent = createProductionAgent(env, { audit: record,
    statusPath: env.AURA_STATUS_SNAPSHOT_PATH ?? '.aura/status.json' }); }
  catch (error) { await closeAudit(); throw error; }
  if (command === 'run') {
    const report = await agent.preflight();
    printReport(report);
    if (!report.passed || !agent.activate()) { await agent.shutdown(); await closeAudit(); return 1; }
    let dashboard: Awaited<ReturnType<typeof startRunDashboard>>;
    try { dashboard = await startRunDashboard(env); }
    catch (error) { await agent.shutdown(); await closeAudit(); throw error; }
    let closeControl: () => Promise<void>;
    try { closeControl = await startAgentControl(agentControlPath(env), control => {
      if (control === 'KILL') agent.engageKillSwitch();
      else agent.disarmEntries();
    }); }
    catch (error) { await dashboard.server.close(); await agent.shutdown(); await closeAudit(); throw error; }
    process.stdout.write(`AURA dashboard: ${dashboard.url}\nAURA dashboard stream: ${dashboard.websocketUrl}\n`);
    let stopping = false;
    const stop = (): void => {
      if (stopping) return;
      stopping = true;
      void closeControl().then(() => agent.shutdown()).then(() => dashboard.server.close())
        .then(closeAudit).then(() => { process.exitCode = 0; })
        .catch(error => { process.stderr.write(`AURA shutdown failed: ${error instanceof Error ? error.message : 'Unknown error'}\n`);
          process.exitCode = 1; });
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    agent.startScheduling();
    return 0;
  }
  try {
    if (command === 'preflight') {
      const report = await agent.preflight();
      printReport(report);
      return report.passed ? 0 : 1;
    }
    if (command === 'calibrate') {
      const result = await agent.calibrate();
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return 0;
    }
    if (command === 'attached-protection-smoke') {
      const result = await agent.attachedProtectionSmoke();
      for (const line of result.stages) process.stdout.write(`ATTACHED_PROTECTION_SMOKE ${line}\n`);
      process.stdout.write(`ATTACHED_PROTECTION_SMOKE EVIDENCE ${JSON.stringify(result.evidence)}\n`);
      process.stdout.write(`${result.passed ? 'PASS' : 'FAIL'} ATTACHED_PROTECTION_SMOKE ${result.reason}\n`);
      if (result.passed) process.stdout.write('Human attestation may now set LIVE_ENTRY_PROTECTION_VERIFIED=true in .env\n');
      return result.passed ? 0 : 1;
    }
    const result = await agent.demoSmoke();
    printReport(result.preflight);
    process.stdout.write(`${result.passed ? 'PASS' : 'FAIL'} DEMO_SMOKE ${result.reason}\n`);
    if (result.execution) {
      const smoke = result.execution;
      if (smoke.writeDiagnostic) process.stdout.write(`DEMO_SMOKE WRITE_RESULT `
        + `${JSON.stringify(smoke.writeDiagnostic)}\n`);
      process.stdout.write(`DEMO_SMOKE PROTECTION_TEST=${smoke.protectionTest} `
        + `filled=${smoke.confirmedFilledQuantity} avgFill=${smoke.entryAverageFillPrice ?? 'unknown'} `
        + `fee=${smoke.entryFeeAmount} ${smoke.entryFeeCurrency ?? 'unknown'} `
        + `netOwnedBase=${smoke.netOwnedBase} dust=${smoke.dustQuantity} `
        + `auraManagedActivePositions=${smoke.auraManagedActivePositionCount}\n`);
      if (smoke.status === 'RECONCILE_REQUIRED'
        || smoke.status === 'MANUAL_RECONCILIATION_REQUIRED') {
        process.stdout.write('DEMO_SMOKE_MANUAL_RECONCILIATION_REQUIRED\n');
        process.stdout.write(`symbol=${smoke.symbol} clientOrderId=${smoke.clientOrderId} `
          + `orderId=${smoke.orderId ?? 'unknown'} confirmedFilledQuantity=${smoke.confirmedFilledQuantity} `
          + `protectionId=${smoke.protectionId ?? 'none'} exitOrderId=${smoke.exitOrderId ?? 'none'}\n`);
      }
    }
    return result.passed ? 0 : 1;
  } finally { await agent.shutdown(); await closeAudit(); }
}

if (process.argv[1] && /(?:^|\/)main\.(?:ts|js)$/.test(process.argv[1])) {
  void main().then(code => { process.exitCode = code; }).catch(error => {
    process.stderr.write(`AURA startup failed: ${error instanceof Error ? error.message : 'Unknown error'}\n`);
    process.exitCode = 1;
  });
}

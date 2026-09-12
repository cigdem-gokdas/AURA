import 'dotenv/config';
import { AuraAgent, type PreflightReport } from './agent/agent.js';
import { agentConfigFromEnv } from './agent/config.js';
import { AgentRecoveryStore } from './agent/recovery.js';
import { OkxExecutionEngine } from './execution/engine.js';
import { createLlmClient } from './llm/openai.js';
import { OkxMarketAdapter } from './market/okx-market-adapter.js';
import { AtkReadClient, AtkWriteClient } from './okx/lanes.js';
import { AuditLog, type AuditEvent } from './memory/audit.js';
import { publishJudgeSnapshot } from './status-mcp/bridge.js';

export type AgentCommand = 'preflight' | 'calibrate' | 'demo-smoke' | 'run';

/** Two independent MCP stdio processes: read-only evidence and spot execution. */
export function createProductionAgent(env: NodeJS.ProcessEnv = process.env,
  observability?: { audit?: (event: AuditEvent) => void | Promise<void>;
    statusPath?: string }): AuraAgent {
  const config = agentConfigFromEnv(env);
  const connector = new AtkReadClient(env);
  const writeConnector = new AtkWriteClient(env);
  const market = new OkxMarketAdapter(connector);
  const execution = new OkxExecutionEngine(writeConnector, config.symbols, Date.now, connector);
  const recovery = new AgentRecoveryStore(env.AURA_RECOVERY_STATE_PATH);
  let agent: AuraAgent;
  let statusQueue = Promise.resolve();
  agent = new AuraAgent(config, { connector, market, execution, llm: createLlmClient(env),
    ...(observability?.audit ? { audit: observability.audit } : {}),
    ...(observability?.statusPath ? { observer: () => {
      const snapshot = agent.getJudgeSnapshot();
      if (!snapshot) return;
      statusQueue = statusQueue.then(() => publishJudgeSnapshot(observability.statusPath!, snapshot))
        .catch(error => { process.stderr.write(`AURA status publication failed: ${error instanceof Error ? error.message : 'Unknown error'}\n`); });
    } } : {}),
    startupContext: (snapshot, references) => recovery.context(snapshot, references),
    persistPosition: position => recovery.save(position),
    killSwitch: () => env.AURA_KILL_SWITCH === 'true' });
  return agent;
}

function printReport(report: PreflightReport): void {
  if (report.readLane) process.stdout.write(`ATK READ ${report.readLane.status} version=${report.readLane.serverVersion ?? 'unknown'} profile=${report.readLane.profile} readOnly=${report.readLane.readOnly} tools=${report.readLane.toolCount}\n`);
  if (report.writeLane) process.stdout.write(`ATK WRITE ${report.writeLane.status} version=${report.writeLane.serverVersion ?? 'unknown'} profile=${report.writeLane.profile} scope=spot tools=${report.writeLane.tools.length}\n`);
  for (const check of report.checks) process.stdout.write(`${check.passed ? 'PASS' : 'FAIL'} ${check.name}: ${check.detail}\n`);
  process.stdout.write(`${report.passed ? 'PASS' : 'FAIL'} PREFLIGHT readiness=${report.readiness ?? 'BLOCKED'} state=${report.state} position=${report.positionSymbol ?? 'FLAT'} blockers=${report.blockers?.join(',') || 'none'}\n`);
}

export async function main(command: string | undefined = process.argv[2], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  if (!['preflight', 'calibrate', 'demo-smoke', 'run'].includes(command ?? '')) {
    process.stderr.write('Usage: npm run agent:{preflight|calibrate|demo-smoke|run}\n');
    return 2;
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
    symbols: env.SYMBOLS }, timestamp: Date.now() });
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
    let stopping = false;
    const stop = (): void => {
      if (stopping) return;
      stopping = true;
      void agent.shutdown().then(closeAudit).then(() => { process.exitCode = 0; })
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
    const result = await agent.demoSmoke();
    printReport(result.preflight);
    process.stdout.write(`${result.passed ? 'PASS' : 'FAIL'} DEMO_SMOKE ${result.reason}\n`);
    return result.passed ? 0 : 1;
  } finally { await agent.shutdown(); await closeAudit(); }
}

if (process.argv[1] && /(?:^|\/)main\.(?:ts|js)$/.test(process.argv[1])) {
  void main().then(code => { process.exitCode = code; }).catch(error => {
    process.stderr.write(`AURA startup failed: ${error instanceof Error ? error.message : 'Unknown error'}\n`);
    process.exitCode = 1;
  });
}

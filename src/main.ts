import 'dotenv/config';
import { AuraAgent, type PreflightReport } from './agent/agent.js';
import { agentConfigFromEnv } from './agent/config.js';
import { AgentRecoveryStore } from './agent/recovery.js';
import { OkxExecutionEngine } from './execution/engine.js';
import { createLlmClient } from './llm/openai.js';
import { OkxMarketAdapter } from './market/okx-market-adapter.js';
import { AtkReadClient, AtkWriteClient } from './okx/lanes.js';

export type AgentCommand = 'preflight' | 'calibrate' | 'demo-smoke' | 'run';

/** Two independent MCP stdio processes: read-only evidence and spot execution. */
export function createProductionAgent(env: NodeJS.ProcessEnv = process.env): AuraAgent {
  const config = agentConfigFromEnv(env);
  const connector = new AtkReadClient(env);
  const writeConnector = new AtkWriteClient(env);
  const market = new OkxMarketAdapter(connector);
  const execution = new OkxExecutionEngine(writeConnector, config.symbols, Date.now, connector);
  const recovery = new AgentRecoveryStore(env.AURA_RECOVERY_STATE_PATH);
  return new AuraAgent(config, { connector, market, execution, llm: createLlmClient(env),
    startupContext: (snapshot, references) => recovery.context(snapshot, references),
    persistPosition: position => recovery.save(position),
    killSwitch: () => env.AURA_KILL_SWITCH === 'true' });
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
  const agent = createProductionAgent(env);
  if (command === 'run') {
    const report = await agent.preflight();
    printReport(report);
    if (!report.passed || !agent.activate()) { await agent.shutdown(); return 1; }
    let stopping = false;
    const stop = (): void => {
      if (stopping) return;
      stopping = true;
      void agent.shutdown().then(() => { process.exitCode = 0; });
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
  } finally { await agent.shutdown(); }
}

if (process.argv[1] && /(?:^|\/)main\.(?:ts|js)$/.test(process.argv[1])) {
  void main().then(code => { process.exitCode = code; }).catch(error => {
    process.stderr.write(`AURA startup failed: ${error instanceof Error ? error.message : 'Unknown error'}\n`);
    process.exitCode = 1;
  });
}

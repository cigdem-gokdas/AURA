import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { JudgeSnapshotStatusProvider, type AuraStatusProvider } from './provider.js';
import { readJudgeSnapshot } from './bridge.js';

function response(data: Record<string, unknown>) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }], structuredContent: data };
}

/** Exactly four read-only tools. Unknown names are rejected by the MCP SDK. */
export function createStatusMcpServer(provider: AuraStatusProvider): McpServer {
  const server = new McpServer({ name: 'aura-status-mcp', version: '1.0.0' }, { capabilities: { tools: {} } });
  const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true };
  server.registerTool('get_agent_state', { description: 'Current read-only AURA state',
    inputSchema: z.object({}), annotations }, async () => response(await provider.getAgentState()));
  server.registerTool('get_risk_certificate', { description: 'Latest ordered hard-risk certificate',
    inputSchema: z.object({}), annotations }, async () => response(await provider.getRiskCertificate()));
  server.registerTool('get_recent_decisions', { description: 'Bounded compact decision history',
    inputSchema: z.object({ limit: z.number().int().min(1).max(20) }), annotations },
  async ({ limit }) => response(await provider.getRecentDecisions(limit)));
  server.registerTool('get_market_snapshot', { description: 'Observed liquid-universe market summaries',
    inputSchema: z.object({ symbol: z.string().regex(/^[A-Z0-9]+-USDT$/).optional() }), annotations },
  async ({ symbol }) => response(await provider.getMarketSnapshot(symbol)));
  return server;
}

/** This process imports no trading core, ATK client, exchange connector, or LLM. */
export async function runStatusMcp(path = process.env.AURA_STATUS_SNAPSHOT_PATH ?? '.aura/status.json'): Promise<void> {
  const provider = new JudgeSnapshotStatusProvider(() => readJudgeSnapshot(path));
  const server = createStatusMcpServer(provider);
  await server.connect(new StdioServerTransport());
  const stop = () => { void server.close(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (process.argv[1] && /(?:^|\/)server\.(?:ts|js)$/.test(process.argv[1])) {
  void runStatusMcp().catch(error => {
    process.stderr.write(`AURA status MCP failed: ${error instanceof Error ? error.message : 'Unknown error'}\n`);
    process.exitCode = 1;
  });
}

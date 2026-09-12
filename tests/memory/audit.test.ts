import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditLog, redactAudit } from '../../src/memory/audit.js';

const directories: string[] = [];
async function path() {
  const directory = await mkdtemp(join(tmpdir(), 'aura-audit-'));
  directories.push(directory);
  return join(directory, 'audit.jsonl');
}
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

describe('append-only audit JSONL', () => {
  it('writes one valid line per event, serializes concurrency, and resumes sequence after reopen', async () => {
    const file = await path();
    const audit = await AuditLog.open(file);
    await audit.append({ eventType: 'STARTUP', timestamp: 10, payload: { symbol: 'BTC-USDT' } });
    await Promise.all(Array.from({ length: 30 }, (_, index) => audit.append({ eventType: 'MARKET_ACCEPTED',
      timestamp: 11 + index, symbol: index % 2 ? 'ETH-USDT' : 'BTC-USDT', payload: { price: 100 + index } })));
    await audit.flush();
    await audit.close();
    const reopened = await AuditLog.open(file);
    await reopened.append({ eventType: 'PREFLIGHT', payload: { passed: true } });
    await reopened.close();
    const lines = (await readFile(file, 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line));
    expect(lines).toHaveLength(32);
    expect(lines.map(line => line.sequence)).toEqual(Array.from({ length: 32 }, (_, index) => index + 1));
    expect(lines[0]).toMatchObject({ schemaVersion: 1, sequence: 1, timestamp: 10,
      eventType: 'STARTUP', payload: { symbol: 'BTC-USDT' } });
    expect(lines.at(-1)?.eventType).toBe('PREFLIGHT');
  });

  it('recursively redacts credentials while keeping decision identifiers and evidence', async () => {
    const file = await path();
    const audit = await AuditLog.open(file);
    await audit.append({ eventType: 'DECISION_PROVENANCE', cycleId: 'cycle1', decisionId: 'decision1',
      clientOrderId: 'client1', symbol: 'ETH-USDT', payload: {
        toolName: 'market_get_ticker', lane: 'READ', oqs: 82, price: 101, quantity: 2,
        orderId: 'order1', pnl: 3, latencyMs: 4, reason: 'Risk rejected spread',
        nested: { OPENAI_API_KEY: 'secret-a', okx: { apiKey: 'secret-b', secretKey: 'secret-c',
          passphrase: 'secret-d', Authorization: 'Bearer secret-e' },
          note: 'Authorization: Bearer secret-f' },
      } });
    await audit.append({ eventType: 'MARKET_CRITIC_RESULT', payload: { counter_thesis: 'Momentum may fade' } });
    await audit.append({ eventType: 'RISK_CERTIFICATE', payload: { gates: [{ name: 'SPREAD', status: 'FAIL', reason: 'Too wide' }] } });
    await audit.append({ eventType: 'ATK_MCP_CALL', payload: { toolName: 'market_get_ticker', lane: 'READ', latencyMs: 2 } });
    await audit.close();
    const body = await readFile(file, 'utf8');
    for (const secret of ['secret-a', 'secret-b', 'secret-c', 'secret-d', 'secret-e', 'secret-f']) expect(body).not.toContain(secret);
    const lines = body.trimEnd().split('\n').map(line => JSON.parse(line));
    expect(lines[0]).toMatchObject({ cycleId: 'cycle1', decisionId: 'decision1', clientOrderId: 'client1',
      symbol: 'ETH-USDT', payload: { toolName: 'market_get_ticker', lane: 'READ', oqs: 82,
        price: 101, quantity: 2, orderId: 'order1', pnl: 3, latencyMs: 4 } });
    expect(lines[1]?.payload.counter_thesis).toBe('Momentum may fade');
    expect(lines[2]?.payload.gates[0].name).toBe('SPREAD');
    expect(lines[3]?.payload.toolName).toBe('market_get_ticker');
    expect(redactAudit({ env: { ANY_KEY: 'sensitive' }, mcpProcessEnvironment: { KEY: 'hidden' } }))
      .toEqual({ env: '[REDACTED]', mcpProcessEnvironment: '[REDACTED]' });
  });

  it('surfaces failures, never writes partial JSON, and rejects appends after close', async () => {
    const file = await path();
    const audit = await AuditLog.open(file);
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    await expect(audit.append({ eventType: 'ERROR', payload: cycle })).rejects.toThrow('Cyclic');
    await expect(audit.flush()).rejects.toThrow('Cyclic');
    await expect(audit.append({ eventType: 'STARTUP', payload: {} })).rejects.toThrow('Cyclic');
    await expect(audit.close()).rejects.toThrow('Cyclic');
    expect(await readFile(file, 'utf8')).toBe('');
    await expect(audit.append({ eventType: 'STARTUP', payload: {} })).rejects.toThrow('closed');
  });
});

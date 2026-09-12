import { describe, expect, it } from 'vitest';
import { OkxExecutionEngine } from '../../src/execution/engine.js';
import type { OkxConnector } from '../../src/okx/connector.js';
import type { OkxToolDefinition } from '../../src/okx/types.js';
import type { ApprovedOrderPlan } from '../../src/risk/types.js';

function tool(name: string, fields: string[]): OkxToolDefinition {
  return { name, description: null, inputSchema: { type: 'object', properties: Object.fromEntries(fields.map(field => [field, {
    type: 'string', ...(field === 'tdMode' ? { enum: ['cash'] } : {}),
    ...(field === 'side' ? { enum: ['buy', 'sell'] } : {}),
    ...(field === 'ordType' ? { enum: ['market'] } : {}),
    ...(field === 'tgtCcy' ? { enum: ['base_ccy'] } : {}),
  }])) } };
}
const readTools = [tool('spot_get_order', ['instId', 'clOrdId']),
  tool('spot_get_orders', ['status', 'instId']), tool('spot_get_fills', ['instId']),
  tool('account_get_balance', []), tool('account_get_trade_fee', ['instType', 'instId'])];
const writeTools = [tool('spot_place_order', ['instId', 'tdMode', 'side', 'ordType', 'sz', 'tgtCcy', 'clOrdId'])];
const envelope = (data: unknown[]) => ({ endpoint: '/fake', requestTime: '2026-09-12T00:00:00Z', data });

class Lane implements OkxConnector {
  readonly profile = 'demo' as const;
  readonly readOnly: boolean;
  connected = false;
  calls: string[] = [];
  constructor(readonly lane: 'READ' | 'WRITE', private readonly definitions: OkxToolDefinition[]) {
    this.readOnly = lane === 'READ';
  }
  async connect() { this.connected = true; }
  async disconnect() { this.connected = false; }
  isConnected() { return this.connected; }
  async healthCheck() { return { connected: this.connected, profile: this.profile,
    status: this.connected ? 'HEALTHY' as const : 'UNAVAILABLE' as const, reason: null, timestamp: 1000 }; }
  async listTools() { return this.definitions; }
  async callTool<T>(name: string): Promise<T> {
    this.calls.push(name);
    if (this.lane === 'WRITE') {
      if (name !== 'spot_place_order') throw new Error('READ tool reached WRITE lane');
      return envelope([{ ordId: 'order1', clOrdId: 'client1', sCode: '0' }]) as T;
    }
    if (name === 'account_get_balance') return envelope([{ totalEq: '1000', uTime: '1000',
      details: [{ ccy: 'USDT', eq: '1000', availBal: '1000' }] }]) as T;
    if (name === 'account_get_trade_fee') return envelope([{ maker: '-0.001', taker: '-0.001', instId: 'BTC-USDT' }]) as T;
    if (name.startsWith('spot_get_')) return envelope([]) as T;
    throw new Error('Unexpected READ tool');
  }
}

function plan(): ApprovedOrderPlan {
  return { symbol: 'BTC-USDT', side: 'BUY', quantity: 1, referencePrice: 100,
    estimatedNotional: 100, clientOrderId: 'client1', cycleId: 'cycle1', decisionId: 'decision1',
    protection: { symbol: 'BTC-USDT', initialStopPrice: 97, stopDistanceAbsolute: 3,
      stopDistanceFraction: 0.03, breakEvenTriggerR: 1, trailingActivationR: 1.5,
      takeProfitR: 2.5, protectionMode: 'CLIENT_SIDE' } };
}

describe('execution with isolated MCP lanes', () => {
  it('keeps startup and reconciliation reads on READ and sends only placement to WRITE', async () => {
    const read = new Lane('READ', readTools);
    const write = new Lane('WRITE', writeTools);
    const engine = new OkxExecutionEngine(write, ['BTC-USDT'], () => 1000, read);
    await engine.start();
    expect((await engine.getStartupSnapshot()).positions).toEqual([]);
    expect(write.calls).toEqual([]);
    expect((await engine.submitApprovedOrder(plan())).status).toBe('ACCEPTED');
    expect(write.calls).toEqual(['spot_place_order']);
    expect(read.calls).toContain('account_get_balance');
    expect(read.calls).toContain('spot_get_order');
    await expect(engine.getWriteHealth()).resolves.toMatchObject({ connected: true });
    await engine.stop();
    expect(write.connected).toBe(false);
    expect(read.connected).toBe(true);
    await read.disconnect();
  });

  it('refuses to submit when either isolated lane is disconnected', async () => {
    const read = new Lane('READ', readTools);
    const write = new Lane('WRITE', writeTools);
    const engine = new OkxExecutionEngine(write, ['BTC-USDT'], () => 1000, read);
    await engine.start();
    await read.disconnect();
    expect((await engine.submitApprovedOrder(plan())).status).toBe('CONNECTOR_FAILURE');
    expect(write.calls).toEqual([]);
    await engine.stop();
  });

  it('rejects a missing WRITE place-order capability even if READ advertises it', async () => {
    const read = new Lane('READ', [...readTools, ...writeTools]);
    const write = new Lane('WRITE', []);
    const engine = new OkxExecutionEngine(write, ['BTC-USDT'], () => 1000, read);
    await expect(engine.start()).rejects.toMatchObject({ category: 'TOOL_NOT_AVAILABLE' });
    expect(write.calls).toEqual([]);
    await engine.stop();
    await read.disconnect();
  });
});

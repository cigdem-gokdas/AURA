import { describe, expect, it, vi } from 'vitest';
import type { Client } from '@modelcontextprotocol/client';
import type { StdioClientTransport, StdioServerParameters } from '@modelcontextprotocol/client/stdio';
import { AtkReadClient, AtkWriteClient } from '../../src/okx/lanes.js';
import type { OkxMcpSessionFactory } from '../../src/okx/connector.js';
import { AtkTraceBuffer } from '../../src/okx/telemetry.js';

const env = { OKX_PROFILE: 'demo', OKX_CONNECTOR_MODE: 'mcp', OKX_DEMO_PROFILE: 'demo-safe',
  OKX_LIVE_PROFILE: 'live-safe', ATK_CONTEXT_PULSE: 'false' };
const tool = (name: string, properties: Record<string, unknown> = {}) => ({
  name, description: null, inputSchema: { type: 'object', properties },
});

function session(tools: ReturnType<typeof tool>[]) {
  const client = { connect: vi.fn(async () => undefined), close: vi.fn(async () => undefined),
    getServerVersion: vi.fn(() => ({ name: 'okx-trade-mcp', version: '1.4.6' })),
    listTools: vi.fn(async () => ({ tools })),
    callTool: vi.fn(async ({ name }: { name: string }) => ({ structuredContent: { tool: name, ok: true,
      data: { endpoint: '/read', requestTime: '2026-09-12T00:00:00Z', data: [] } } })),
  };
  const factory = vi.fn((_: StdioServerParameters) => ({ client: client as unknown as Client,
    transport: {} as StdioClientTransport })) as OkxMcpSessionFactory & ReturnType<typeof vi.fn>;
  return { client, factory };
}

describe('isolated ATK MCP lanes', () => {
  it('starts independent read-only and spot-only child sessions with separate tool registries', async () => {
    const readSession = session([tool('market_get_ticker'), tool('account_get_balance'),
      tool('spot_get_fills'), tool('market_get_indicator'), tool('market_get_pair_spread'),
      tool('spot_place_order')]);
    const writeSession = session([tool('spot_place_order'), tool('spot_get_order'), tool('spot_set_leverage')]);
    const read = new AtkReadClient(env, readSession.factory);
    const write = new AtkWriteClient(env, writeSession.factory);
    await Promise.all([read.connect(), write.connect()]);
    expect(readSession.factory).toHaveBeenCalledOnce();
    expect(writeSession.factory).toHaveBeenCalledOnce();
    expect((readSession.factory.mock.calls[0]?.[0] as StdioServerParameters).args).toEqual([
      '--profile', 'demo-safe', '--modules', 'market,account,spot', '--read-only', '--demo']);
    expect((writeSession.factory.mock.calls[0]?.[0] as StdioServerParameters).args).toEqual([
      '--profile', 'demo-safe', '--modules', 'spot', '--demo']);
    expect(read.getServerVersion()).toBe('1.4.6');
    expect(read.getCapabilities().resolve('MARKET_TICKER')).toBe('market_get_ticker');
    expect(read.getCapabilities().has('MARKET_INDICATOR')).toBe(true);
    expect(read.getCapabilities().has('NEWS_LATEST')).toBe(false);
    expect(write.getCapabilities().resolve('SPOT_PLACE_ORDER')).toBe('spot_place_order');
    await expect(read.callTool('spot_place_order', {})).rejects.toMatchObject({ category: 'TOOL_NOT_AVAILABLE' });
    await expect(write.callTool('spot_set_leverage', {})).rejects.toMatchObject({ category: 'TOOL_NOT_AVAILABLE' });
    expect(readSession.client.callTool).not.toHaveBeenCalled();
    expect(writeSession.client.callTool).not.toHaveBeenCalled();
    await Promise.all([read.disconnect(), write.disconnect()]);
  });

  it('normalizes structured and text MCP results and emits bounded sanitized READ/WRITE traces', async () => {
    const readSession = session([tool('market_get_ticker')]);
    const writeSession = session([tool('spot_place_order')]);
    const read = new AtkReadClient(env, readSession.factory);
    const write = new AtkWriteClient(env, writeSession.factory);
    await Promise.all([read.connect(), write.connect()]);
    await read.callCapability('MARKET_TICKER', { instId: 'BTC-USDT' });
    writeSession.client.callTool.mockResolvedValueOnce({ content: [{ type: 'text',
      text: JSON.stringify({ tool: 'spot_place_order', ok: true, data: { data: [] } }) }] } as never);
    await write.callCapability('SPOT_PLACE_ORDER', { instId: 'ETH-USDT', side: 'buy' },
      { cycleId: 'cycle1', decisionId: 'decision1' });
    const readTrace = read.getRecentTraces()[0]!;
    const writeTrace = write.getRecentTraces()[0]!;
    expect(readTrace).toMatchObject({ lane: 'READ', toolName: 'market_get_ticker',
      purpose: 'MARKET_TICKER', symbol: 'BTC-USDT', success: true });
    expect(writeTrace).toMatchObject({ lane: 'WRITE', toolName: 'spot_place_order',
      purpose: 'SPOT_PLACE_ORDER', symbol: 'ETH-USDT', cycleId: 'cycle1', decisionId: 'decision1', success: true });
    expect(readTrace.latencyMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify([readTrace, writeTrace])).not.toMatch(/api.key|secret|passphrase|Authorization/i);
    readSession.client.callTool.mockRejectedValueOnce(new Error('secret=private'));
    await expect(read.callCapability('MARKET_TICKER', { instId: 'BTC-USDT' })).rejects.toThrow();
    expect(JSON.stringify(read.getRecentTraces())).not.toContain('private');
    await Promise.all([read.disconnect(), write.disconnect()]);
  });

  it('loads optional news only into the read-only lane when enabled', async () => {
    const fake = session([tool('news_get_latest')]);
    const read = new AtkReadClient({ ...env, ATK_CONTEXT_PULSE: 'true' }, fake.factory);
    await read.connect();
    expect((fake.factory.mock.calls[0]?.[0] as StdioServerParameters).args).toContain('market,account,spot,news');
    expect(read.getCapabilities().has('NEWS_LATEST')).toBe(true);
    await read.disconnect();
  });

  it('passes only basic process environment to each ATK child', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-secret');
    vi.stubEnv('OKX_API_KEY', 'test-okx-secret');
    try {
      const readSession = session([]);
      const writeSession = session([]);
      const read = new AtkReadClient(env, readSession.factory);
      const write = new AtkWriteClient(env, writeSession.factory);
      await Promise.all([read.connect(), write.connect()]);
      for (const factory of [readSession.factory, writeSession.factory]) {
        const childEnv = (factory.mock.calls[0]?.[0] as StdioServerParameters).env ?? {};
        expect(Object.keys(childEnv).sort()).toEqual(
          Object.keys(childEnv).filter(key =>
            ['HOME', 'LOGNAME', 'PATH', 'SHELL', 'TERM', 'USER'].includes(key)).sort(),
        );
        expect(childEnv.OPENAI_API_KEY).toBeUndefined();
        expect(childEnv.OKX_API_KEY).toBeUndefined();
      }
      await Promise.all([read.disconnect(), write.disconnect()]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('bounds traces while keeping monotonic sequence markers for provenance', () => {
    const buffer = new AtkTraceBuffer(2);
    for (let i = 0; i < 3; i += 1) buffer.record({ timestamp: i, lane: 'READ', toolName: 'market_get_ticker',
      purpose: 'MARKET_TICKER', symbol: 'BTC-USDT', profile: 'demo', latencyMs: 0,
      success: true, errorCode: null, errorMessage: null, cycleId: null, decisionId: null });
    expect(buffer.recent().map(item => item.sequence)).toEqual([2, 3]);
  });
});

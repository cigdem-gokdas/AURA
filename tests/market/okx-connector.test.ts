import { describe, expect, it, vi } from 'vitest';
import type { Client } from '@modelcontextprotocol/client';
import type {
  StdioClientTransport,
  StdioServerParameters,
} from '@modelcontextprotocol/client/stdio';
import {
  OkxMcpConnector,
  type OkxMcpSessionFactory,
} from '../../src/okx/connector.js';
import { okxConnectorConfigFromEnv } from '../../src/okx/config.js';
import {
  OkxConnectorError,
  type OkxConnectorConfig,
} from '../../src/okx/types.js';

const config: OkxConnectorConfig = {
  connectorMode: 'mcp',
  mcpCommand: 'okx-trade-mcp',
  modules: ['market', 'spot', 'account'],
  auraProfile: 'demo',
  demoProfileName: 'demo-profile',
  liveProfileName: 'live-profile',
};

function fakeSession(toolNames = ['market_get_ticker']) {
  const client = {
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn().mockResolvedValue({
      tools: toolNames.map((name) => ({
        name,
        description: name,
        inputSchema: { type: 'object' },
      })),
    }),
    callTool: vi.fn().mockResolvedValue({
      structuredContent: {
        tool: 'market_get_ticker',
        ok: true,
        data: {
          endpoint: '/api/v5/market/ticker',
          requestTime: '2026-09-12T00:00:00Z',
          data: [],
        },
      },
    }),
  };
  const factory = vi.fn((_: StdioServerParameters) => ({
    client: client as unknown as Client,
    transport: {} as StdioClientTransport,
  })) as OkxMcpSessionFactory & ReturnType<typeof vi.fn>;
  return { client, factory };
}

describe('OkxMcpConnector lifecycle', () => {
  it('has no connection on import or construction; connects and closes only explicitly', async () => {
    const { client, factory } = fakeSession();
    const connector = new OkxMcpConnector(config, factory);
    expect(factory).not.toHaveBeenCalled();
    expect(client.connect).not.toHaveBeenCalled();
    expect(connector.isConnected()).toBe(false);
    await expect(connector.listTools()).rejects.toMatchObject({
      category: 'CONNECTOR_NOT_CONNECTED',
    });

    await connector.connect();
    expect(factory).toHaveBeenCalledOnce();
    expect(client.connect).toHaveBeenCalledOnce();
    expect(client.listTools).toHaveBeenCalledOnce();
    expect(connector.isConnected()).toBe(true);
    expect((await connector.listTools()).map((tool) => tool.name)).toEqual([
      'market_get_ticker',
    ]);
    expect(
      await connector.callTool('market_get_ticker', { instId: 'BTC-USDT' }),
    ).toEqual({
      endpoint: '/api/v5/market/ticker',
      requestTime: '2026-09-12T00:00:00Z',
      data: [],
    });
    expect((await connector.healthCheck()).status).toBe('HEALTHY');
    await connector.disconnect();
    expect(client.close).toHaveBeenCalledOnce();
    expect(connector.isConnected()).toBe(false);
  });

  it('selects only the demo profile, modules, and simulated mode', async () => {
    const { factory } = fakeSession();
    const connector = new OkxMcpConnector(config, factory);
    await connector.connect();
    const parameters = factory.mock.calls[0]?.[0] as StdioServerParameters;
    expect(parameters.command).toBe('okx-trade-mcp');
    expect(parameters.args).toEqual([
      '--profile',
      'demo-profile',
      '--modules',
      'market,spot,account',
      '--demo',
    ]);
    expect(parameters.env?.OKX_API_KEY).toBeUndefined();
    expect(parameters.env?.OKX_SECRET_KEY).toBeUndefined();
    expect(parameters.env?.OKX_PASSPHRASE).toBeUndefined();
    await connector.disconnect();
  });

  it('selects only the live profile with explicit live mode', async () => {
    const { factory } = fakeSession();
    const connector = new OkxMcpConnector(
      { ...config, auraProfile: 'live' },
      factory,
    );
    await connector.connect();
    expect((factory.mock.calls[0]?.[0] as StdioServerParameters).args).toEqual([
      '--profile',
      'live-profile',
      '--modules',
      'market,spot,account',
      '--live',
    ]);
    await connector.disconnect();
  });

  it('fails closed for missing or invalid profiles, rather than falling back', async () => {
    for (const unsafe of [
      { ...config, demoProfileName: null },
      { ...config, demoProfileName: 'bad name' },
      { ...config, demoProfileName: 'live-profile' },
      { ...config, auraProfile: 'invalid' as 'demo' },
      { ...config, modules: ['all'] },
    ]) {
      const { factory } = fakeSession();
      await expect(
        new OkxMcpConnector(unsafe, factory).connect(),
      ).rejects.toMatchObject({
        category: 'PROFILE_CONFIGURATION_ERROR',
      });
      expect(factory).not.toHaveBeenCalled();
    }
    expect(() =>
      okxConnectorConfigFromEnv({
        OKX_PROFILE: 'demo',
        OKX_CONNECTOR_MODE: 'cli',
      }),
    ).toThrow(OkxConnectorError);
    expect(
      okxConnectorConfigFromEnv({
        OKX_PROFILE: 'demo',
        OKX_CONNECTOR_MODE: 'mcp',
        OKX_DEMO_PROFILE: 'safe-demo',
        OKX_LIVE_PROFILE: 'safe-live',
      }).demoProfileName,
    ).toBe('safe-demo');
    expect(
      OkxMcpConnector.fromEnv({
        OKX_PROFILE: 'demo',
        OKX_CONNECTOR_MODE: 'mcp',
        OKX_DEMO_PROFILE: 'safe-demo',
      }).isConnected(),
    ).toBe(false);
  });

  it('surfaces missing tools, malformed results, tool failures, and disconnect errors', async () => {
    const { client, factory } = fakeSession();
    const connector = new OkxMcpConnector(config, factory);
    await connector.connect();
    await expect(connector.callTool('missing', {})).rejects.toMatchObject({
      category: 'TOOL_NOT_AVAILABLE',
    });
    await expect(
      connector.callTool('market_get_ticker', { api_key: 'dummy' }),
    ).rejects.toMatchObject({ category: 'CONNECTOR_PROTOCOL_ERROR' });
    await expect(
      connector.callTool('market_get_ticker', {
        nested: { OKX_API_KEY: 'dummy' },
      }),
    ).rejects.toMatchObject({ category: 'CONNECTOR_PROTOCOL_ERROR' });
    client.callTool.mockResolvedValueOnce({ structuredContent: { ok: true } });
    await expect(
      connector.callTool('market_get_ticker', {}),
    ).rejects.toMatchObject({ category: 'CONNECTOR_PROTOCOL_ERROR' });
    client.callTool.mockResolvedValueOnce({
      isError: true,
      structuredContent: { ok: false },
    });
    await expect(
      connector.callTool('market_get_ticker', {}),
    ).rejects.toMatchObject({ category: 'TOOL_CALL_FAILED' });
    client.callTool.mockRejectedValueOnce(new Error('private server detail'));
    await expect(
      connector.callTool('market_get_ticker', {}),
    ).rejects.toMatchObject({ category: 'TOOL_CALL_FAILED' });
    client.close.mockRejectedValueOnce(new Error('private server detail'));
    await expect(connector.disconnect()).rejects.toMatchObject({
      category: 'CONNECTOR_PROTOCOL_ERROR',
    });
    expect(connector.isConnected()).toBe(false);
  });

  it('surfaces startup failure without retaining a session', async () => {
    const { client, factory } = fakeSession();
    client.connect.mockRejectedValueOnce(new Error('spawn failed'));
    const connector = new OkxMcpConnector(config, factory);
    await expect(connector.connect()).rejects.toMatchObject({
      category: 'CONNECTOR_START_FAILED',
    });
    expect(connector.isConnected()).toBe(false);
    expect(client.close).toHaveBeenCalledOnce();
  });

  it('marks an unexpectedly closed transport as disconnected', async () => {
    const { factory } = fakeSession();
    const connector = new OkxMcpConnector(config, factory);
    await connector.connect();
    const transport = factory.mock.results[0]?.value
      .transport as StdioClientTransport;
    transport.onclose?.();
    expect(connector.isConnected()).toBe(false);
    await expect(
      connector.callTool('market_get_ticker', {}),
    ).rejects.toMatchObject({
      category: 'CONNECTOR_NOT_CONNECTED',
    });
  });
});

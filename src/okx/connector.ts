import { Client } from '@modelcontextprotocol/client';
import {
  StdioClientTransport,
  getDefaultEnvironment,
  type StdioServerParameters,
} from '@modelcontextprotocol/client/stdio';
import {
  OkxConnectorError,
  type OkxConnectorConfig,
  type OkxConnectorHealth,
  type OkxToolDefinition,
} from './types.js';
import { okxConnectorConfigFromEnv } from './config.js';

export interface OkxMcpV2Session {
  client: Client;
  transport: StdioClientTransport;
}

/** The exchange boundary never chooses a fallback transport or profile. */
export interface OkxConnector {
  readonly profile: 'demo' | 'live';
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  healthCheck(): Promise<OkxConnectorHealth>;
  listTools(): Promise<OkxToolDefinition[]>;
  callTool<T>(toolName: string, args: Record<string, unknown>): Promise<T>;
}

export type OkxMcpSessionFactory = (
  parameters: StdioServerParameters,
) => OkxMcpV2Session;

const defaultSessionFactory: OkxMcpSessionFactory = (parameters) => ({
  client: new Client({ name: 'aura', version: '0.0.0' }),
  transport: new StdioClientTransport(parameters),
});

const REQUIRED_MODULES = ['market', 'spot', 'account'] as const;
const FORBIDDEN_ARGUMENT_SUFFIXES = [
  'apikey',
  'secret',
  'secretkey',
  'passphrase',
  'password',
  'credential',
  'authorization',
  'authheader',
] as const;

function assertNoCredentials(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(assertNoCredentials);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      const normalizedKey = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
      if (
        FORBIDDEN_ARGUMENT_SUFFIXES.some((suffix) =>
          normalizedKey.endsWith(suffix),
        )
      ) {
        throw new OkxConnectorError(
          'CONNECTOR_PROTOCOL_ERROR',
          'Credential arguments are forbidden',
        );
      }
      assertNoCredentials(child);
    }
  }
}

function selectedProfile(config: OkxConnectorConfig): string {
  if (
    config.connectorMode !== 'mcp' ||
    (config.auraProfile !== 'demo' && config.auraProfile !== 'live')
  ) {
    throw new OkxConnectorError(
      'PROFILE_CONFIGURATION_ERROR',
      'Invalid MCP connector mode or AURA profile',
    );
  }
  const profile =
    config.auraProfile === 'demo'
      ? config.demoProfileName
      : config.liveProfileName;
  if (!profile?.trim() || !/^[A-Za-z0-9._-]+$/.test(profile)) {
    throw new OkxConnectorError(
      'PROFILE_CONFIGURATION_ERROR',
      'Selected OKX profile is missing or invalid',
    );
  }
  if (
    config.demoProfileName &&
    config.liveProfileName &&
    config.demoProfileName === config.liveProfileName
  ) {
    throw new OkxConnectorError(
      'PROFILE_CONFIGURATION_ERROR',
      'Demo and live profiles must differ',
    );
  }
  return profile;
}

function validatedModules(config: OkxConnectorConfig): string {
  const modules = new Set(config.modules);
  if (
    modules.size !== REQUIRED_MODULES.length ||
    REQUIRED_MODULES.some((module) => !modules.has(module))
  ) {
    throw new OkxConnectorError(
      'PROFILE_CONFIGURATION_ERROR',
      'MCP modules must be market,spot,account',
    );
  }
  return REQUIRED_MODULES.join(',');
}

function sanitizedEnvironment(): Record<string, string> {
  const env = getDefaultEnvironment();
  delete env.OKX_API_KEY;
  delete env.OKX_SECRET_KEY;
  delete env.OKX_PASSPHRASE;
  delete env.OKX_API_BASE_URL;
  delete env.OKX_SITE;
  return env;
}

/** Import and construction are inert. Only connect() starts the local MCP server. */
export class OkxMcpConnector implements OkxConnector {
  private session: OkxMcpV2Session | null = null;
  private connected = false;
  private toolDefinitions: OkxToolDefinition[] = [];
  private connecting: Promise<void> | null = null;

  constructor(
    readonly config: OkxConnectorConfig,
    private readonly sessionFactory: OkxMcpSessionFactory = defaultSessionFactory,
  ) {}

  static fromEnv(
    env: Readonly<Record<string, string | undefined>> = process.env,
  ): OkxMcpConnector {
    return new OkxMcpConnector(okxConnectorConfigFromEnv(env));
  }

  get profile(): 'demo' | 'live' {
    return this.config.auraProfile;
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.startConnection();
    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  private async startConnection(): Promise<void> {
    const profile = selectedProfile(this.config);
    const modules = validatedModules(this.config);
    if (!this.config.mcpCommand?.trim()) {
      throw new OkxConnectorError(
        'PROFILE_CONFIGURATION_ERROR',
        'MCP command is missing',
      );
    }
    const args = [
      '--profile',
      profile,
      '--modules',
      modules,
      this.profile === 'demo' ? '--demo' : '--live',
    ];
    let session: OkxMcpV2Session | null = null;
    try {
      session = this.sessionFactory({
        command: this.config.mcpCommand,
        args,
        env: sanitizedEnvironment(),
        stderr: 'pipe',
      });
      await session.client.connect(session.transport);
      const listing = await session.client.listTools();
      const definitions = listing.tools.map((tool) => {
        if (
          !tool.name ||
          !tool.inputSchema ||
          typeof tool.inputSchema !== 'object'
        ) {
          throw new OkxConnectorError(
            'CONNECTOR_PROTOCOL_ERROR',
            'Invalid MCP tool definition',
          );
        }
        return {
          name: tool.name,
          description: tool.description ?? null,
          inputSchema: tool.inputSchema,
        };
      });
      this.session = session;
      this.toolDefinitions = definitions;
      this.connected = true;
      const previousOnClose = session.transport.onclose;
      session.transport.onclose = () => {
        try {
          previousOnClose?.();
        } finally {
          if (this.session === session) {
            this.session = null;
            this.toolDefinitions = [];
            this.connected = false;
          }
        }
      };
    } catch (error) {
      await session?.client.close().catch(() => undefined);
      if (error instanceof OkxConnectorError) throw error;
      throw new OkxConnectorError(
        'CONNECTOR_START_FAILED',
        'OKX MCP connection or tool discovery failed',
      );
    }
  }

  async disconnect(): Promise<void> {
    if (this.connecting) await this.connecting.catch(() => undefined);
    const session = this.session;
    this.session = null;
    this.toolDefinitions = [];
    this.connected = false;
    if (!session) return;
    try {
      await session.client.close();
    } catch {
      throw new OkxConnectorError(
        'CONNECTOR_PROTOCOL_ERROR',
        'OKX MCP disconnect failed',
      );
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  async healthCheck(): Promise<OkxConnectorHealth> {
    return {
      connected: this.connected,
      profile: this.profile,
      status: this.connected ? 'HEALTHY' : 'UNAVAILABLE',
      reason: this.connected ? null : 'MCP connector is disconnected',
      timestamp: Date.now(),
    };
  }

  async listTools(): Promise<OkxToolDefinition[]> {
    if (!this.connected || !this.session) {
      throw new OkxConnectorError(
        'CONNECTOR_NOT_CONNECTED',
        'OKX MCP connector is disconnected',
      );
    }
    return [...this.toolDefinitions];
  }

  async callTool<T>(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<T> {
    if (!this.connected || !this.session) {
      throw new OkxConnectorError(
        'CONNECTOR_NOT_CONNECTED',
        'OKX MCP connector is disconnected',
      );
    }
    if (!this.toolDefinitions.some((tool) => tool.name === toolName)) {
      throw new OkxConnectorError(
        'TOOL_NOT_AVAILABLE',
        `OKX MCP tool ${toolName} is unavailable`,
      );
    }
    assertNoCredentials(args);
    try {
      const result = await this.session.client.callTool({
        name: toolName,
        arguments: args,
      });
      const rawPayload: unknown = result.structuredContent;
      const payload =
        rawPayload &&
        typeof rawPayload === 'object' &&
        !Array.isArray(rawPayload)
          ? (rawPayload as Record<string, unknown>)
          : null;
      if (result.isError || (payload && payload.ok === false)) {
        throw new OkxConnectorError(
          'TOOL_CALL_FAILED',
          `OKX MCP tool ${toolName} failed`,
        );
      }
      if (
        !payload ||
        payload.ok !== true ||
        payload.tool !== toolName ||
        !('data' in payload)
      ) {
        throw new OkxConnectorError(
          'CONNECTOR_PROTOCOL_ERROR',
          `Invalid result from OKX MCP tool ${toolName}`,
        );
      }
      return payload.data as T;
    } catch (error) {
      if (error instanceof OkxConnectorError) throw error;
      throw new OkxConnectorError(
        'TOOL_CALL_FAILED',
        `OKX MCP tool ${toolName} failed`,
      );
    }
  }
}

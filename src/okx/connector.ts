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
  type OkxMcpCallDiagnostic,
} from './types.js';
import { okxConnectorConfigFromEnv } from './config.js';
import { AtkCapabilityRegistry, type AtkCapability } from './capabilities.js';
import { AtkTraceBuffer, type AtkToolTrace } from './telemetry.js';

export interface OkxMcpV2Session {
  client: Client;
  transport: StdioClientTransport;
}

/** The exchange boundary never chooses a fallback transport or profile. */
export interface OkxConnector {
  readonly profile: 'demo' | 'live';
  readonly lane?: 'READ' | 'WRITE';
  readonly readOnly?: boolean;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  healthCheck(): Promise<OkxConnectorHealth>;
  listTools(): Promise<OkxToolDefinition[]>;
  callTool<T>(toolName: string, args: Record<string, unknown>, traceContext?: { cycleId?: string; decisionId?: string }): Promise<T>;
  getCapabilities?(): AtkCapabilityRegistry;
  getServerVersion?(): string | null;
  getRecentTraces?(): readonly AtkToolTrace[];
  callCapability?<T>(capability: AtkCapability, args: Record<string, unknown>,
    traceContext?: { cycleId?: string; decisionId?: string }): Promise<T>;
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

function diagnosticField(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const answer = String(value).replace(/[\x00-\x1f\x7f]/g, ' ').trim();
  return answer ? answer.slice(0, 180) : null;
}

function safeBusinessMessage(value: unknown): string | null {
  const message = diagnosticField(value);
  if (!message) return null;
  if (/not included in your API key.*IP whitelist/i.test(message))
    return 'Egress IP is not in the OKX API key IP whitelist';
  // Business messages are useful, but a server must not be able to echo secrets into audit.
  return /(?:api.?key|secret|passphrase|password|authorization|bearer|credential|token)/i.test(message)
    ? '[redacted]' : message;
}

function responseDiagnostic(toolName: string, isError: boolean | null,
  payload: Record<string, unknown> | null, latencyMs: number,
  fallbackText: string | null = null): OkxMcpCallDiagnostic {
  const error = payload?.error && typeof payload.error === 'object' && !Array.isArray(payload.error)
    ? payload.error as Record<string, unknown> : null;
  const dataValue = Array.isArray(payload?.data) ? payload.data[0] : payload?.data;
  const data = dataValue && typeof dataValue === 'object' && !Array.isArray(dataValue)
    ? dataValue as Record<string, unknown> : null;
  return { toolName, isError,
    exchangeCode: diagnosticField(data?.sCode ?? data?.code ?? error?.code ?? payload?.code ?? null),
    exchangeMessage: safeBusinessMessage(data?.sMsg ?? error?.message ?? payload?.msg
      ?? payload?.message ?? (typeof payload?.error === 'string' ? payload.error : null)
      ?? fallbackText),
    returnedOrderId: diagnosticField(data?.ordId ?? null),
    returnedClientOrderId: diagnosticField(data?.clOrdId ?? null),
    latencyMs, schemaParsed: payload !== null && ('ok' in payload || 'data' in payload) };
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
  const required = config.lane === 'READ' ? ['market', 'account', 'spot', ...(modules.has('news') ? ['news'] : [])]
    : config.lane === 'WRITE' ? ['spot'] : REQUIRED_MODULES;
  if (modules.size !== required.length || required.some(module => !modules.has(module))
    || (config.lane === 'READ' && config.readOnly !== true)
    || (config.lane === 'WRITE' && config.readOnly === true)) {
    throw new OkxConnectorError(
      'PROFILE_CONFIGURATION_ERROR',
      'Invalid MCP lane scope or read-only setting',
    );
  }
  return required.join(',');
}

function sanitizedEnvironment(): Record<string, string> {
  const defaults = getDefaultEnvironment();
  const env: Record<string, string> = {};
  // Keep this allowlist even though the current MCP SDK already returns only
  // these keys: a future SDK must not forward API keys to either child lane.
  for (const key of ['HOME', 'LOGNAME', 'PATH', 'SHELL', 'TERM', 'USER']) {
    const value = defaults[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/** Import and construction are inert. Only connect() starts the local MCP server. */
export class OkxMcpConnector implements OkxConnector {
  private session: OkxMcpV2Session | null = null;
  private connected = false;
  private toolDefinitions: OkxToolDefinition[] = [];
  private connecting: Promise<void> | null = null;
  private registry = new AtkCapabilityRegistry([]);
  private serverVersion: string | null = null;
  private readonly traces = new AtkTraceBuffer();
  private feeCallQueue: Promise<void> = Promise.resolve();
  private nextFeeCallAt = 0;

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
  get lane(): 'READ' | 'WRITE' { return this.config.lane ?? 'READ'; }
  get readOnly(): boolean { return this.config.readOnly === true; }
  getCapabilities(): AtkCapabilityRegistry { return this.registry; }
  getServerVersion(): string | null { return this.serverVersion; }
  getRecentTraces(): readonly AtkToolTrace[] { return this.traces.recent(); }

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
      ...(this.readOnly ? ['--read-only'] : []),
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
      this.registry = new AtkCapabilityRegistry(definitions);
      this.serverVersion = session.client.getServerVersion?.()?.version ?? null;
      this.connected = true;
      const previousOnClose = session.transport.onclose;
      session.transport.onclose = () => {
        try {
          previousOnClose?.();
        } finally {
          if (this.session === session) {
            this.session = null;
            this.toolDefinitions = [];
            this.registry = new AtkCapabilityRegistry([]);
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
    this.registry = new AtkCapabilityRegistry([]);
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

  /** OKX permits five account/trade-fee reads per two seconds per user ID. */
  private async paceFeeCall(): Promise<void> {
    const previous = this.feeCallQueue;
    let release!: () => void;
    this.feeCallQueue = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      const delay = Math.max(0, this.nextFeeCallAt - Date.now());
      if (delay > 0) await new Promise<void>(resolve => setTimeout(resolve, delay));
      this.nextFeeCallAt = Date.now() + 550;
    } finally { release(); }
  }

  /**
   * A transient exchange/API failure on the server-enforced read-only lane is retried
   * exactly once after a short pause. WRITE-lane calls are never retried: an order or
   * cancellation whose outcome is unknown must go to reconciliation, not be resent.
   */
  async callTool<T>(
    toolName: string,
    args: Record<string, unknown>,
    traceContext: { cycleId?: string; decisionId?: string } = {},
  ): Promise<T> {
    try {
      return await this.callToolOnce<T>(toolName, args, traceContext);
    } catch (error) {
      const transientRead = this.config.lane === 'READ' && this.readOnly
        && error instanceof OkxConnectorError && error.category === 'TOOL_CALL_FAILED'
        && error.diagnostic?.exchangeCode !== '50110';
      if (!transientRead) throw error;
      const rateLimited = error.diagnostic?.exchangeCode === '50011'
        || /too many requests|rate limit/i.test(error.diagnostic?.exchangeMessage ?? '');
      await new Promise<void>(resolve => setTimeout(resolve, rateLimited ? 2_100 : 400));
      return this.callToolOnce<T>(toolName, args, traceContext);
    }
  }

  private async callToolOnce<T>(
    toolName: string,
    args: Record<string, unknown>,
    traceContext: { cycleId?: string; decisionId?: string } = {},
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
    if (this.config.lane === 'READ' && !/^(market_get_|market_list_|account_get_|spot_get_|news_get_|news_search$|news_list_|event_get_|event_browse$|trade_get_|system_get_)/.test(toolName)) {
      throw new OkxConnectorError('TOOL_NOT_AVAILABLE', 'READ lane forbids state-changing MCP tools');
    }
    if (this.config.lane === 'WRITE' && !['spot_place_order', 'spot_place_algo_order',
      'spot_cancel_order', 'spot_cancel_algo_order', 'system_get_capabilities'].includes(toolName)) {
      throw new OkxConnectorError('TOOL_NOT_AVAILABLE', 'WRITE lane exposes only spot execution and capability tools');
    }
    assertNoCredentials(args);
    if (this.lane === 'READ' && this.readOnly && toolName === 'account_get_trade_fee')
      await this.paceFeeCall();
    const started = Date.now();
    let success = false;
    let errorCode: string | null = null;
    try {
      const result = await this.session.client.callTool({
        name: toolName,
        arguments: args,
      });
      let rawPayload: unknown = result.structuredContent;
      let fallbackText: string | null = null;
      if (!rawPayload && Array.isArray(result.content)) {
        const texts = result.content.filter(part => part.type === 'text');
        if (texts.length === 1 && texts[0]?.type === 'text') {
          try { rawPayload = JSON.parse(texts[0].text); }
          catch { rawPayload = null; fallbackText = texts[0].text; }
        }
      }
      const payload =
        rawPayload &&
        typeof rawPayload === 'object' &&
        !Array.isArray(rawPayload)
          ? (rawPayload as Record<string, unknown>)
          : null;
      const diagnostic = responseDiagnostic(toolName, result.isError === true,
        payload, Math.max(0, Date.now() - started), fallbackText);
      if (result.isError || (payload && payload.ok === false)) {
        throw new OkxConnectorError(
          'TOOL_CALL_FAILED',
          // The sanitized exchange code/message is the only way an operator can tell an
          // invalid live API key (5011x) from a transient exchange error.
          `OKX MCP tool ${toolName} failed${diagnostic.exchangeCode || diagnostic.exchangeMessage
            ? ` (${[diagnostic.exchangeCode, diagnostic.exchangeMessage].filter(Boolean).join(': ')})` : ''}`,
          diagnostic,
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
          diagnostic,
        );
      }
      success = true;
      return payload.data as T;
    } catch (error) {
      if (error instanceof OkxConnectorError) { errorCode = error.category; throw error; }
      errorCode = 'TOOL_CALL_FAILED';
      throw new OkxConnectorError(
        'TOOL_CALL_FAILED',
        `OKX MCP tool ${toolName} failed`,
      );
    } finally {
      this.traces.record({ timestamp: started, lane: this.lane, toolName,
        purpose: this.registry.reverse(toolName) ?? 'UNMAPPED',
        symbol: typeof args.instId === 'string' ? args.instId : null,
        profile: this.profile, latencyMs: Math.max(0, Date.now() - started), success,
        errorCode, errorMessage: errorCode ? `MCP ${errorCode}` : null,
        cycleId: traceContext.cycleId ?? null, decisionId: traceContext.decisionId ?? null });
    }
  }

  async callCapability<T>(capability: AtkCapability, args: Record<string, unknown>,
    traceContext?: { cycleId?: string; decisionId?: string }): Promise<T> {
    const toolName = this.registry.resolve(capability);
    if (!toolName) throw new OkxConnectorError('TOOL_NOT_AVAILABLE', `Missing ${capability} capability`);
    return this.callTool<T>(toolName, args, traceContext);
  }
}

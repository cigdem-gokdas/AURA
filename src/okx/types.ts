import type { MarketProfile } from '../market/types.js';

export type OkxConnectorErrorCategory =
  | 'CONNECTOR_UNAVAILABLE'
  | 'CONNECTOR_START_FAILED'
  | 'CONNECTOR_NOT_CONNECTED'
  | 'CONNECTOR_PROTOCOL_ERROR'
  | 'TOOL_NOT_AVAILABLE'
  | 'TOOL_CALL_FAILED'
  | 'PROFILE_CONFIGURATION_ERROR';

/** Profile names are identifiers managed by the local Agent Trade Kit, never secrets. */
export interface OkxConnectorConfig {
  connectorMode: 'mcp';
  mcpCommand: string;
  modules: readonly string[];
  auraProfile: MarketProfile;
  demoProfileName: string | null;
  liveProfileName: string | null;
}

export interface OkxConnectorHealth {
  connected: boolean;
  profile: MarketProfile;
  status: 'HEALTHY' | 'DEGRADED' | 'UNAVAILABLE';
  reason: string | null;
  timestamp: number;
}

export interface OkxToolDefinition {
  name: string;
  description: string | null;
  inputSchema: Readonly<Record<string, unknown>>;
}

/** Normalized result shape for a future MCP implementation. */
export interface OkxToolCallResult<T = unknown> {
  toolName: string;
  data: T;
  isError: boolean;
}

export class OkxConnectorError extends Error {
  constructor(
    readonly category: OkxConnectorErrorCategory,
    message: string,
  ) {
    super(message);
    this.name = 'OkxConnectorError';
  }
}

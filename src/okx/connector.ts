import type { Client } from '@modelcontextprotocol/client';
import type { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import {
  OkxConnectorError,
  type OkxConnectorConfig,
  type OkxConnectorHealth,
  type OkxToolDefinition,
} from './types.js';

/** v2 SDK types for the future implementation; neither is constructed here. */
export interface OkxMcpV2Session {
  client: Client;
  transport: StdioClientTransport;
}

/**
 * Production exchange boundary. Importing or constructing a connector starts nothing.
 * Only an explicit connect() may start MCP; disconnect() must close its resources.
 * Tool calls require a connection. Profiles must never fall back across demo/live,
 * and live must never fall back to CLI. Credentials stay outside this contract.
 */
export interface OkxConnector {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  healthCheck(): Promise<OkxConnectorHealth>;
  listTools(): Promise<OkxToolDefinition[]>;
  callTool<T>(toolName: string, args: Record<string, unknown>): Promise<T>;
}

/** Ticket 00A placeholder. It never constructs a client or starts a process. */
export class OkxMcpConnectorStub implements OkxConnector {
  constructor(readonly config: OkxConnectorConfig) {}

  async connect(): Promise<void> {
    throw new OkxConnectorError(
      'CONNECTOR_UNAVAILABLE',
      'MCP connection is not implemented',
    );
  }

  async disconnect(): Promise<void> {
    throw new OkxConnectorError(
      'CONNECTOR_UNAVAILABLE',
      'MCP disconnection is not implemented',
    );
  }

  isConnected(): boolean {
    return false;
  }

  async healthCheck(): Promise<OkxConnectorHealth> {
    throw new OkxConnectorError(
      'CONNECTOR_UNAVAILABLE',
      'MCP health check is not implemented',
    );
  }

  async listTools(): Promise<OkxToolDefinition[]> {
    throw new OkxConnectorError(
      'CONNECTOR_NOT_CONNECTED',
      'MCP connector is not connected',
    );
  }

  async callTool<T>(
    _toolName: string,
    _args: Record<string, unknown>,
  ): Promise<T> {
    throw new OkxConnectorError(
      'CONNECTOR_NOT_CONNECTED',
      'MCP connector is not connected',
    );
  }
}

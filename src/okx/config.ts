import { OkxConnectorError, type OkxConnectorConfig } from './types.js';

/** Parse identifiers only. The official local OKX configuration owns credentials. */
export function okxConnectorConfigFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): OkxConnectorConfig {
  const auraProfile = env.OKX_PROFILE;
  if (auraProfile !== 'demo' && auraProfile !== 'live') {
    throw new OkxConnectorError(
      'PROFILE_CONFIGURATION_ERROR',
      'OKX_PROFILE must be demo or live',
    );
  }
  if (env.OKX_CONNECTOR_MODE !== 'mcp') {
    throw new OkxConnectorError(
      'PROFILE_CONFIGURATION_ERROR',
      'OKX_CONNECTOR_MODE must be mcp',
    );
  }
  return {
    connectorMode: 'mcp',
    mcpCommand: env.OKX_MCP_COMMAND ?? 'okx-trade-mcp',
    modules: (env.OKX_MCP_MODULES ?? 'market,spot,account')
      .split(',')
      .map((part) => part.trim()),
    auraProfile,
    demoProfileName: env.OKX_DEMO_PROFILE?.trim() || null,
    liveProfileName: env.OKX_LIVE_PROFILE?.trim() || null,
  };
}

export function atkLaneConfigFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  lane: 'READ' | 'WRITE',
): OkxConnectorConfig {
  const base = okxConnectorConfigFromEnv(env);
  return { ...base, lane, readOnly: lane === 'READ',
    modules: lane === 'READ' ? ['market', 'account', 'spot', ...(env.ATK_CONTEXT_PULSE === 'true' ? ['news'] : [])] : ['spot'] };
}

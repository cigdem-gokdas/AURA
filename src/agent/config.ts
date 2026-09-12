import { openAiConfigFromEnv } from '../llm/config.js';
import { riskConfigFromEnv } from '../risk/config.js';
import type { RiskConfig } from '../risk/types.js';

export interface AgentConfig {
  symbols: readonly string[];
  profile: 'demo' | 'live';
  connectorMode: 'mcp';
  liveTradingArmed: boolean;
  primaryBar: string;
  slowLoopIntervalMs: number;
  fastLoopIntervalMs: number;
  maxReconnectAttempts: number;
  maxHoldingMs: number;
  llmConfigured: boolean;
  risk: RiskConfig;
}

export function parseSymbols(value: string | undefined): string[] {
  const symbols = (value ?? 'BTC-USDT,ETH-USDT').split(',').map(item => item.trim());
  if (!symbols.length || symbols.some(symbol => !/^[A-Z0-9]+-[A-Z0-9]+$/.test(symbol))
    || new Set(symbols).size !== symbols.length) throw new Error('SYMBOLS must be a nonempty, unique spot-symbol list');
  return symbols;
}

function positiveInteger(value: string | undefined, fallback: number, label: string): number {
  const parsed = value === undefined || value.trim() === '' ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`Invalid ${label}`);
  return parsed;
}

export function validRiskConfig(config: RiskConfig): boolean {
  const fractions = [config.maxTotalExposurePct, config.riskPerTradePct, config.maxRiskPerTradePct,
    config.maxPositionPct, config.softDrawdownPct, config.defensiveDrawdownPct,
    config.hardDailyLossPct, config.hardPeakDrawdownPct, config.maxAtrPercentile];
  const positive = [config.maxDataAgeMs, config.maxSpreadBps, config.minEdgeCostRatio,
    config.initialStopAtrMultiplier, config.breakEvenTriggerR, config.trailingActivationR, config.takeProfitR];
  return config.maxConcurrentPositions === 1 && fractions.every(x => typeof x === 'number' && Number.isFinite(x) && x > 0 && x <= 1)
    && positive.every(x => typeof x === 'number' && Number.isFinite(x) && x > 0)
    && config.riskPerTradePct <= config.maxRiskPerTradePct
    && config.softDrawdownPct < config.defensiveDrawdownPct
    && config.defensiveDrawdownPct < config.hardPeakDrawdownPct
    && Number.isFinite(config.consecutiveLossPauseMinutes)
    && config.consecutiveLossPauseMinutes >= 15 && config.consecutiveLossPauseMinutes <= 20
    && Number.isFinite(config.opportunityScoreThreshold)
    && config.opportunityScoreThreshold >= 0 && config.opportunityScoreThreshold <= 100;
}

export function agentConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const symbols = parseSymbols(env.SYMBOLS);
  if (env.OKX_CONNECTOR_MODE !== 'mcp') throw new Error('OKX_CONNECTOR_MODE must be mcp');
  if (env.OKX_PROFILE !== 'demo' && env.OKX_PROFILE !== 'live') throw new Error('OKX_PROFILE must be demo or live');
  if (env.LIVE_TRADING_ARMED !== undefined && env.LIVE_TRADING_ARMED !== 'true' && env.LIVE_TRADING_ARMED !== 'false')
    throw new Error('LIVE_TRADING_ARMED must be true or false');
  if (env.PRIMARY_BAR !== undefined && env.PRIMARY_BAR !== '3m') throw new Error('PRIMARY_BAR must be 3m');
  return {
    symbols, profile: env.OKX_PROFILE, connectorMode: 'mcp',
    liveTradingArmed: env.LIVE_TRADING_ARMED === 'true', primaryBar: '3m',
    slowLoopIntervalMs: positiveInteger(env.SLOW_LOOP_INTERVAL_MS, 180_000, 'SLOW_LOOP_INTERVAL_MS'),
    fastLoopIntervalMs: positiveInteger(env.FAST_LOOP_INTERVAL_MS ?? env.SAFETY_LOOP_MS, 7_000, 'FAST_LOOP_INTERVAL_MS'),
    maxReconnectAttempts: positiveInteger(env.MAX_RECONNECT_ATTEMPTS, 3, 'MAX_RECONNECT_ATTEMPTS'),
    maxHoldingMs: positiveInteger(env.MAX_HOLDING_MS, 86_400_000, 'MAX_HOLDING_MS'),
    llmConfigured: openAiConfigFromEnv(env) !== null, risk: riskConfigFromEnv(env),
  };
}

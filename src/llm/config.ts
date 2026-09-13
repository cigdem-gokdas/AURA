export interface OpenAiLlmConfig {
  provider: 'openai';
  model: string;
  apiKey: string;
  timeoutMs: number;
  maxOutputTokens: number;
  maxCallsPerHour: number;
  maxCallsPerDay: number;
  maxDailyCostUsd: number;
  inputUsdPerMtok: number;
  outputUsdPerMtok: number;
}

function numberFromEnv(value: string | undefined, fallback: number, positive: boolean): number | null {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(parsed) || (positive ? parsed <= 0 : parsed < 0)) return null;
  return parsed;
}

export function openAiConfigFromEnv(env: NodeJS.ProcessEnv = process.env): OpenAiLlmConfig | null {
  if (env.LLM_PROVIDER !== 'openai' || !env.LLM_MODEL?.trim() || !env.OPENAI_API_KEY?.trim()) return null;
  const timeoutMs = numberFromEnv(env.LLM_TIMEOUT_MS, 4500, true);
  const maxOutputTokens = numberFromEnv(env.LLM_MAX_OUTPUT_TOKENS, 300, true);
  const maxCallsPerHour = numberFromEnv(env.LLM_MAX_CALLS_PER_HOUR, 25, true);
  const maxCallsPerDay = numberFromEnv(env.LLM_MAX_CALLS_PER_DAY, 250, true);
  const maxDailyCostUsd = numberFromEnv(env.LLM_MAX_DAILY_COST_USD, 2, true);
  const inputUsdPerMtok = numberFromEnv(env.LLM_INPUT_USD_PER_MTOK, 0.2, false);
  const outputUsdPerMtok = numberFromEnv(env.LLM_OUTPUT_USD_PER_MTOK, 1.2, false);
  if ([timeoutMs, maxOutputTokens, maxCallsPerHour, maxCallsPerDay, maxDailyCostUsd, inputUsdPerMtok, outputUsdPerMtok].some(v => v === null)) return null;
  if (![timeoutMs, maxOutputTokens, maxCallsPerHour, maxCallsPerDay].every(Number.isInteger)) return null;
  return {
    provider: 'openai', model: env.LLM_MODEL.trim(), apiKey: env.OPENAI_API_KEY.trim(),
    timeoutMs: timeoutMs!, maxOutputTokens: maxOutputTokens!, maxCallsPerHour: maxCallsPerHour!,
    maxCallsPerDay: maxCallsPerDay!, maxDailyCostUsd: maxDailyCostUsd!,
    inputUsdPerMtok: inputUsdPerMtok!, outputUsdPerMtok: outputUsdPerMtok!,
  };
}

import { LlmBudget } from './budget.js';
import { openAiConfigFromEnv, type OpenAiLlmConfig } from './config.js';
import { buildSelectedCandidateInput, MARKET_CRITIC_INSTRUCTIONS } from './prompt.js';
import { LlmDecisionSchema, type LlmClient, type LlmDecisionResult, type SelectedCandidateContext } from './types.js';

const RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['action', 'confidence', 'regime_confirmation', 'setup_quality', 'risk_flag', 'reason', 'counter_thesis', 'memory_signal'],
  properties: {
    action: { type: 'string', enum: ['AGREE', 'DISAGREE', 'ABSTAIN'] },
    confidence: { type: 'number' },
    regime_confirmation: { type: 'string', enum: ['TRENDING_UP', 'TRENDING_DOWN', 'RANGE', 'HIGH_VOLATILITY', 'UNCERTAIN'] },
    setup_quality: { type: 'string', enum: ['A', 'B', 'C', 'D'] },
    risk_flag: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH'] },
    reason: { type: 'string' },
    counter_thesis: { type: 'string' },
    memory_signal: { type: 'string', enum: ['NONE', 'CHOP_RISK', 'REPEATED_LOSS_PATTERN', 'MOMENTUM_DECAY'] },
  },
} as const;

type JsonRecord = Record<string, unknown>;
function object(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null;
}

function validContext(context: SelectedCandidateContext): boolean {
  const { candidate, crossMarket, microstructure, position } = context;
  if (candidate.action !== 'BUY' || candidate.intent !== 'OPEN_LONG') return false;
  if (!candidate.symbol || crossMarket.selectedSymbol !== candidate.symbol || !crossMarket.otherSymbol || crossMarket.otherSymbol === candidate.symbol) return false;
  if (crossMarket.selectedOQS !== candidate.opportunityScore) return false;
  if (typeof position.hasOpenLong !== 'boolean' || (position.openLongSymbol !== null && typeof position.openLongSymbol !== 'string')) return false;
  if (![candidate.opportunityScore, candidate.edgeToCostRatio, crossMarket.otherOQS,
    microstructure.spreadBps, microstructure.obiTop5, microstructure.micropriceLeanBps,
    ...Object.values(candidate.scoreBreakdown)].every(value => typeof value === 'number' && Number.isFinite(value))) return false;
  return true;
}

function responseText(body: JsonRecord): string | null {
  if (body.status !== 'completed') return null;
  const output = body.output;
  if (!Array.isArray(output)) return null;
  const texts: string[] = [];
  for (const item of output) {
    const message = object(item);
    if (message?.type !== 'message' || !Array.isArray(message.content)) continue;
    for (const content of message.content) {
      const part = object(content);
      if (part?.type === 'output_text' && typeof part.text === 'string') texts.push(part.text);
    }
  }
  return texts.length === 1 ? texts[0]! : null;
}

function tokenCounts(body: JsonRecord): { input: number; output: number } | null {
  const usage = object(body.usage);
  const input = usage?.input_tokens;
  const output = usage?.output_tokens;
  if (!Number.isSafeInteger(input) || !Number.isSafeInteger(output) || (input as number) < 0 || (output as number) < 0) return null;
  return { input: input as number, output: output as number };
}

function recommendsOtherSymbol(text: string, otherSymbol: string): boolean {
  const escaped = otherSymbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b(?:trade|buy|sell|choose|switch to|prefer)\\s+${escaped}\\b`, 'i').test(text);
}

export interface OpenAiClientDependencies {
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** No network work occurs at construction. Each evaluation makes at most one fetch. */
export class OpenAiLlmClient implements LlmClient {
  readonly budget: LlmBudget | null;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly config: OpenAiLlmConfig | null, dependencies: OpenAiClientDependencies = {}) {
    this.budget = config ? new LlmBudget(config) : null;
    this.fetchImpl = dependencies.fetchImpl ?? fetch;
    this.now = dependencies.now ?? Date.now;
  }

  async evaluateSelectedCandidate(context: SelectedCandidateContext): Promise<LlmDecisionResult> {
    const config = this.config;
    if (!config || config.provider !== 'openai' || !config.model || !config.apiKey || !this.budget) return { status: 'CONFIG_ERROR' };
    if (!validContext(context)) return { status: 'CONFIG_ERROR' };

    const input = buildSelectedCandidateInput(context, [config.apiKey]);
    const requestBody = JSON.stringify({
      model: config.model,
      instructions: MARKET_CRITIC_INSTRUCTIONS,
      input,
      store: false,
      reasoning: { effort: 'none' },
      text: { format: { type: 'json_schema', name: 'aura_market_critic', strict: true, schema: RESPONSE_SCHEMA } },
      max_output_tokens: config.maxOutputTokens,
    });
    const started = this.now();
    const estimatedInputTokens = Math.ceil((MARKET_CRITIC_INSTRUCTIONS.length + input.length) / 4);
    const reservation = this.budget.reserve(started, estimatedInputTokens);
    if (reservation === null) return { status: 'BUDGET_EXCEEDED' };

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = Symbol('timedOut');
    const timeout = new Promise<typeof timedOut>(resolve => {
      timer = setTimeout(() => { controller.abort(); resolve(timedOut); }, config.timeoutMs);
    });
    let body: JsonRecord | null;
    let latencyMs: number;
    try {
      const outcome = await Promise.race([
        this.fetchImpl('https://api.openai.com/v1/responses', {
          method: 'POST',
          headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
          body: requestBody,
          signal: controller.signal,
        }),
        timeout,
      ]);
      if (outcome === timedOut) return { status: 'TIMEOUT', latencyMs: this.now() - started };
      if (!outcome.ok) return { status: 'HTTP_ERROR', latencyMs: this.now() - started };
      let parsedBody: unknown;
      try { parsedBody = await Promise.race([outcome.json(), timeout]); }
      catch { return { status: controller.signal.aborted ? 'TIMEOUT' : 'MALFORMED_RESPONSE', latencyMs: this.now() - started }; }
      if (parsedBody === timedOut) return { status: 'TIMEOUT', latencyMs: this.now() - started };
      body = object(parsedBody);
      latencyMs = this.now() - started;
    } catch {
      return { status: controller.signal.aborted ? 'TIMEOUT' : 'UNREACHABLE', latencyMs: this.now() - started };
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (!body) return { status: 'MALFORMED_RESPONSE', latencyMs };
    const counts = tokenCounts(body);
    if (!counts) return { status: 'MALFORMED_RESPONSE', latencyMs };
    const usage = this.budget.record(reservation, counts.input, counts.output);
    if (this.budget.snapshot(started).estimatedCostUsdToday > config.maxDailyCostUsd + 1e-12) return { status: 'BUDGET_EXCEEDED', latencyMs };
    const content = responseText(body);
    if (!content) return { status: 'MALFORMED_RESPONSE', latencyMs };
    let parsed: unknown;
    try { parsed = JSON.parse(content); }
    catch { return { status: 'MALFORMED_RESPONSE', latencyMs }; }
    const decision = LlmDecisionSchema.safeParse(parsed);
    if (!decision.success) return { status: 'SCHEMA_INVALID', latencyMs };
    if (recommendsOtherSymbol(`${decision.data.reason} ${decision.data.counter_thesis}`, context.crossMarket.otherSymbol)) return { status: 'SCHEMA_INVALID', latencyMs };
    return { status: 'SUCCESS', decision: decision.data, latencyMs, usage };
  }
}

export function createLlmClient(env: NodeJS.ProcessEnv = process.env, dependencies: OpenAiClientDependencies = {}): LlmClient {
  return new OpenAiLlmClient(openAiConfigFromEnv(env), dependencies);
}

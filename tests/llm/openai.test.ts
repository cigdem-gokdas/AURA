import { describe, expect, it, vi } from 'vitest';
import { createLlmClient, OpenAiLlmClient } from '../../src/llm/openai.js';
import { openAiConfigFromEnv } from '../../src/llm/config.js';
import type { LlmDecision, SelectedCandidateContext } from '../../src/llm/types.js';
import type { CandidateSignal } from '../../src/signal/types.js';

const env = {
  LLM_PROVIDER: 'openai', LLM_MODEL: 'gpt-5.6-luna', OPENAI_API_KEY: 'top-secret-key',
  LLM_TIMEOUT_MS: '50', LLM_MAX_OUTPUT_TOKENS: '300',
  LLM_MAX_CALLS_PER_HOUR: '25', LLM_MAX_CALLS_PER_DAY: '250',
  LLM_MAX_DAILY_COST_USD: '2', LLM_INPUT_USD_PER_MTOK: '1', LLM_OUTPUT_USD_PER_MTOK: '2',
};

const baseDecision: LlmDecision = {
  action: 'AGREE', confidence: 0.8, regime_confirmation: 'TRENDING_UP',
  setup_quality: 'A', risk_flag: 'LOW', reason: 'Coherent setup',
  counter_thesis: 'Broad move may fade', memory_signal: 'NONE',
};

function context(symbol = 'BTC-USDT', other = 'ETH-USDT'): SelectedCandidateContext {
  const candidate: CandidateSignal = {
    symbol, action: 'BUY', intent: 'OPEN_LONG', setupType: 'TREND_CONTINUATION',
    regime: 'TRENDING_UP', opportunityScore: 78,
    scoreBreakdown: {
      regimeStructure: 15, momentumOrReversion: 12, volumeQuality: 10,
      orderBookImbalance: 10, micropriceQuality: 10, spreadQuality: 11,
      dataQuality: 10, total: 78,
    },
    estimatedMoveBps: 30, estimatedRoundTripCostBps: 10,
    edgeToCostRatio: 3, clearsEstimatedCosts: true,
    bullEvidence: ['trend'], bearEvidence: ['possible fade'],
    reasons: ['ranked winner'], rejectionCategories: [], timestamp: 1_000,
  };
  return {
    candidate,
    crossMarket: { selectedSymbol: symbol, selectedOQS: 78, otherSymbol: other, otherOQS: 65, otherRegime: 'RANGE' },
    microstructure: { spreadBps: 2, obiTop5: 0.2, micropriceLeanBps: 1 },
    position: { hasOpenLong: false, openLongSymbol: null },
    recentMemory: [],
  };
}

function response(decision: unknown = baseDecision, inputTokens = 100, outputTokens = 50): Response {
  return new Response(JSON.stringify({
    status: 'completed',
    output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(decision) }] }],
    usage: { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: inputTokens + outputTokens },
  }), { status: 200 });
}

function mockedClient(result: Response = response()) {
  const fetchImpl = vi.fn(async () => result);
  const client = createLlmClient(env, { fetchImpl: fetchImpl as unknown as typeof fetch });
  return { client, fetchImpl };
}

describe('OpenAI market critic', () => {
  it('defaults the critic timeout to 4500ms while honoring explicit overrides', () => {
    expect(openAiConfigFromEnv({ ...env, LLM_TIMEOUT_MS: undefined })?.timeoutMs).toBe(4500);
    expect(openAiConfigFromEnv(env)?.timeoutMs).toBe(50);
  });
  it.each(['AGREE', 'DISAGREE', 'ABSTAIN'] as const)('accepts valid %s', async action => {
    const { client, fetchImpl } = mockedClient(response({ ...baseDecision, action }));
    const result = await client.evaluateSelectedCandidate(context());
    expect(result.status).toBe('SUCCESS');
    if (result.status === 'SUCCESS') {
      expect(result.decision.action).toBe(action);
      expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 50, totalTokens: 150, estimatedCostUsd: 0.0002 });
    }
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('uses Responses structured output, low latency settings, no storage, and no sizing fields', async () => {
    const { client, fetchImpl } = mockedClient();
    await client.evaluateSelectedCandidate(context());
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/responses');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ model: 'gpt-5.6-luna', store: false, reasoning: { effort: 'none' } });
    expect(body.text.format.type).toBe('json_schema');
    expect(body.text.format.strict).toBe(true);
    expect(body.text.format.schema.additionalProperties).toBe(false);
    expect(Object.keys(body.text.format.schema.properties).sort()).toEqual(Object.keys(baseDecision).sort());
    expect(body).not.toHaveProperty('tools');
    expect(JSON.stringify(body)).not.toContain('top-secret-key');
    expect(body.input).not.toMatch(/quantity|notional|takeProfit|stopPrice/);
    expect(Object.keys(client)).not.toContain('sizePosition');
  });

  it.each([['BTC-USDT', 'ETH-USDT'], ['ETH-USDT', 'BTC-USDT']])('keeps %s selected with %s as context only', async (selected, other) => {
    const { client, fetchImpl } = mockedClient();
    await client.evaluateSelectedCandidate(context(selected, other));
    const body = JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    const input = JSON.parse(body.input);
    expect(input.selectedCandidate.symbol).toBe(selected);
    expect(input.crossMarket).toEqual({ selectedSymbol: selected, selectedOQS: 78, otherSymbol: other, otherOQS: 65, otherRegime: 'RANGE' });
    expect(body.instructions).toMatch(/never suggest trading it instead/i);
    expect(body.instructions).toMatch(/never.*change.*symbol/i);
    expect(input.selectedCandidate).not.toHaveProperty('quantity');
  });

  it('rejects replacement symbols, invalid fields, and out-of-range confidence', async () => {
    for (const decision of [
      { ...baseDecision, replacementSymbol: 'ETH-USDT' },
      { ...baseDecision, confidence: 1.2 },
      { ...baseDecision, reason: 'x'.repeat(281) },
      { ...baseDecision, reason: 'Trade ETH-USDT instead' },
    ]) {
      const { client } = mockedClient(response(decision));
      expect((await client.evaluateSelectedCandidate(context())).status).toBe('SCHEMA_INVALID');
    }
  });

  it('rejects HOLD, mismatched selected symbol, and no valid configuration before fetch', async () => {
    const { client, fetchImpl } = mockedClient();
    const hold = context();
    hold.candidate = { ...hold.candidate, action: 'HOLD', intent: 'NONE' };
    expect((await client.evaluateSelectedCandidate(hold)).status).toBe('CONFIG_ERROR');
    const mismatch = context();
    mismatch.crossMarket = { ...mismatch.crossMarket, selectedSymbol: 'ETH-USDT' };
    expect((await client.evaluateSelectedCandidate(mismatch)).status).toBe('CONFIG_ERROR');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect((await createLlmClient({ ...env, OPENAI_API_KEY: '' }).evaluateSelectedCandidate(context())).status).toBe('CONFIG_ERROR');
  });

  it('returns fail-closed statuses for malformed JSON, absent output, HTTP failure, and network failure without retries', async () => {
    const cases: [() => Promise<Response>, string][] = [
      [async () => new Response('not json'), 'MALFORMED_RESPONSE'],
      [async () => new Response(JSON.stringify({ status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 1 } })), 'MALFORMED_RESPONSE'],
      [async () => new Response('error', { status: 503 }), 'HTTP_ERROR'],
      [async () => { throw new Error('network unavailable'); }, 'UNREACHABLE'],
    ];
    for (const [implementation, expected] of cases) {
      const fetchImpl = vi.fn(implementation);
      const client = createLlmClient(env, { fetchImpl: fetchImpl as unknown as typeof fetch });
      expect((await client.evaluateSelectedCandidate(context())).status).toBe(expected);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it('times out even if fetch ignores abort, with one request', async () => {
    const fetchImpl = vi.fn(() => new Promise<Response>(() => {}));
    const client = createLlmClient({ ...env, LLM_TIMEOUT_MS: '5' }, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect((await client.evaluateSelectedCandidate(context())).status).toBe('TIMEOUT');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('enforces hourly, daily, and cost budgets and accounts actual tokens', async () => {
    let now = 1_000_000_000;
    const fetchImpl = vi.fn(async () => response());
    const config = openAiConfigFromEnv({ ...env, LLM_MAX_CALLS_PER_HOUR: '1', LLM_MAX_CALLS_PER_DAY: '2' });
    const client = new OpenAiLlmClient(config, { fetchImpl: fetchImpl as unknown as typeof fetch, now: () => now });
    expect((await client.evaluateSelectedCandidate(context())).status).toBe('SUCCESS');
    expect((await client.evaluateSelectedCandidate(context())).status).toBe('BUDGET_EXCEEDED');
    now += 3_600_001;
    expect((await client.evaluateSelectedCandidate(context())).status).toBe('SUCCESS');
    expect((await client.evaluateSelectedCandidate(context())).status).toBe('BUDGET_EXCEEDED');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(client.budget?.snapshot(now)).toMatchObject({ inputTokens: 200, outputTokens: 100 });

    const costConfig = openAiConfigFromEnv({ ...env, LLM_MAX_DAILY_COST_USD: '0.0011' });
    const costClient = new OpenAiLlmClient(costConfig, { fetchImpl: fetchImpl as unknown as typeof fetch, now: () => now });
    expect((await costClient.evaluateSelectedCandidate(context())).status).toBe('SUCCESS');
    expect((await costClient.evaluateSelectedCandidate(context())).status).toBe('BUDGET_EXCEEDED');
  });

  it('bounds recent memory, redacts secrets, and never sends position quantity', async () => {
    const selected = context();
    selected.candidate = { ...selected.candidate, bullEvidence: ['Authorization: secret-token', 'sk-ABCDEF1234567890', 'top-secret-key', 'trend'] };
    selected.recentMemory = Array.from({ length: 12 }, (_, i) => ({
      symbol: 'BTC-USDT', setupType: 'TREND_CONTINUATION' as const, regime: 'TRENDING_UP' as const,
      resultCategory: 'ACCEPTED' as const, outcomeR: i, stopHit: false, timestamp: i,
    }));
    (selected.position as object as Record<string, unknown>).quantity = 42;
    const { client, fetchImpl } = mockedClient();
    await client.evaluateSelectedCandidate(selected);
    const body = JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    const input = JSON.parse(body.input);
    expect(input.selectedCandidate.recentMemory).toHaveLength(5);
    expect(input.selectedCandidate.recentMemory.map((item: { timestamp: number }) => item.timestamp)).toEqual([11, 10, 9, 8, 7]);
    expect(body.input).not.toContain('secret-token');
    expect(body.input).not.toContain('sk-ABCDEF1234567890');
    expect(body.input).not.toContain('top-secret-key');
    expect(body.input).not.toContain('quantity');
    expect(body.input).not.toContain('42');
  });

  it('keeps confidence as validation-only output with no sizing API', async () => {
    const { client } = mockedClient(response({ ...baseDecision, confidence: 0.01 }));
    const result = await client.evaluateSelectedCandidate(context());
    expect(result.status).toBe('SUCCESS');
    if (result.status === 'SUCCESS') expect(Object.keys(result.decision).sort()).toEqual(Object.keys(baseDecision).sort());
    expect(client).not.toHaveProperty('sizePosition');
    expect(client).not.toHaveProperty('execute');
  });
});

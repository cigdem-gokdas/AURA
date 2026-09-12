import type { OpenAiLlmConfig } from './config.js';
import type { LlmTokenUsage } from './types.js';

interface CallRecord { at: number; reservedUsd: number; actualUsd: number | null }

/** Instance-local accounting. Reserve before fetch so concurrent calls obey limits. */
export class LlmBudget {
  private readonly calls: CallRecord[] = [];
  private inputTokens = 0;
  private outputTokens = 0;

  constructor(private readonly config: OpenAiLlmConfig) {}

  reserve(at: number, estimatedInputTokens: number): number | null {
    const dayStart = Math.floor(at / 86_400_000) * 86_400_000;
    const daily = this.calls.filter(call => call.at >= dayStart && call.at < dayStart + 86_400_000);
    const hourly = this.calls.filter(call => call.at > at - 3_600_000 && call.at <= at);
    const estimatedUsd = this.cost(estimatedInputTokens, this.config.maxOutputTokens);
    if (hourly.length >= this.config.maxCallsPerHour || daily.length >= this.config.maxCallsPerDay) return null;
    if (daily.reduce((sum, call) => sum + (call.actualUsd ?? call.reservedUsd), 0) + estimatedUsd > this.config.maxDailyCostUsd + 1e-12) return null;
    this.calls.push({ at, reservedUsd: estimatedUsd, actualUsd: null });
    return this.calls.length - 1;
  }

  record(index: number, inputTokens: number, outputTokens: number): LlmTokenUsage {
    const estimatedCostUsd = this.cost(inputTokens, outputTokens);
    const call = this.calls[index];
    if (call) call.actualUsd = estimatedCostUsd;
    this.inputTokens += inputTokens;
    this.outputTokens += outputTokens;
    return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, estimatedCostUsd };
  }

  snapshot(at: number) {
    const dayStart = Math.floor(at / 86_400_000) * 86_400_000;
    const daily = this.calls.filter(call => call.at >= dayStart && call.at < dayStart + 86_400_000);
    return {
      callsToday: daily.length,
      callsLastHour: this.calls.filter(call => call.at > at - 3_600_000 && call.at <= at).length,
      estimatedCostUsdToday: daily.reduce((sum, call) => sum + (call.actualUsd ?? call.reservedUsd), 0),
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
    };
  }

  private cost(input: number, output: number): number {
    return (input * this.config.inputUsdPerMtok + output * this.config.outputUsdPerMtok) / 1_000_000;
  }
}

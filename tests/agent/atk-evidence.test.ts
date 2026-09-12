import { describe, expect, it } from 'vitest';
import { AtkCapabilityRegistry } from '../../src/okx/capabilities.js';
import type { OkxConnector } from '../../src/okx/connector.js';
import { compareIndicator, ContextPulseCache, crossCheckIndicators, fetchPairEvidence } from '../../src/agent/atk-evidence.js';
import { DecisionProvenanceBuffer, traceNode } from '../../src/agent/provenance.js';
import type { FeatureSnapshot } from '../../src/features/types.js';

const feature: FeatureSnapshot = { symbol: 'BTC-USDT', timestamp: 1000, close: 100,
  bestBid: 99, bestAsk: 101, midPrice: 100, emaFast: 100, emaSlow: 99, adx: 30,
  atr: 2, atrPct: 0.02, atrPctPercentile: 0.5, volume: 1, volumeSma20: 1,
  return5: 0.01, zScore20: 1, obiTop5: 0.1, spreadBps: 2,
  microprice: 100, micropriceLeanBps: 0, dataAgeMs: 0 };
const definition = (name: string) => ({ name, description: null, inputSchema: { type: 'object' } });

function connector(names: string[], values: Record<string, unknown> = {}): OkxConnector {
  const registry = new AtkCapabilityRegistry(names.map(definition));
  return { profile: 'demo', lane: 'READ', readOnly: true,
    connect: async () => {}, disconnect: async () => {}, isConnected: () => true,
    healthCheck: async () => ({ connected: true, profile: 'demo', status: 'HEALTHY', reason: null, timestamp: 1000 }),
    listTools: async () => names.map(definition), getCapabilities: () => registry,
    callTool: async <T>(name: string, args: Record<string, unknown>) => {
      const key = name === 'market_get_indicator' ? String(args.indicator) : name;
      return values[key] as T;
    } };
}

describe('optional ATK evidence', () => {
  it('classifies match, minor, large, and unavailable indicator differences', () => {
    expect(compareIndicator('BTC-USDT', 'EMA9', 100, 100.1).status).toBe('MATCH');
    expect(compareIndicator('BTC-USDT', 'EMA9', 100, 101).status).toBe('MINOR_DIVERGENCE');
    expect(compareIndicator('BTC-USDT', 'EMA9', 100, 110).status).toBe('LARGE_DIVERGENCE');
    expect(compareIndicator('BTC-USDT', 'EMA9', 100, null).status).toBe('UNAVAILABLE');
  });

  it('cross-checks local indicators through discovered read tools without replacing local values', async () => {
    const read = connector(['market_get_indicator'], { ema: { data: [{ value: 100.1 }] },
      atr: { data: [{ value: 2.02 }] }, adx: { data: [{ value: 35 }] } });
    const checks = await crossCheckIndicators(read, feature);
    expect(checks.map(item => item.status)).toEqual(['MATCH', 'MINOR_DIVERGENCE', 'LARGE_DIVERGENCE']);
    expect(feature.emaFast).toBe(100);
  });

  it('treats missing pair, indicator, and news capabilities as non-fatal', async () => {
    const read = connector([]);
    expect((await crossCheckIndicators(read, feature)).every(item => item.status === 'UNAVAILABLE')).toBe(true);
    expect((await fetchPairEvidence(read, 'BTC-USDT', 'ETH-USDT', 1000)).status).toBe('UNAVAILABLE');
    expect(await new ContextPulseCache(false).get(read, ['BTC-USDT', 'ETH-USDT'], 1000)).toBeNull();
    expect(await new ContextPulseCache(true).get(read, ['BTC-USDT', 'ETH-USDT'], 1000)).toMatchObject({
      newsShock: 'UNAVAILABLE', sentiment: 'UNAVAILABLE', macroEventSoon: null });
  });

  it('bounds provenance and preserves actual READ/WRITE tool identities', () => {
    const paths = new DecisionProvenanceBuffer(2);
    for (let i = 0; i < 3; i += 1) {
      const read = traceNode({ timestamp: i, lane: 'READ', toolName: 'market_get_ticker',
        purpose: 'MARKET_TICKER', symbol: 'BTC-USDT', profile: 'demo', latencyMs: 2,
        success: true, errorCode: null, errorMessage: null, cycleId: null, decisionId: null });
      paths.record({ cycleId: String(i), timestamp: i, selectedSymbol: 'BTC-USDT',
        result: i === 2 ? 'ALLOW' : 'REJECT', nodes: i === 2 ? [read, traceNode({
          timestamp: i, lane: 'WRITE', toolName: 'spot_place_order', purpose: 'SPOT_PLACE_ORDER',
          symbol: 'BTC-USDT', profile: 'demo', latencyMs: 3, success: true,
          errorCode: null, errorMessage: null, cycleId: String(i), decisionId: String(i),
        })] : [read] });
    }
    expect(paths.recent()).toHaveLength(2);
    expect(paths.recent()[0]?.nodes.some(node => node.lane === 'WRITE')).toBe(false);
    expect(paths.latest()?.nodes.map(node => node.toolName)).toEqual(['market_get_ticker', 'spot_place_order']);
  });
});

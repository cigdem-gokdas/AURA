/** Read-only candle study; historical books and LLM decisions are unavailable. */
import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { calculateFeatures, MIN_FEATURE_CANDLES } from '../src/features/calculate.js';
import type { Candle, OrderBookSnapshot } from '../src/market/types.js';
import { OkxMarketAdapter } from '../src/market/okx-market-adapter.js';
import { AtkReadClient } from '../src/okx/lanes.js';
import { initialRegimeState, transitionRegime } from '../src/regime/classify.js';
import { riskConfigFromEnv } from '../src/risk/config.js';
import type { OpenPosition } from '../src/monitor/types.js';
import { activateTrailing, hardStopBreached, promoteBreakEven, takeProfitReference,
  timeStopReached, updateAtrTrailingStop } from '../src/monitor/protection.js';

const BAR_MS = 180_000;
const MAX_CANDLES = 500;
type Setup = 'TREND_CONTINUATION' | 'RANGE_MEAN_REVERSION';
type Exit = 'STOPPED_OUT' | 'TAKE_PROFIT' | 'TIME_STOP' | 'REGIME_INVALIDATED';
type Risk = ReturnType<typeof riskConfigFromEnv>;
interface Trade { symbol: string; setup: Setup; entryAt: number; exitAt: number;
  entryPrice: number; exitPrice: number; exitReason: Exit; realizedMoveBps: number; realizedR: number }
interface SimPosition { position: OpenPosition; setup: Setup }

function olderRows(value: unknown, symbol: string): Candle[] {
  if (!value || typeof value !== 'object' || !('data' in value) || !Array.isArray(value.data))
    throw new Error(`Invalid historical candle envelope: ${symbol}`);
  return value.data.map((row: unknown) => {
    if (!Array.isArray(row) || row.length < 6) throw new Error(`Invalid historical candle: ${symbol}`);
    const numericRow = row.slice(0, 6).map(Number) as [number, number, number, number, number, number];
    const [timestamp, open, high, low, close, volume] = numericRow;
    if (!Number.isSafeInteger(timestamp) || timestamp < 1_000_000_000_000
      || ![open, high, low, close, volume].every(Number.isFinite)
      || open <= 0 || close <= 0 || low <= 0 || high < Math.max(open, close, low)
      || low > Math.min(open, close, high) || volume < 0)
      throw new Error(`Invalid historical candle values: ${symbol}`);
    return { symbol, timestamp, open, high, low, close, volume };
  });
}

async function fetchCandles(client: AtkReadClient, market: OkxMarketAdapter,
  symbol: string, now: number): Promise<Candle[]> {
  const recent = await market.getCandles(symbol, '3m', 300);
  if (!recent.length) return [];
  const oldest = Math.min(...recent.map(row => row.timestamp));
  const older = olderRows(await client.callTool('market_get_candles', {
    instId: symbol, bar: '3m', limit: 200, after: String(oldest), demo: client.profile === 'demo',
  }), symbol);
  const rows = [...new Map([...older, ...recent].map(row => [row.timestamp, row])).values()]
    .filter(row => row.timestamp + BAR_MS <= now).sort((a, b) => a.timestamp - b.timestamp)
    .slice(-MAX_CANDLES);
  for (let i = 1; i < rows.length; i += 1)
    if (rows[i]!.timestamp - rows[i - 1]!.timestamp !== BAR_MS)
      throw new Error(`Gap in ${symbol} 3m candles`);
  return rows;
}

function featuresAt(symbol: string, candles: readonly Candle[], i: number) {
  const close = candles[i]!.close;
  // Only candle-derived fields are used; the neutral book is never historical evidence.
  const book: OrderBookSnapshot = { symbol, timestamp: candles[i]!.timestamp + BAR_MS,
    bids: [{ price: close, size: 1 }], asks: [{ price: close, size: 1 }] };
  return calculateFeatures(symbol, { candles: candles.slice(Math.max(0, i - 299), i + 1), orderBook: book },
    book.timestamp);
}

function entry(symbol: string, setup: Setup, price: number, atr: number, time: number, risk: Risk): SimPosition {
  const distance = atr * risk.initialStopAtrMultiplier;
  const stop = price - distance;
  if (!(distance > 0 && stop > 0)) throw new Error(`Invalid simulated stop: ${symbol}`);
  const plan = { symbol, initialStopPrice: stop, stopDistanceAbsolute: distance,
    stopDistanceFraction: distance / price, breakEvenTriggerR: risk.breakEvenTriggerR,
    trailingActivationR: risk.trailingActivationR, takeProfitR: risk.takeProfitR,
    protectionMode: 'CLIENT_SIDE' as const };
  return { setup, position: { symbol, quantity: 1, weightedAverageEntryPrice: price,
    markPrice: price, referencePrice: price, realizedPnl: 0, unrealizedPnl: 0,
    tradePerformanceComplete: true, entryFeeBalance: 0, riskCapital: distance,
    openedAt: time, updatedAt: time, protectionPlan: plan, protectionMode: 'CLIENT_SIDE',
    protection: { mode: 'CLIENT_SIDE', initialStopPrice: stop, currentStopPrice: stop,
      takeProfitPrice: price + distance * risk.takeProfitR, breakEvenActivated: false,
      trailingActivated: false, lastUpdatedAt: time } } };
}

function summary(trades: readonly Trade[]) {
  const wins = trades.filter(t => t.realizedMoveBps > 0);
  const losses = trades.filter(t => t.realizedMoveBps < 0);
  const mean = (items: readonly Trade[], key: 'realizedMoveBps' | 'realizedR') => items.length
    ? items.reduce((sum, t) => sum + t[key], 0) / items.length : null;
  return { trades: trades.length, winRate: trades.length ? wins.length / trades.length : null,
    averageSignedMoveBps: mean(trades, 'realizedMoveBps'),
    averageFavorableMoveBps: mean(wins, 'realizedMoveBps'),
    averageWinBps: mean(wins, 'realizedMoveBps'), averageLossBps: mean(losses, 'realizedMoveBps'),
    averageR: mean(trades, 'realizedR'),
    exits: Object.fromEntries((['STOPPED_OUT', 'TAKE_PROFIT', 'TIME_STOP', 'REGIME_INVALIDATED'] as const)
      .map(reason => [reason, trades.filter(t => t.exitReason === reason).length])) };
}

function replay(symbol: string, candles: readonly Candle[], risk: Risk, maxHoldingMs: number) {
  const trades: Trade[] = [];
  let regimeState = initialRegimeState(symbol);
  let held: SimPosition | null = null;
  let pending: { setup: Setup; atr: number } | null = null;
  let setupSignals = 0;
  for (let i = MIN_FEATURE_CANDLES - 1; i < candles.length; i += 1) {
    const bar = candles[i]!;
    const closeTime = bar.timestamp + BAR_MS;
    if (pending) { held = entry(symbol, pending.setup, bar.open, pending.atr, bar.timestamp, risk); pending = null; }
    const f = featuresAt(symbol, candles, i);
    const transition = transitionRegime(symbol, f, regimeState);
    regimeState = transition.nextState;
    const regime = transition.decision.stableRegime;
    if (held) {
      let p = held.position;
      let exitPrice: number | null = null;
      let exitReason: Exit | null = null;
      // Stop-first if a candle spans both stop and target; gap-down at open.
      if (bar.low <= p.protection.currentStopPrice || hardStopBreached(symbol, p, bar.open)) {
        exitPrice = Math.min(bar.open, p.protection.currentStopPrice); exitReason = 'STOPPED_OUT';
      } else if (bar.high >= takeProfitReference(symbol, p)) {
        exitPrice = takeProfitReference(symbol, p); exitReason = 'TAKE_PROFIT';
      } else {
        // Protection updates use only the completed bar close and apply to the next bar.
        p = promoteBreakEven(symbol, p, bar.close, closeTime);
        p = activateTrailing(symbol, p, bar.close, closeTime);
        if (p.protection.trailingActivated)
          p = updateAtrTrailingStop(symbol, p, bar.close, f.atr, risk.initialStopAtrMultiplier, closeTime);
        held.position = p;
        if (timeStopReached(symbol, p, closeTime, maxHoldingMs)) {
          exitPrice = bar.close; exitReason = 'TIME_STOP';
        } else if (regime === 'TRENDING_DOWN' || regime === 'HIGH_VOLATILITY') {
          exitPrice = bar.close; exitReason = 'REGIME_INVALIDATED';
        }
      }
      if (exitPrice !== null && exitReason !== null) {
        const entryPrice = p.weightedAverageEntryPrice;
        trades.push({ symbol, setup: held.setup, entryAt: p.openedAt, exitAt: closeTime,
          entryPrice, exitPrice, exitReason,
          realizedMoveBps: (exitPrice - entryPrice) / entryPrice * 10_000,
          realizedR: (exitPrice - entryPrice) / p.protectionPlan.stopDistanceAbsolute });
        held = null;
      }
    }
    if (!held && i + 1 < candles.length) {
      const setup: Setup | null = regime === 'TRENDING_UP' && f.return5 > 0 && f.emaFast > f.emaSlow
        ? 'TREND_CONTINUATION' : regime === 'RANGE' && f.zScore20 < -1.25
          ? 'RANGE_MEAN_REVERSION' : null;
      if (setup) { pending = { setup, atr: f.atr }; setupSignals += 1; }
    }
  }
  return { symbol, candleCount: candles.length,
    window: { first: new Date(candles[0]!.timestamp).toISOString(),
      lastClosed: new Date(candles.at(-1)!.timestamp + BAR_MS).toISOString() },
    setupSignals, censoredOpenTrade: held !== null, summary: summary(trades), trades };
}

async function main(): Promise<void> {
  const state = JSON.parse(await readFile('.aura/status.json', 'utf8')) as { functional?: { symbols?: string[] } };
  const symbols = state.functional?.symbols;
  if (!symbols?.length || new Set(symbols).size !== symbols.length
    || symbols.some(symbol => !/^[A-Z0-9]+-USDT$/.test(symbol)))
    throw new Error('No valid tracked universe in passive status snapshot');
  const risk = riskConfigFromEnv(process.env);
  const maxHoldingMs = Number(process.env.MAX_HOLDING_MS ?? 86_400_000);
  if (!Number.isSafeInteger(maxHoldingMs) || maxHoldingMs <= 0) throw new Error('Invalid MAX_HOLDING_MS');
  const client = new AtkReadClient(process.env);
  await client.connect();
  try {
    const market = new OkxMarketAdapter(client);
    const now = Date.now();
    const results = [];
    for (const symbol of symbols) {
      const candles = await fetchCandles(client, market, symbol, now);
      results.push(candles.length < MIN_FEATURE_CANDLES + 1
        ? { symbol, error: `Only ${candles.length} closed candles` }
        : replay(symbol, candles, risk, maxHoldingMs));
    }
    const trades = results.flatMap(item => 'trades' in item ? item.trades : []);
    process.stdout.write(`${JSON.stringify({ methodology: 'CANDLE_ONLY_SETUP_EXIT_DIAGNOSTIC',
      limitations: ['No historical order book, spread, OBI, microprice, OQS, LLM, or portfolio gates',
        'Next-bar-open entries; stop-first ambiguous bars; gross moves exclude fees and slippage',
        'Open positions at window end are censored'],
      profile: client.profile, bar: '3m', maxCandlesPerSymbol: MAX_CANDLES,
      maxHoldingMs, symbols, combined: summary(trades), results }, null, 2)}\n`);
  } finally { await client.disconnect(); }
}

void main().catch(error => { process.stderr.write(`Read-only backtest failed: ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1; });

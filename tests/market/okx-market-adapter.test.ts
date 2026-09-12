import { describe, expect, it } from 'vitest';
import type { OkxConnector } from '../../src/okx/connector.js';
import type {
  OkxConnectorHealth,
  OkxToolDefinition,
} from '../../src/okx/types.js';
import { OkxConnectorError } from '../../src/okx/types.js';
import { OkxMarketAdapter } from '../../src/market/okx-market-adapter.js';

const toolNames = [
  'market_get_ticker',
  'market_get_candles',
  'market_get_orderbook',
  'market_get_instruments',
  'account_get_trade_fee',
  'account_get_balance',
  'spot_get_orders',
  'spot_get_fills',
];

function envelope(data: unknown) {
  return {
    endpoint: '/api/v5/example',
    requestTime: '2026-09-12T00:00:00Z',
    data,
  };
}

class FakeConnector implements OkxConnector {
  readonly calls: { name: string; args: Record<string, unknown> }[] = [];
  connected = true;
  available = [...toolNames];
  responses = new Map<string, (args: Record<string, unknown>) => unknown>();

  constructor(readonly profile: 'demo' | 'live' = 'demo') {}
  async connect() {
    this.connected = true;
  }
  async disconnect() {
    this.connected = false;
  }
  isConnected() {
    return this.connected;
  }
  async healthCheck(): Promise<OkxConnectorHealth> {
    return {
      connected: this.connected,
      profile: this.profile,
      status: this.connected ? 'HEALTHY' : 'UNAVAILABLE',
      reason: null,
      timestamp: 1,
    };
  }
  async listTools(): Promise<OkxToolDefinition[]> {
    if (!this.connected)
      throw new OkxConnectorError('CONNECTOR_NOT_CONNECTED', 'Disconnected');
    return this.available.map((name) => ({
      name,
      description: null,
      inputSchema: {},
    }));
  }
  async callTool<T>(name: string, args: Record<string, unknown>): Promise<T> {
    if (!this.connected)
      throw new OkxConnectorError('CONNECTOR_NOT_CONNECTED', 'Disconnected');
    this.calls.push({ name, args });
    const response = this.responses.get(name);
    if (!response)
      throw new OkxConnectorError('TOOL_CALL_FAILED', 'Missing fake response');
    return response(args) as T;
  }
}

function ticker(symbol: string, last = '100') {
  return envelope([
    { instId: symbol, bidPx: '99', askPx: '101', last, ts: '1789171200000' },
  ]);
}

describe('OkxMarketAdapter', () => {
  it('normalizes BTC and ETH tickers and safely interleaves BTC → ETH → BTC', async () => {
    const connector = new FakeConnector();
    connector.responses.set('market_get_ticker', ({ instId }) =>
      ticker(String(instId), instId === 'ETH-USDT' ? '200' : '100'),
    );
    const adapter = new OkxMarketAdapter(connector);
    expect((await adapter.getTicker('BTC-USDT')).last).toBe(100);
    expect((await adapter.getTicker('ETH-USDT')).last).toBe(200);
    expect((await adapter.getTicker('BTC-USDT')).last).toBe(100);
    expect(connector.calls.map(({ args }) => args)).toEqual([
      { instId: 'BTC-USDT', demo: true },
      { instId: 'ETH-USDT', demo: true },
      { instId: 'BTC-USDT', demo: true },
    ]);
    expect((await adapter.getTicker('BTC-USDT')).timestamp).toBe(1789171200000);
  });

  it('uses live market data only when the injected connector is live', async () => {
    const connector = new FakeConnector('live');
    connector.responses.set('market_get_ticker', ({ instId }) =>
      ticker(String(instId)),
    );
    await new OkxMarketAdapter(connector).getTicker('ETH-USDT');
    expect(connector.calls[0]?.args).toEqual({
      instId: 'ETH-USDT',
      demo: false,
    });
  });

  it('normalizes candles, order book, and instrument metadata', async () => {
    const connector = new FakeConnector();
    connector.responses.set('market_get_candles', () =>
      envelope([['1789171200000', '100', '105', '98', '102', '42']]),
    );
    connector.responses.set('market_get_orderbook', () =>
      envelope([
        {
          bids: [['99', '2', '0', '1']],
          asks: [['101', '3', '0', '1']],
          ts: '1789171200001',
        },
      ]),
    );
    connector.responses.set('market_get_instruments', ({ instId }) =>
      envelope([
        {
          instId,
          minSz: '0.00001',
          lotSz: '0.00001',
          tickSz: '0.1',
        },
      ]),
    );
    const adapter = new OkxMarketAdapter(connector);
    expect(await adapter.getCandles('BTC-USDT', '3m', 1)).toEqual([
      {
        symbol: 'BTC-USDT',
        timestamp: 1789171200000,
        open: 100,
        high: 105,
        low: 98,
        close: 102,
        volume: 42,
      },
    ]);
    expect(await adapter.getOrderBook('ETH-USDT', 5)).toEqual({
      symbol: 'ETH-USDT',
      bids: [{ price: 99, size: 2 }],
      asks: [{ price: 101, size: 3 }],
      timestamp: 1789171200001,
    });
    expect(await adapter.getInstrumentMeta('BTC-USDT')).toEqual({
      symbol: 'BTC-USDT',
      instrumentId: 'BTC-USDT',
      minOrderSize: 0.00001,
      quantityStep: 0.00001,
      tickSize: 0.1,
    });
    expect(connector.calls.map(({ name }) => name)).toEqual([
      'market_get_candles',
      'market_get_orderbook',
      'market_get_instruments',
    ]);
    expect(connector.calls[2]?.args).toEqual({
      instType: 'SPOT',
      instId: 'BTC-USDT',
      demo: true,
    });
  });

  it.each([1789213220408, '1789213220408'])(
    'normalizes a fresh millisecond order-book timestamp from %s',
    async rawTimestamp => {
      const connector = new FakeConnector();
      connector.responses.set('market_get_orderbook', () => envelope([{ bids: [['99', '2']],
        asks: [['101', '3']], ts: rawTimestamp }]));
      const result = await new OkxMarketAdapter(connector).getOrderBook('BTC-USDT', 5);
      expect(result.timestamp).toBe(1789213220408);
      expect(1789213220432 - result.timestamp).toBe(24);
    },
  );

  it.each([undefined, null, '', 'bad', '1789213220'])(
    'rejects missing, invalid, or seconds-scale order-book timestamp %s',
    async rawTimestamp => {
      const connector = new FakeConnector();
      connector.responses.set('market_get_orderbook', () => envelope([{ bids: [['99', '2']],
        asks: [['101', '3']], ts: rawTimestamp }]));
      await expect(new OkxMarketAdapter(connector).getOrderBook('BTC-USDT', 5))
        .rejects.toThrow('Invalid order book timestamp');
    },
  );

  it('normalizes spot fees, trading balances, open orders, and recent fills', async () => {
    const connector = new FakeConnector();
    connector.responses.set('account_get_trade_fee', () =>
      envelope([{ maker: '-0.0008', taker: '-0.001' }]),
    );
    connector.responses.set('account_get_balance', () =>
      envelope([
        {
          totalEq: '1000',
          uTime: '1789171200002',
          details: [{ ccy: 'USDT', eq: '1000', availBal: '800' }],
        },
      ]),
    );
    connector.responses.set('spot_get_orders', ({ instId }) =>
      envelope([
        {
          instId,
          ordId: 'order-1',
          clOrdId: 'client-1',
          side: 'buy',
          state: 'live',
          sz: '0.5',
          accFillSz: '0',
          px: '100',
          uTime: '1789171200003',
        },
      ]),
    );
    connector.responses.set('spot_get_fills', ({ instId }) =>
      envelope([
        {
          instId,
          fillId: 'fill-1',
          ordId: 'order-1',
          side: 'buy',
          fillSz: '0.2',
          fillPx: '100',
          fee: '-0.01',
          feeCcy: 'USDT',
          ts: '1789171200004',
        },
      ]),
    );
    const adapter = new OkxMarketAdapter(connector);
    expect(await adapter.getSpotFeeRate('BTC-USDT')).toEqual({
      symbol: 'BTC-USDT',
      makerRate: -0.0008,
      takerRate: -0.001,
    });
    expect(await adapter.getTradingBalanceSnapshot()).toEqual({
      totalEquityUsd: 1000,
      balances: [{ currency: 'USDT', equity: 1000, available: 800 }],
      timestamp: 1789171200002,
    });
    expect(await adapter.getOpenSpotOrders('ETH-USDT')).toEqual([
      {
        symbol: 'ETH-USDT',
        orderId: 'order-1',
        clientOrderId: 'client-1',
        side: 'buy',
        state: 'live',
        quantity: 0.5,
        filledQuantity: 0,
        price: 100,
        timestamp: 1789171200003,
      },
    ]);
    expect(await adapter.getRecentSpotFills('BTC-USDT')).toEqual([
      {
        symbol: 'BTC-USDT',
        fillId: 'fill-1',
        orderId: 'order-1',
        side: 'buy',
        quantity: 0.2,
        price: 100,
        fee: -0.01,
        feeCurrency: 'USDT',
        timestamp: 1789171200004,
      },
    ]);
    expect(connector.calls.map(({ args }) => args)).toEqual([
      { instType: 'SPOT', instId: 'BTC-USDT' },
      {},
      { status: 'open', instId: 'ETH-USDT' },
      { instId: 'BTC-USDT', archive: false },
    ]);
  });

  it('discovers tools and clearly rejects missing required capabilities', async () => {
    const connector = new FakeConnector();
    connector.available = connector.available.filter(
      (name) => name !== 'market_get_ticker',
    );
    connector.responses.set('market_get_ticker', () => ticker('BTC-USDT'));
    await expect(
      new OkxMarketAdapter(connector).getTicker('BTC-USDT'),
    ).rejects.toMatchObject({ category: 'TOOL_NOT_AVAILABLE' });
    expect(connector.calls).toHaveLength(0);
  });

  it('rejects malformed envelopes, invalid prices, quantities, and mismatched symbols', async () => {
    const connector = new FakeConnector();
    const adapter = new OkxMarketAdapter(connector);
    for (const bad of [
      {
        data: [
          {
            instId: 'BTC-USDT',
            bidPx: '99',
            askPx: '101',
            last: '100',
            ts: '1789171200000',
          },
        ],
      },
      envelope([
        {
          instId: 'BTC-USDT',
          bidPx: 'NaN',
          askPx: '101',
          last: '100',
          ts: '1789171200000',
        },
      ]),
      envelope([
        {
          instId: 'ETH-USDT',
          bidPx: '99',
          askPx: '101',
          last: '100',
          ts: '1789171200000',
        },
      ]),
      envelope([
        {
          instId: 'BTC-USDT',
          bidPx: '99',
          askPx: 'Infinity',
          last: '100',
          ts: '1789171200000',
        },
      ]),
    ]) {
      connector.responses.set('market_get_ticker', () => bad);
      await expect(adapter.getTicker('BTC-USDT')).rejects.toMatchObject({
        category: 'CONNECTOR_PROTOCOL_ERROR',
      });
    }
    connector.responses.set('spot_get_fills', () =>
      envelope([
        {
          instId: 'BTC-USDT',
          fillId: 'fill',
          ordId: 'order',
          side: 'buy',
          fillSz: '-1',
          fillPx: '100',
          fee: '0',
          feeCcy: 'USDT',
          ts: '1789171200000',
        },
      ]),
    );
    await expect(adapter.getRecentSpotFills('BTC-USDT')).rejects.toMatchObject({
      category: 'CONNECTOR_PROTOCOL_ERROR',
    });
  });

  it('surfaces MCP tool failure and disconnect cleanly', async () => {
    const connector = new FakeConnector();
    const adapter = new OkxMarketAdapter(connector);
    connector.responses.set('market_get_ticker', () => {
      throw new OkxConnectorError('TOOL_CALL_FAILED', 'Tool failed');
    });
    expect(await adapter.checkMarketReachable('BTC-USDT')).toBe(false);
    await expect(adapter.getTicker('BTC-USDT')).rejects.toMatchObject({
      category: 'TOOL_CALL_FAILED',
    });
    await connector.disconnect();
    expect(await adapter.checkConnectorAvailable()).toBe(false);
    await expect(adapter.getTicker('BTC-USDT')).rejects.toMatchObject({
      category: 'CONNECTOR_NOT_CONNECTED',
    });
  });
});

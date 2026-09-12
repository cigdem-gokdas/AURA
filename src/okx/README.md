# OKX connector boundary

AURA uses the official OKX Agent Trade Kit MCP server as its primary production exchange connector. The expected local server command is `okx-trade-mcp`, with intended production modules `market,spot,account`.

- **Market:** ticker, candles, order book, and instrument information.
- **Spot:** order placement, fills and order history, and conditional/OCO protection when supported.
- **Account:** balances, fees, and reconciliation information.

The production `OkxMcpConnector` uses the MCP v2 TypeScript client over stdio. Importing or constructing it starts nothing; `connect()` launches the selected local profile with exactly those three modules, discovers tools, and `disconnect()` closes the session. Demo adds `--demo`; live adds `--live`. Missing profile identifiers fail before process startup. Tool calls while disconnected are rejected. There is no CLI fallback or demo-to-live fallback.

With locally installed Agent Trade Kit MCP server 1.4.6, read-only demo discovery exposed these tools used by `OkxMarketAdapter`:

| Capability          | MCP tool                 |
| ------------------- | ------------------------ |
| Ticker              | `market_get_ticker`      |
| Candles             | `market_get_candles`     |
| Order book          | `market_get_orderbook`   |
| Instrument metadata | `market_get_instruments` |
| Spot fee rate       | `account_get_trade_fee`  |
| Trading balance     | `account_get_balance`    |
| Open spot orders    | `spot_get_orders`        |
| Recent spot fills   | `spot_get_fills`         |

The adapter checks tool availability before each read and rejects malformed OKX envelopes or domain values. The market tools receive an explicit demo flag from the selected connector profile. No order-placement path is implemented in this ticket.

The OKX CLI may be used later for diagnostics only. OKX API credentials belong in the official Agent Trade Kit local configuration, never in AURA source code, project `.env`, or LLM prompts. AURA refers only to profile/config identifiers.

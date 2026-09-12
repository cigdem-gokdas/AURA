# OKX connector boundary

AURA uses the official OKX Agent Trade Kit MCP server as its primary production exchange connector. The expected local server command is `okx-trade-mcp`, with intended production modules `market,spot,account`.

- **Market:** ticker, candles, order book, and instrument information.
- **Spot:** order placement, fills and order history, and conditional/OCO protection when supported.
- **Account:** balances, fees, and reconciliation information.

Ticket 00A defines only the `OkxConnector` boundary and inert stub. Ticket 01 will implement the actual MCP v2 client over stdio and the market adapter. Importing this module or constructing the stub starts nothing. A future implementation may connect only after an explicit `connect()`, must close resources on `disconnect()`, and must reject tool calls while disconnected. Live never falls back to CLI, and demo never falls back to live.

The OKX CLI may be used later for diagnostics only. OKX API credentials belong in the official Agent Trade Kit local configuration, never in AURA source code, project `.env`, or LLM prompts. AURA refers only to profile/config identifiers.

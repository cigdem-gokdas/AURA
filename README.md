# AURA

AURA is a TypeScript scaffold for a small-liquid-universe opportunity selector. The initial tracked universe is `BTC-USDT,ETH-USDT`. Markets are observed independently, but the agent may hold at most **one** concurrent spot position across the entire universe. This is not a diversification bot.

This repository currently contains types, configuration contracts, a strict LLM response schema, and a static dashboard shell. Agent commands are intentionally non-functional. There is no market access, indicator calculation, strategy, LLM request, risk decision, exchange execution, autonomous trading, or backtesting behavior.

## Setup

Requires Node.js 22 and npm.

```sh
npm install
cp .env.example .env
npm run typecheck
npm test
npm run dev:web
```

The `.env.example` values are illustrative and contain no credentials. `SYMBOLS` is a comma-separated configuration value; the typed runtime config represents it as `string[]`. Runtime parsing and validation are future work.

`agent:preflight`, `agent:calibrate`, `agent:demo-smoke`, and `agent:run` target explicit, non-functional stubs in `src/main.ts`. `scripts/backtest.ts` is a TODO placeholder.

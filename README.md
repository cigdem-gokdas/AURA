# AURA

AURA selects a daily liquid USDT spot universe through the read-only ATK lane and manages at most the configured number of AURA-owned positions (default 3). Exchange wallet inventory without AURA ownership evidence is not an active AURA trade.

## Setup

Requires Node.js 22 and npm.

```sh
npm install
cp .env.example .env
npm run typecheck
npm test
npm run agent:preflight
```

## Operator controls

To start live trading, the launch environment must explicitly contain **both** required values; all normal preflight, risk, and protection gates still apply:

```sh
OKX_PROFILE=live LIVE_TRADING_ARMED=true npm run agent:run
```

`agent:run` builds and starts the read-only dashboard before the trading loops. It logs `AURA dashboard: http://127.0.0.1:8787` and `AURA dashboard stream: ws://127.0.0.1:8787/stream` by default. Set `AURA_DASHBOARD_PORT` to use another loopback port. If the dashboard cannot bind, the agent does not start its trading loops.

From a second terminal in this project directory, disarm new entries while leaving existing protective monitoring active:

```sh
npm run agent:disarm
```

To latch the kill switch, block new BUY submissions and immediately request a deterministic protective-exit cycle for managed positions:

```sh
npm run agent:kill
```

The control commands acknowledge the latch, not an exchange fill. Check AURA reconciliation and position state to confirm closure. An ambiguous in-flight order remains subject to the existing no-blind-retry rule. The local control socket defaults to `.aura/agent-control.sock` (mode `0600`); set the same `AURA_CONTROL_SOCKET_PATH` for the running agent and the second-terminal command if overriding it. Disarm and kill are one-way for that process. To rearm, stop the agent and launch a new `agent:run` with both live values and a successful preflight. Editing `.env` does not change a running process.

For a read-only live preflight with arming disabled:

```sh
OKX_PROFILE=live LIVE_TRADING_ARMED=false npm run agent:preflight
```

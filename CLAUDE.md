# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What AURA is

A single-position spot opportunity selector for OKX. It tracks a small universe (default `BTC-USDT,ETH-USDT`), evaluates every symbol independently each cycle, deterministically ranks one entry candidate, has an LLM "market critic" validate (never choose) that candidate, runs a deterministic risk gate, and executes via the official OKX Agent Trade Kit (ATK) MCP server. At most **one** open position across the whole universe, long-only (`FLAT ↔ LONG`).

The root `README.md` is stale: it still describes the agent commands as non-functional stubs. They are fully implemented in `src/main.ts` and `src/agent/agent.ts`. Trust the code and the per-module READMEs (`src/okx/README.md`, `src/signal/README.md`, `src/status-mcp/README.md`) over the root README.

## Commands

```sh
npm run typecheck                       # tsc --noEmit (strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes)
npm test                                # vitest run --root ., all tests under tests/
npm test -- tests/risk/evaluate.test.ts             # one file
npx vitest run --root . -t "stale"                  # by test name
npm run test:watch

npm run agent:preflight                 # read-only exchange + config checks; exit 0 on PASS
npm run agent:calibrate                 # signal calibration diagnostics as JSON (no trading)
npm run agent:demo-smoke                # one real demo-profile order round-trip (see gating below)
npm run agent:run                       # preflight, then slow/fast loops until SIGINT/SIGTERM

npm run status:mcp                      # read-only MCP server over .aura/status.json
node --import tsx src/dashboard/server.ts           # dashboard HTTP+WS on 127.0.0.1:8787 (no npm script)
npm run dev:web                         # Vite dev server for web/; expects dashboard on :8787
npx vite build --config vite.config.ts  # produces web/dist, which the dashboard server serves
```

There is no ESLint config. Prettier (`singleQuote`, `trailingComma: all`) is the only formatter; much of `src/agent` and `src/execution` is written in a dense style and not Prettier-formatted, so don't reformat files you aren't otherwise changing.

Tests are plain Vitest with no vitest config file, colocated under `tests/<module>/` mirroring `src/<module>/`. Always pass `--root .` (or go through `npm test --`): `vite.config.ts` sets `root: 'web'`, so a bare `npx vitest` finds zero tests. Tests inject fakes through constructor dependency objects (`AgentDependencies`, `OkxMcpSessionFactory`) rather than module mocks. `tests/agent/agent.test.ts` is the reference for wiring a fake connector/market/execution/LLM around `AuraAgent`.

## Runtime configuration

Everything comes from `.env` (loaded via `dotenv/config` in `src/main.ts`); copy `.env.example`. Parsing is strict and fail-closed in `src/agent/config.ts`, `src/okx/config.ts`, `src/risk/config.ts`, `src/llm/config.ts`. Notable hard constraints:

- `OKX_CONNECTOR_MODE` must be `mcp`; `OKX_PROFILE` must be `demo` or `live`; `PRIMARY_BAR` must be `3m`.
- `MAX_CONCURRENT_POSITIONS` must be `1`; `CONSECUTIVE_LOSS_PAUSE_MINUTES` must be 15–20; drawdown thresholds must be strictly ordered soft < defensive < hard peak.
- `LIVE_TRADING_ARMED=true` plus `OKX_PROFILE=live` is the only path to `LIVE_READY`/`LIVE`. `agent:demo-smoke` requires the *literal* `LIVE_TRADING_ARMED=false` (an omitted value is refused) and `OKX_PROFILE=demo`.
- OKX credentials never live in this repo or `.env`. They belong to the local ATK configuration; AURA only passes profile identifiers (`OKX_DEMO_PROFILE` / `OKX_LIVE_PROFILE`). `src/okx/connector.ts` rejects any tool argument whose key looks like a credential.

## Architecture

### Three processes, one writer

1. **Trading process** (`src/main.ts` → `AuraAgent`). Owns two independent ATK MCP stdio child processes:
   - `AtkReadClient` (`src/okx/lanes.ts`): modules `market,account,spot` with server-enforced `--read-only`, plus `news` if `ATK_CONTEXT_PULSE=true`. Used by `OkxMarketAdapter` and `atk-evidence.ts`.
   - `AtkWriteClient`: module `spot` only. Handed **only** to `OkxExecutionEngine`. Nothing else may hold a write-capable connector.
   
   Both lanes are checked for health/profile match before any cycle proceeds. The agent publishes a redacted `JudgeSnapshot` to `.aura/status.json` (atomic tmp+rename, 0600) and appends to `.aura/audit.jsonl`.
2. **Status MCP** (`src/status-mcp/server.ts`) and **dashboard** (`src/dashboard/server.ts` + `web/`) are separate read-only processes that only read those two files. They never import the connector, engine, or agent. Keep it that way.

### Slow-cycle decision pipeline (`AuraAgent.runSlowCycle`)

Order matters and is deliberately fail-closed at every step:

1. Both lanes healthy → `reconcilePending()` (any in-flight order blocks the cycle).
2. If a position is held → `monitorHeld()` only; no new evaluation.
3. `getStartupSnapshot()` and `assertFlatExchange()` before ranking.
4. Per symbol: `calculateFeatures` → `transitionRegime` (hysteresis state kept per symbol in `agent.regimes`) → `generateCandidate` (pure, per-symbol; see `src/signal/README.md` for OQS formula). Audit events `MARKET_ACCEPTED`, `FEATURES_COMPUTED`, `REGIME_DECISION`, `CANDIDATE` emitted per symbol.
5. `rankEntryCandidates` picks exactly one. Selection is **deterministic and local**; the LLM never sees the choice as changeable.
6. Optional ATK evidence in parallel (`Promise.allSettled`): indicator cross-checks, pair spread, news pulse. Failures degrade to `UNAVAILABLE`, never block.
7. `LlmClient.evaluateSelectedCandidate` returns `AGREE | DISAGREE | ABSTAIN` under a strict zod schema (`src/llm/types.ts`). Prompt input is whitelisted field-by-field in `src/llm/prompt.ts` and secret-scrubbed; position size is intentionally absent. Budget/timeouts enforced in `src/llm/budget.ts`.
8. Second `getStartupSnapshot()` + `assertFlatExchange()`, then `evaluateEntryRisk` (`src/risk/evaluate.ts`) produces a `RiskCertificate` with named gates. The LLM result is re-validated at this boundary regardless of what the adapter returned. Quantity is rounded to instrument lot step and risk is re-run with the rounded notional.
9. Final flat-exchange check, then `submit()` → `OkxExecutionEngine.submitApprovedOrder`. Every cycle ends by recording a `DecisionProvenance` and publishing the snapshot.

The **fast cycle** (`runFastCycle`, default 7s) only does lane health, pending-order reconciliation, held-position protection (`src/monitor/protection.ts`: hard stop, break-even, ATR trailing, take-profit, time stop, regime invalidation) and reconnection. It never opens positions.

### State machine

`BOOTING → PREFLIGHT → OBSERVE_ONLY | LIVE_READY → LIVE`, with `DEGRADED` (recoverable, bounded by `MAX_RECONNECT_ATTEMPTS`) and `HALTED` (terminal). `OBSERVE_ONLY` runs the full evaluation pipeline but stops before the LLM call. `degrade(reason)` is the universal error path; any thrown error in a cycle lands there.

### Ownership and recovery

`AgentRecoveryStore` (`src/agent/recovery.ts`) keeps one replaceable checkpoint at `AURA_RECOVERY_STATE_PATH`. On startup it reconciles the checkpoint against exchange balances, open orders, and recent fills. AURA's own orders are identifiable by client order ids matching `^aura\d+_\d+$`. Spot holdings not backed by a checkpoint are **unmanaged inventory**: reported, never risk-gated, never sold. Any ambiguity throws `OwnershipAmbiguityError` and blocks trading until a human reconciles. `DemoSmokeRecoveryStore` (`<recovery path>.smoke`) is a separate marker; a leftover marker blocks startup.

### Capability discovery, not hardcoded tool names

`AtkCapabilityRegistry` (`src/okx/capabilities.ts`) maps semantic capabilities (`MARKET_TICKER`, `SPOT_PLACE_ORDER`, `SPOT_CONDITIONAL_PROTECTION`, …) to tool names from each lane's `tools/list`, with schema checks for protection order types. `REQUIRED_READ_CAPABILITIES` / `REQUIRED_WRITE_CAPABILITIES` gate preflight. Call through `callCapability`, not raw names, in new code.

### Telemetry and audit

Every MCP call is recorded as an `AtkToolTrace` (no arguments or payloads, only tool name, lane, latency, success, error code) in a bounded `AtkTraceBuffer`. Traces flow into `DecisionProvenance` nodes and `ATK_MCP_CALL` audit events. `redactAudit` in `src/memory/audit.ts` is applied to both the audit log and the status snapshot; run anything new through it before it touches disk.

## Invariants to preserve when changing code

- The LLM validates one already-selected candidate. It must never select, size, stop, or execute. Don't widen `SelectedCandidateContext` with anything that would let it.
- Only `OkxExecutionEngine` touches the write lane. Don't pass `AtkWriteClient` anywhere else.
- Risk is deterministic and independent of the LLM; a `SUCCESS/AGREE` only permits the risk gate to run.
- Every exchange read must be freshness-checked (`maxDataAgeMs`) and profile-matched. Fail closed on stale, malformed, or cross-profile data.
- `demoSmoke` is an infrastructure experiment, not a trade path. Its gating (demo profile on both lanes, `verifyDemoRuntime`, flat ownership, explicit arm flag false) must stay intact.
- Status MCP and dashboard remain read-only file consumers with no exchange or agent dependency.
- Development so far has been ticket-by-ticket (see `git log`); module READMEs and JSDoc comments frequently say "not in this ticket" or "contract only." Check the implementation before assuming a comment about missing behavior is still true.

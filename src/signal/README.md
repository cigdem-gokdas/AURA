# Signal rules

`generateCandidate(symbol, features, regime, position, cost, config)` is pure and operates on one explicit symbol. It proposes spot `FLAT ↔ LONG` actions only. A `SELL` closes a long whose position symbol matches the supplied symbol. A long in another symbol does not change this per-symbol proposal; portfolio limits belong to risk and loop code.

Entry setups are trend continuation (`TRENDING_UP`, positive five-bar return, fast EMA above slow EMA) and range mean reversion (`RANGE`, z-score below −1.25). An OBI at or below −0.25 vetoes a `BUY`. Volume, milder OBI, and microprice lean affect quality, not eligibility. These order-book features are not guarantees of future price direction.

The opportunity quality score (OQS) sums seven bounded components:

| Component             | Formula                                                                                | Maximum |
| --------------------- | -------------------------------------------------------------------------------------- | ------: |
| Regime structure      | 30 for uptrend, 26 for range, otherwise 0                                              |      30 |
| Momentum or reversion | Uptrend: clamp(10 + return5 × 10,000 / 20); range: clamp(10 + (−zScore20 − 1.25) × 10) |      20 |
| Volume quality        | clamp((volume / volumeSma20 − 0.5) × 10); 0 when SMA is 0                              |      10 |
| Order-book imbalance  | clamp(5 + 10 × OBI)                                                                    |      10 |
| Microprice quality    | clamp(5 + micropriceLeanBps / 2)                                                       |      10 |
| Spread quality        | clamp(10 − spreadBps / 2)                                                              |      10 |
| Data quality          | clamp(10 × (1 − dataAgeMs / maxDataAgeMs))                                             |      10 |

Each clamp uses 0 and the component maximum. All constants apply equally to every symbol.

For an eligible trend or range setup, the favorable-move planning horizon is `ATR bps × INITIAL_STOP_ATR_MULTIPLIER × TAKE_PROFIT_R` (37.5 bps for a 10 bps ATR, 1.5 ATR stop, and 2.5R target). This represents the configured whole-trade target and is not a forecast or guaranteed outcome. Exits and non-setups use zero entry move. Round-trip cost is `2 × feeBpsPerSide + 2 × estimatedSlippageBpsPerSide + spreadBps`. Edge/cost is planned favorable move divided by cost; zero cost fails closed with ratio zero. A `BUY` needs a setup, no same-symbol long, OBI above −0.25, OQS at least 65, and edge/cost at least 1.3 by default. Deterministic exits bypass entry gates.

`rankEntryCandidates` returns a sorted copy of `BUY`/`OPEN_LONG` proposals: descending OQS, then descending edge/cost, then lexical symbol. It does not choose how many positions to open. `summarizeSignalCalibration` reports sorted OQS and edge/cost samples, counts, and rejection categories per symbol and for the combined universe. It never tunes thresholds.

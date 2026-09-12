# AURA jury presentation — presenter guide

The five-slide deck is designed for 3–5 minutes without a live dashboard. Slide 3 is a **representative static product view**. It does not depict a historical decision, filled order, return or PnL.

## SLIDE 1

**Title:** Explainable autonomous trading agent  
**Purpose:** Establish functional utility and the product's bounded authority model.  
**On-slide copy:** One risk budget across BTC-USDT and ETH-USDT. Compare → Critique → Authorize. AI can reason; it cannot directly move capital.  
**Visual specification:** Warm ivory hero with a three-step product flow and no stock imagery.  
**Speaker notes:** “AURA compares two liquid spot markets for one managed risk budget. The Market Critic can challenge a setup, but the deterministic Risk Engine alone can approve an order. Every action has an evidence trail.”

## SLIDE 2

**Title:** From market evidence to action  
**Purpose:** Explain the decision pipeline and separation of LLM reasoning from capital authority.  
**On-slide copy:** OKX ATK MCP → Features + Regime → Opportunity Ranking → Market Critic → Risk Certificate → MCP Execution → Protection → Reconciliation. LLM critiques; Risk Engine vetoes; provenance explains.  
**Visual specification:** Two-row, native PowerPoint pipeline with the Risk Certificate emphasized.  
**Speaker notes:** “OKX ATK supplies market and account evidence. AURA computes features such as EMA, ATR, ADX, spread and order-book imbalance, then compares BTC and ETH. The LLM only critiques. Risk approval is deterministic. Ambiguous exchange outcomes are reconciled, never blindly retried.”

## SLIDE 3

**Title:** AURA Intelligence Desk  
**Purpose:** Substitute for the live demo and show the user experience in a single glance.  
**On-slide copy:** Opportunity Board: BTC-USDT and ETH-USDT waiting; one position maximum. Decision Provenance: market → features → ranking → critic → risk → execution. Market Critic: awaiting a selected setup. Risk Certificate: HOLD / no proposal. ATK MCP Trace: read calls visible, no write call in this illustrative state. Position / Protection: flat. Ask AURA / Status MCP: explains why no trade was sent.  
**Visual specification:** A large, dark institutional dashboard composition fills most of the slide. The opportunity comparison, causal path and MCP trace occupy the main reading column. Critic, risk, position and read-only explanation form the right column. The status bar shows observe-only mode. Footer labels the image as a representative product view with no historical trade or performance claim.  
**Speaker notes:** “This static desk replaces our live demo. Start at the Opportunity Board: AURA compares BTC and ETH but has one risk budget. The causal path shows what would be recorded for a completed cycle. The Critic challenges the selected thesis; the Risk Certificate decides whether execution is allowed. The trace reveals which ATK calls supplied evidence and whether the write lane was used. Position and protection are explicit, and Ask AURA explains a hold from structured state. This is a representative observe-only view, not a fabricated result.”

## SLIDE 4

**Title:** Separate authority, visible evidence  
**Purpose:** Demonstrate MCP integration depth and system reliability.  
**On-slide copy:** READ MCP process: market, account, spot reads; server-level read-only. AURA: features, Critic, Risk Certificate. WRITE MCP process: spot execution only, ExecutionEngine access. One managed position; no blind retry; ambiguity requires reconciliation. Unmanaged inventory remains separate.  
**Visual specification:** Three-part editable architecture diagram with the Risk Certificate inside AURA and an explicit read/write boundary.  
**Speaker notes:** “AURA is an OKX ATK MCP client on two separate lanes. Only ExecutionEngine has write authority. AURA also exposes its own read-only Status MCP so an external client can inspect state without gaining trading authority. Unrelated BTC or ETH wallet holdings are not counted as AURA-managed positions. Unresolved execution or protection state fails closed.”

## SLIDE 5

**Title:** Explainable autonomy with limits  
**Purpose:** Close on differentiation without unsupported performance claims.  
**On-slide copy:** Bounded AI. Deterministic safety. Explainable autonomy. BTC + ETH, OKX ATK MCP, Risk Certificate, Decision Provenance, read/write isolation. “AURA is designed to know when to trade, when not to trade, and to explain both.”  
**Visual specification:** Three strong blocks and one concise proof strip.  
**Speaker notes:** “AURA's distinction is a clear authority boundary. The LLM reasons but cannot trade; risk rules decide; the product can explain approvals and rejections. We do not claim verified live profitability. New live entries remain blocked until exchange-side protection is verified end to end.”

## 45-second opening pitch

“AURA is an explainable trading agent built on the OKX Agent Trade Kit. It compares BTC-USDT and ETH-USDT for a single managed risk budget. It can use an LLM as a Market Critic, but that LLM has no path to the trading write lane and cannot override the deterministic Risk Engine. The result is a product that shows the evidence behind a decision, the reason risk allowed or refused it, and the MCP calls that supported it. Our core idea is simple: AI can reason about a trade without having unrestricted authority to place one. When exchange or protection evidence is ambiguous, AURA stops and asks for reconciliation.”

## 15-second closing statement

“AURA combines bounded AI, deterministic risk and a visible audit trail. It is built to explain both the trades it takes and the trades it refuses. That discipline is the product.”

## 60-second walkthrough of Slide 3

“The Opportunity Board compares BTC and ETH, but permits only one AURA-managed position. In this representative observe-only state, neither has a published eligible setup. Beneath it, Decision Provenance shows the stages AURA records when a cycle completes. The ATK trace exposes actual categories of READ calls and makes the absence of a WRITE call visible. On the right, the Market Critic would challenge the selected thesis; it is waiting here because nothing has been selected. The Risk Certificate is holding without a proposal, so execution does not proceed. The position area states that AURA is flat. Finally, Ask AURA and the read-only Status MCP let a judge ask why no trade was sent. None of the numbers or outcomes on this slide pretend to be a historical filled trade.”

## Likely technical jury questions

1. **Why BTC and ETH only?** AURA intentionally limits its opportunity universe to two liquid spot symbols while applying one risk budget and the same rules to both.
2. **Why doesn't the LLM trade directly?** It serves as a bounded critic. Deterministic risk evaluation has the final veto, and the LLM has no WRITE MCP client.
3. **What is MCP doing?** Separate OKX ATK MCP processes provide market/account/spot reads and execution. AURA also serves read-only status over MCP.
4. **How does sizing work?** The hard Risk Engine sizes from risk budget, stop distance and position limits. LLM confidence does not multiply size.
5. **What prevents duplicate orders?** OKX-safe client IDs, lookup and reconciliation precede placement; ambiguous submissions are never blindly retried.
6. **What happens if MCP fails?** New entries stop. A submitted order's outcome remains reconciliation-required rather than assumed failed.
7. **What happens if the LLM fails?** New entries stop; deterministic held-position protection logic remains separate from the LLM, subject to available exchange connectivity.
8. **How is unmanaged inventory distinguished?** A wallet balance alone is not ownership evidence. AURA requires a checkpoint or matching AURA order/fill provenance.
9. **Why one managed position?** The single-position gate limits aggregate exposure and prevents a BTC trade from overlapping an AURA-managed ETH trade.
10. **What makes AURA more than a trading bot?** The product exposes Critic reasoning, Risk Certificates, causal provenance, MCP traces and read-only explanations around every decision or rejection.

## Scoring criteria mapping

| Official criterion | Best-supported slides |
|---|---|
| Functional Utility & Value — 30% | 1, 2, 3 |
| User Experience & Interaction — 30% | **3**, 5 |
| ATK MCP Integration Depth — 20% | 2, 3, 4 |
| System Reliability & Safety — 10% | 2, 4 |
| Innovation & Uniqueness — 10% | 1, 4, 5 |

**Truth boundary:** The deck shows no fabricated return, PnL, filled order or live-trading success. Exchange-side protection remains unverified for new live entries, which AURA currently blocks.

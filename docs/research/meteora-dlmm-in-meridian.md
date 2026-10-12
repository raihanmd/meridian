# Meteora DLMM Integration in Meridian

**Date:** 2026-06-09  
**Focus:** How Meridian discovers, evaluates, and deploys to Meteora DLMM pools  
**Status:** Research complete — no implementation performed

---

## Executive Summary

Meridian is an **execution-capable autonomous agent** that actively manages liquidity positions on Meteora DLMM pools. It does NOT merely recommend pools — it deploys, manages, claims fees, and closes positions on-chain using the official `@meteora-ag/dlmm` SDK.

The system uses a **multi-stage pipeline**:
1. **Pool Discovery API** → fetch raw pool data
2. **Hard filters** → eliminate risky/bad pools
3. **Scoring & enrichment** → rank candidates
4. **LLM reasoning** → pick final pool for deploy
5. **DLMM SDK** → execute on-chain transactions

**Key finding:** The project already has sophisticated reasoning infrastructure (lessons, signal weights, pool memory) that could be extended for Sharia Advisor integration.

---

## 1. Pool Discovery & Data Flow

### 1.1 Meteora Pool Discovery API

**Endpoint:** `https://pool-discovery-api.datapi.meteora.ag`

**Files:** `tools/screening.js:11`, `tools/executor.js:31`

**How it works:**
```javascript
// Fetch pools with filters
const url = `${POOL_DISCOVERY_BASE}/pools?` +
  `page_size=${page_size}` +
  `&filter_by=${encodeURIComponent(filters)}` +
  `&timeframe=${timeframe}` +
  `&category=${category}`;
```

**Data fetched per pool:**
- `pool_address`, `name`, `pool_type`
- Token X/Y details (symbol, mint, organic_score, warnings)
- `dlmm_params.bin_step`
- `fee_pct`, `fee_active_tvl_ratio`
- `volatility`, `volume`, `tvl`, `active_tvl`
- `base_token_holders`, `market_cap`
- `price`, `price_change_pct`, `price_trend`
- `discord_signal`, `discord_signal_count`

### 1.2 DLMM SDK Integration

**Library:** `@meteora-ag/dlmm` (lazy-loaded)

**File:** `tools/dlmm.js:48-74`

**Why lazy load?** CJS directory imports in `@meteora-ag/dlmm` break ESM on Node 24. Dynamic import defers loading until actual on-chain call.

**Methods exposed via SDK:**
- `deployPosition()` → `initializePositionAndAddLiquidityByStrategy`
- `closePosition()` → close and claim fees
- `claimFees()` → harvest fees only
- `addLiquidity()` / `withdrawLiquidity()` → rebalance
- `getActiveBin()` → current price & bin mapping

---

## 2. Pool Evaluation & Scoring

### 2.1 Hard Filters (Code-Level)

**File:** `tools/screening.js:82-146`

**Filter sequence:**
1. Token warnings (`base_token_has_critical_warnings`)
2. High supply concentration (`excludeHighSupplyConcentration`)
3. High single ownership (`base_token_has_high_single_ownership`)
4. Pool type must be "dlmm"
5. Market cap bounds (`minMcap` to `maxMcap`)
6. Holder count (`minHolders`)
7. Volume (`minVolume`)
8. TVL bounds (`minTvl` to `maxTvl`)
9. **Bin step bounds** (`minBinStep` to `maxBinStep`) — CRITICAL
10. Fee/TVL ratio (`minFeeActiveTvlRatio`) — CRITICAL
11. Volatility must be positive and usable
12. Organic scores (base and quote tokens)
13. Launchpad allow/block lists
14. Token age bounds (`minTokenAgeHours` to `maxTokenAgeHours`)

### 2.2 Scoring Formula

**File:** `tools/screening.js:32-38`

```javascript
function scoreCandidate(pool) {
  const feeTvl = Number(pool.fee_active_tvl_ratio || 0);
  const organic = Number(pool.organic_score || 0);
  const volume = Number(pool.volume_window || 0);
  const holders = Number(pool.holders || 0);
  return feeTvl * 1000 + organic * 10 + volume / 100 + holders / 100;
}
```

**Weighting:**
- **Fee/TVL ratio** (x1000) — primary driver
- **Organic score** (x10) — secondary signal
- **Volume** (÷100) — tertiary
- **Holders** (÷100) — tertiary

### 2.3 PVP (Peer Volume Protection) Detection

**File:** `tools/screening.js:292-347`

**What is PVP?** Multiple mints share the same symbol with active pools — risky because liquidity fragments.

**Detection logic:**
1. Identify top 2 candidates by score
2. For each, search for rival pools with same base symbol
3. Rival must have: `tvl > 5,000`, `holders >= 500`, `fees >= 30 SOL`
4. If rival found, mark pool as `is_pvp: true` with risk level

**Action:** Default `avoidPvpSymbols: true` (warn). If `blockPvpSymbols: true`, hard-filter those pools.

---

## 3. DLMM Concepts Used by Meridian

### 3.1 Active Bin & Price

**Tool:** `get_active_bin`

**Returns:** `binId`, `price`, `pricePerLamport`

**How Meridian uses it:**
- Deploy: `bins_below` = range below active bin, `bins_above` = 0 (single-side SOL)
- Close/claim: check position status
- LLM prompt shows active bin for range reasoning

### 3.2 Bin Step

**What:** Size of each bin in price % terms. Bin step 100 = 1% bins.

**Meridian constraints:** `minBinStep` (80) to `maxBinStep` (125)

### 3.3 Fee & APR

**Metrics from API:**
- `fee_pct` — pool base fee
- `fee` — fees earned in timeframe
- `fee_active_tvl_ratio` — KEY METRIC = fee / active_tvl

**Why fee/TVL matters:** High ratio → good yield, Low ratio → inactive pool

### 3.4 Volume & Volatility

**Volume:** `volume_window` — hard-filtered to `minVolume` (500)

**Volatility:** Must be positive. Used to calculate `bins_below` dynamically.

---

## 4. Reasoning Infrastructure

### 4.1 Existing Reasoning Layers

#### A. Hard-Code Deterministic Reasoning
**File:** `tools/screening.js`  
**Pattern:** "Reject if [condition] is true"

#### B. Scoring-Based Reasoning
**File:** `tools/screening.js:32-38`  
**Pattern:** "Score = weighted sum of signals"

#### C. LLM Reasoning
**File:** `prompt.js:95-129` (SCREENER role)  
**What LLM gets:** Candidates, active bin, narrative, smart wallet checks, pool memory, lessons, signal weights

#### D. Performance Lessons
**File:** `lessons.js:257-270`  
**Pattern:** After every close, derive a rule (PREFER/AVOID/WORKED/FAILED)

#### E. Signal Weights (Darwinian)
**File:** `signal-weights.js`  
**What:** Recalculates signal importance every 5 closes. Top quartile × 1.05, bottom × 0.95

### 4.2 Pool Memory

**File:** `pool-memory.js`

**What it stores per pool:**
- Deploy history (times, amounts, PnL, close reasons)
- Rolling 48 snapshots (5min × 4h)
- Cooldown tracking (4h for low yield, 12h for OOR 3×)

---

## 5. Position Lifecycle

### 5.1 Deploy Flow

**Entry:** `deploy_position` tool

**Steps:**
1. **Safety check** — fetch fresh pool detail, validate metrics, check SOL balance
2. **SDK deployment** — lazy-load DLMM, build transaction, sign, simulate, send
3. **Post-deploy** — track position, record snapshot, append decision, notify

### 5.2 Management Flow

**Entry:** Management cron cycle

**Deterministic checks first:**
- STOP_LOSS if `pnl_pct <= stopLossPct`
- TRAILING_TP if `(peak - current) >= trailingDropPct` (queued, 15s recheck)
- OUT_OF_RANGE if `minutes_out_of_range >= outOfRangeWaitMinutes`
- LOW_YIELD if `fee_per_tvl_24h < minFeePerTvl24h && age >= minAgeBeforeYieldCheck`

### 5.3 Close Flow

**Entry:** `close_position` tool

**Steps:** Fetch position → close via SDK → claim fees → record close → derive lesson → update pool memory → auto-swap base token

---

## 6. Data Sources Summary

| Source | Purpose |
|--------|---------|
| Meteora Pool Discovery API | Fetch pools, metrics, token health |
| Meteora DLMM SDK | On-chain position management |
| Jupiter API | Token info, holders, narrative, dev address |
| Helius API | Wallet balances |
| Agent Meridian API | Discord signals, top LPers, chart indicators |

---

## 7. Existing Criteria for Pool Selection

### 7.1 Hard Filters (Reject)

| Criterion | Default |
|-----------|---------|
| `minTvl` | $10,000 |
| `maxTvl` | $150,000 |
| `minFeeActiveTvlRatio` | 0.05 (5%) |
| `minVolume` | 500 |
| `minHolders` | 500 |
| `minMcap` | $150,000 |
| `maxMcap` | $10,000,000 |
| `minBinStep` | 80 |
| `maxBinStep` | 125 |
| `minOrganic` | 60 |
| `maxBotHoldersPct` | 30% |

---

## 8. Reasoning Examples in Prompts

### 8.1 SCREENER Prompt

```
CRITICAL — NO HALLUCINATION: You MUST call the actual tool to perform any action.

RISK SIGNALS:
- top10 > 60% → concentrated, risky
- PVP symbol conflict → major negative
- no narrative + no smart wallets → skip

NARRATIVE QUALITY:
- GOOD: specific origin — real event, viral moment, named entity
- BAD: generic hype ("next 100x") with no identifiable subject

DEPLOY RULES:
- Pick ONE pool only when conviction is real
- If only one weak candidate survives, skip and explain why
```

---

## 9. Where Sharia Advisor Reasoning Could Be Inserted

### 9.1 Integration Points

| Location | Change Type | Effort |
|----------|-------------|--------|
| `tools/screening.js` | Add pre-LLM filter | Low |
| `prompt.js` | Add reasoning instruction | Low |
| `tools/definitions.js` | Add tool for compliance check | Medium |
| `tools/executor.js` | Add safety check before deploy | Medium |
| `pool-memory.js` | Track Sharia-compliant performance | Low |
| `config.js` | Add `sharia` config section | Low |

### 9.2 Recommended Approach

**Phase 1: Pre-LLM Filter (Hardest Gate)**
```javascript
// In tools/screening.js:474
const reason = getRawPoolScreeningRejectReason(pool, s);
// ADD: if (!isShariaCompliant(pool)) return "not Sharia-compliant";
```

**Phase 2: LLM Instruction (Guidance)**
```javascript
// In prompt.js:100
// SHARIA COMPLIANCE: You MUST verify pool is Sharia-compliant before deploying.
// Check: no interest (riba), no excessive uncertainty (gharar), no prohibited sectors.
// If unsure, skip.
```

**Phase 3: Performance Tracking**
```javascript
// In pool-memory.js
{
  sharia_compliant: true,
  sharia_certified_by: "...",
  sharia_last_check: "2026-06-09T..."
}
```

---

## 10. Files That Should Be Modified Later

### 10.1 Core Modifiers

| File | Reason |
|------|--------|
| `tools/screening.js` | Add `isShariaCompliant()` and call in `getRawPoolScreeningRejectReason()` |
| `prompt.js` | Add Sharia reasoning instruction to SCREENER role |
| `config.js` | Add `sharia` section to config |
| `user-config.example.json` | Expose Sharia settings |

### 10.2 Supporting Files

| File | Reason |
|------|--------|
| `tools/definitions.js` | Add `check_sharia_compliance` tool schema |
| `tools/executor.js` | Wire `check_sharia_compliance` to implementation |
| `tools/sharia.js` | NEW — fetch Sharia data (API or local) |
| `pool-memory.js` | Track Sharia performance metrics |
| `state.js` | Store Sharia compliance status per position |
| `lessons.js` | Record Sharia-related lessons |

### 10.3 Data Files

| File | Reason |
|------|--------|
| `sharia-cache.json` | NEW — cache prior compliance judgments |
| `sharia-pools.json` | NEW — whitelist/blacklist of pools |

---

## 11. Files That Should NOT Be Touched

| File | Reason |
|------|--------|
| `tools/dlmm.js` | DLMM SDK integration — unrelated to Sharia |
| `agent.js` | Agent harness — no logic changes needed |
| `index.js` | Cron orchestration — no changes needed |
| `telegram.js` | Notifications — may add message type but not core logic |

---

## 12. Risks of Changing the Flow Incorrectly

| Risk | Scenario | Impact |
|------|----------|--------|
| Deploy to non-compliant pool | Skipping Sharia check | Religious violation, trust loss |
| Blocking all pools | Overly strict filter | No deployments, agent idle |
| False positives | Incorrectly flagging pools | Missed opportunities |

---

## 13. Open Questions for Implementation

1. **Data source:** Third-party API, self-hosted list, or on-chain metadata?
2. **Check granularity:** Token level, pool level, or strategy level?
3. **Re-check frequency:** Only at deploy, or periodic re-evaluation?
4. **Non-compliance handling:** Hard block, soft warning, or allow override?
5. **Whitelist vs blacklist:** Approved list or blocked list?
6. **Certification authority:** Who decides compliance?

---

## 14. Summary

**Meridian's DLMM integration is mature and execution-capable.**

**Key strengths:**
- Multi-stage filtering pipeline (hard + scoring + LLM)
- Performance learning via lessons and signal weights
- Pool memory with cooldown logic
- PVP detection to avoid liquidity fragmentation
- Extensive config system for fine-tuning

**Integration readiness for Sharia Advisor:**
- **Pre-LLM filter:** Easy to add (`tools/screening.js` line ~474)
- **LLM instruction:** Easy to add (`prompt.js` line ~110)
- **Performance tracking:** Medium effort
- **Hard compliance gate:** Medium effort (add `tools/sharia.js` + `tools/executor.js`)

**Recommended:** Start with pre-LLM filter in `screening.js`, add LLM instruction, add config, implement `tools/sharia.js`, add cache and tracking.

**No changes needed to core DLMM SDK integration or agent harness.**

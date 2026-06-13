# Meridian Config Optimization Report

> Generated: 2026-06-13 | Based on 10+ dry-run experiments across 3 config iterations

---

## Summary

After 3 rounds of config relaxation, the screening pipeline went from **0 → 4–5 pools** passing all non-Sharia filters per cycle. **Sharia is the single remaining bottleneck** — every qualifying pool is a *-SOL pair outside the allowlist.

**Verdict: Config is near-optimal for the current constraints (Sharia allowlist). Further relaxation past this point risks quality.**

---

## 1. Pipeline Performance

| Metric | Before (default config) | After (batch 1) |
|--------|------------------------|-----------------|
| Pools discovered | 2–3 | 5–6 |
| Pass hard filters (TVL, org, holders, etc.) | 0–1 | 4–5 |
| Pass Sharia → LLM-eligible | 0 | 0 |
| Pipeline latency | <2s | <1s |

**Enrichment speed**: 200–400ms per pool (API calls to portfolio, pool detail, smart wallets).
**No enrichment is hanging** — all calls resolve within normal bounds.

---

## 2. Config Threshold Impact (batch 1 relaxation)

| Threshold | Old | New | Impact | Risk |
|-----------|-----|-----|--------|------|
| `minTvl` | 10,000 | 2,000 | Caught Bank-SOL ($4.5K) | May catch illiquid pools |
| `maxTvl` | 150,000 | 500,000 | No impact yet | Protects against mega-pools with low APR |
| `minOrganic` | 60 | 30 | 2× more pools qualify | Some low-quality tokens may pass |
| `minQuoteOrganic` | 60 | 20 | All SOL-quote pools pass (SOL has low organic) | Safe — SOL is established |
| `minHolders` | 500 | 200 | More new tokens qualify | Slightly more scam risk |
| `minMcap` | 150K | 50K | Caught smaller mcap tokens | Appropriate for micro-cap pools |
| `maxMcap` | 10M | 50M | None (no mega-pools seen) | Safe — high mcap = established |
| `minVolume` | 500 | 200 | More pools qualify | May include low-activity pools |
| `minBinStep` | 80 | 40 | Broader pool range (40–200) | Acceptable — DLMM works at 40 |
| `maxBinStep` | 125 | 200 | Some high-volatility pools | Higher tick = more IL risk |
| `minFeeActiveTvlRatio` | 0.05 | 0.02 | Lower yield pools usable | Might dilute returns |
| `minTokenFeesSol` | 30 | 5 | More pools pass | Higher scam/farm risk |

## 3. Pool Rejection Breakdown (current config)

```
discoverPools (5-6 pools)
  │
  ├─ filtered by volatility=0 → 1 pool (-USDC)
  ├─ filtered by supply concentration / warnings → 0-1 pools
  │
  └─ pass hard filters → 4-5 pools
       │
       └─ Sharia filter
            ├─ NOT in allowlist → 4-5 pools → pending_candidates ⏳
            └─ in allowlist → 0 pools → candidates ✅
```

**Hard filter breakdown for observed pools:**

| Pool | TVL | Bin Step | Organic | Holders | Mcap | Vol | Fee/TVL | Result |
|------|-----|----------|---------|---------|------|-----|---------|--------|
| SPCX-SOL | $35K | 80 | 50 | ~500 | ~$1M | 0.05 | 0.08 | ✅ Pass → Sharia block |
| KINS-SOL | $8K | 200 | 40 | ~300 | ~$500K | 0.10 | 0.15 | ✅ Pass → Sharia block |
| SOCCER-SOL | $24K | 80 | 45 | ~400 | ~$750K | 0.08 | 0.10 | ✅ Pass → Sharia block |
| GYM-SOL | $49K | 100 | 35 | ~250 | ~$600K | 0.06 | 0.12 | ✅ Pass → Sharia block |
| Bank-SOL | $4.5K | 80 | 30 | ~200 | ~$50K | 0.04 | 0.07 | ✅ Pass → Sharia block |
| Merlin-SOL | $12K | 120 | 38 | ~350 | ~$400K | 0.07 | 0.09 | ✅ Pass → Sharia block |
| trelon-SOL | $6K | 60 | 42 | ~280 | ~$300K | 0.09 | 0.11 | ✅ Pass → Sharia block |

---

## 4. Bottleneck: Sharia Allowlist

**Current allowlist** (5 pairs — all cbBTC or stablecoin-quoted):
```
1. SOL → USDC
2. SOL → USDT
3. cbBTC → SOL
4. cbBTC → USDC
5. cbBTC → USDT
```

**Observed pool types**: 100% are `*-SOL` pairs. None use USDC/USDT as quote, none use cbBTC.

This means with current constraints, **deployment is impossible**:
- The pool-discovery API returns almost exclusively *-SOL pairs
- None match the allowlist
- All go to `pending_candidates` requiring manual approval

**Options (choose one)**:

| Option | Effect | Risk |
|--------|--------|------|
| A. Disable Sharia (`shariaEnabled: false`) | All 4-5 pools → LLM-eligible | No religious compliance |
| B. Add SOL pairs to allowlist | `*-SOL` pairs pass through | Some low-quality tokens |
| C. Implement manual approval flow | Approve via `cli.js` or Telegram | Need to build the flow |
| D. Keep current (pending only) | 0 deployments, pools wait forever | Deploy never happens |

---

## 5. Other Observations

### Bugs Fixed
- ✅ `notes is not defined` — Sharia filter destructure missing `notes` fallback
- ✅ `formatHelpText()` — now dual-surface (REPL + Telegram); includes `/pending`, `/approve`, `/decline`, `/thresholds`, `/learn`, `/evolve`

### Minor Issues (non-blocking)
- **CLI `candidates` omits `pending_candidates`** — output shows `total_screened: 3` but no `pending_candidates` field. Easy fix.
- **`/pause` missing from Telegram command registry** — handler exists in `index.js` but `/pause` isn't registered via `setMyCommands`.
- **`LPAGENT_API HTTP 401`** — non-blocking, portfolio API and env vars are the auth path; LPAgent is optional.
- **Pool discovery varies per call** — different pools returned each 30s (live API, expected behavior).

---

## 6. Recommended Next Steps

1. **Choose a Sharia strategy** (options A-D above)
2. **If option B**: add `"*-SOL"` as wildcard or specific pairs to `shariaAllowlistedPairs`
3. **If option D**: wire Telegram `/approve` and `/decline` to actually trigger deploy/decline actions
4. **After unblocking**: run `cli.js screen --dry-run` to verify a pool reaches the LLM
5. **Config batch 2** (only if needed): further relax `minOrganic → 20`, `minHolders → 100`

---

## 7. Quick Commands

```bash
# Current pipeline test
DRY_RUN=true node cli.js candidates --limit 5

# Full screen cycle (includes LLM)
DRY_RUN=true node cli.js screen --dry-run

# View live config
DRY_RUN=true node cli.js config get

# Test without sharia (quick throughput check)
# Temporarily set "shariaEnabled": false in user-config.json, run:
DRY_RUN=true node cli.js candidates --limit 5
# Then restore
```

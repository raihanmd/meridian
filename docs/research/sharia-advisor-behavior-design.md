# Sharia Advisor Behavior Design

**Project**: Meridian — Autonomous DLMM Liquidity Provider Agent for Solana  
**Version**: 1.0  
**Date**: 2026-06-09

---

## 1. Overview

The Sharia Advisor is a **hard-filtered, configuration-driven screening layer** that evaluates Meteora DLMM pool candidates for Islamic compliance before they are presented to the LLM for deployment decisions.

### Key Principles

1. **Hard-filtered, not soft-filtered** — Blocks are enforced before the LLM sees candidates, not left to LLM judgment
2. **Allowlist-first approach** — Default deny; only explicitly approved tokens/assets are eligible
3. **Unknown = Not Eligible** — Tokens without explicit approval status are automatically rejected
4. **Lending/Interest/Gambling Blocked** — Projects involving Riba (interest), Gharar (excessive uncertainty), or Maysir (gambling) are hard-blocked
5. **Fee-Only Liquidity** — Only Meteora DLMM swap fee income is acceptable; lending/vault yield is prohibited
6. **Transparent Reasoning** — Every verdict includes explanation text for LLM and human review

---

## 2. Verdict Taxonomy

### 2.1 Verdict States

| Verdict | Code | Description | LLM Decision | Telegram |
|---------|------|-------------|--------------|----------|
| APPROVED | approved | Fully Sharia-compliant, no restrictions | DEPLOY | Green |
| APPROVED_WITH_NOTES | approved_with_notes | Compliant but with caveats | DEPLOY with notes | Yellow |
| WATCHLIST | watchlist | Potential concerns, manual review required | SKIP to user | Blue |
| BLOCKED | blocked | Explicitly non-compliant | NO DEPLOY | Red |
| UNKNOWN | unknown | No rating available, auto-reject | NO DEPLOY | Red |

### 2.2 Verdict Mapping Logic

verdict = if (token in base_allowlist) -> approved
        else if (token in approved_with_notes_list) -> approved_with_notes
        else if (token in watchlist) -> watchlist
        else if (token in blocklist) -> blocked
        else -> unknown

---

## 3. Existing Architecture Integration

### 3.1 Mapping to Current Flow

runScreeningCycle() -> getTopCandidates() -> [NEW: Sharia Advisor]
    |
    getShariaAdvisorRating(pool) -> verdict + notes
    |
    hard-filter based on shariaEnabled + allowlist
    |
    candidates passed to LLM with sharia_score and sharia_notes

### 3.2 Existing Patterns Used

| Existing Pattern | Used For |
|------------------|----------|
| isBlacklisted() from token-blacklist.js | Hard-filter blocked tokens |
| pushFilteredReason() from screening.js | Log rejection reasons |
| config.screening.shariaEnabled | Enable/disable filter |
| agentMeridianJson() from agent-meridian.js | Call /sharia/rate API |
| decision-log.json | Record rejection reasons |
| getRawPoolScreeningRejectReason() | Template for screening rules |

### 3.3 New Files Created (Zero - Reuses Existing)

The design leverages **existing infrastructure**:
- tools/screening.js — Hard-filter logic
- config.js — screening.shariaEnabled config
- token-blacklist.js — Extensible for blocklist/allowlist
- dev-blocklist.js — Pattern for wallet-based filtering
- pool-memory.js — For cooldowns (if needed later)

---

## 4. Data Requirements

### 4.1 Data the Advisor Needs

| Field | Source | Purpose |
|-------|--------|---------|
| pool_address | Pool object | Call /sharia/rate API |
| base_mint | Pool object | Token rating lookup |
| quote_mint | Pool object | Quote token rating (SOL/USDC/USDT) |
| pool_type | Pool object | Verify dlmm (no lending/vaults) |
| base_token_launchpad / launchpad | Pool object | Block meme/launch/pure-hype |
| token_age_hours | Pool object | Block very new tokens (< 24h) |

### 4.2 Existing Data Already Available

The pool discovery API already provides:

| Field | Available | Already Used |
|-------|-----------|--------------|
| pool_address | YES | YES |
| base?.mint | YES | YES |
| base?.launchpad | YES | YES |
| base?.created_at | YES | YES (via token_age_hours) |
| pool_type | YES | YES |
| token_x?.warnings | YES | YES |
| token_x?.dev | YES | YES |

### 4.3 Missing Data (To Be Added)

| Field | Source | Priority |
|-------|--------|----------|
| sharia_verdict | Advisor rating | Required |
| sharia_notes | Advisor notes | Required |
| sharia_timestamp | Timestamp of rating | Nice-to-have |

---

## 5. Implementation Plan

### Phase 1: Core Rating Function (MINIMAL)

File: tools/sharia-advisor.js (NEW)

Phase 1: Simple base allowlist + blocklist
- Hard-block known non-compliant tokens
- Check base allowlist (SOL, USDC, USDT)
- Check approved-with-notes
- Hard-block lending/gambling projects
- Hard-block meme/launch/pure-hype
- Block if pool_type is not dlmm
- Block if token is too new (< 24h)
- Default: unknown -> auto-reject

### Phase 2: Enhanced Rating with External API

Add external API fallback to Agent Meridian /sharia/rate endpoint

### Phase 3: Integration into getTopCandidates()

After all existing hard filters (line ~666):
- Call getShariaAdvisorRating for each pool
- Convert verdict to score (0-100)
- Hard-filter based on config threshold
- Use pushFilteredReason for logging

---

## 6. Base Allowlist

### 6.1 Approved Tokens

| Token | Verdict | Notes |
|-------|---------|-------|
| So11111111111111111111111111111111111111112 (SOL) | approved | Native asset, no concerns |
| EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v (USDC) | approved_with_notes | Settlement asset, no lending |
| Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB (USDT) | approved_with_notes | Settlement asset, no lending |

### 6.2 Approved With Notes

USDC / USDT Notes:
"Stablecoins approved for settlement purposes only. Do not deploy into pools where the primary yield is lending/borrowing interest. Prefer swap-fee generating pools only."

### 6.3 Default Blocklist (Implicit)

| Block Reason | Verdict | Example |
|--------------|---------|---------|
| Lending/borrowing contract | blocked | Raydium lending, Solend pools |
| Perpetuals/futures | blocked | Meteora perps pools |
| Vaults (non-fee) | blocked | Gelato vaults, Pendle |
| Meme tokens (< 24h) | blocked | New pump.fun launches |
| No explicit rating | unknown | All other tokens -> auto-reject |

---

## 7. Testing Plan

### 7.1 Unit Tests

File: test/sharia-advisor.js (NEW)

Test cases:
- approves SOL
- approves USDC with notes
- blocks unknown tokens
- blocks non-DLMM pools
- blocks new tokens (< 24h)
- blocks lending projects

### 7.2 Integration Tests

| Scenario | Expected Behavior |
|----------|-------------------|
| SOL/USDC pool, shariaEnabled=true | Pass through (score=100) |
| SOL/USDC pool, shariaEnabled=true | Pass through (score=100) |
| Unknown token, shariaEnabled=true | Manual approval (score=50) |
| USDC/SOL pool with lending contract | Hard-blocked (non-DLMM type) |
| New meme token (2h old) | Hard-blocked (too new) |
| API unavailable | Fallback to allowlist only |

---

## 8. Expected Output Format

### 8.1 LLM Candidate Block (After Integration)

POOL: SOL/USDC (pool_address_abc123)
  metrics: bin_step=100, fee_pct=0.2%, fee_tvl=0.5%, vol=$1000, tvl=$1M, volatility_30m=2.5%, mcap=$50M, organic=80, sharia_score=100
  audit: top10=45%, bots=10%, fees=50SOL
  smart_wallets: 3 present -> CONFIDENCE BOOST
  active_bin: 42
  sharia: VERDICT=APPROVED | Notes: Native asset, no concerns

### 8.2 Final Reasoning Output (SCREENER Prompt)

WHY THIS WON
SOL/USDC is the most liquid pool with highest fee/TVL ratio. 
Sharia Advisor: APPROVED (native SOL + USDC settlement).
Risk: Top-10 concentration at 45% but within acceptable range.

---

## 9. Configuration

### 9.1 User Config (user-config.json)

{
  "screening": {
    "shariaEnabled": true,
    "shariaEnabled": true,
    "shariaApproveWithNotes": true,
    "shariaAllowlist": ["So11111111111111111111111111111111111111112"],
    "shariaBlocklist": ["RENDER_TOKEN_MINT", "RAYDIUM_LENDING_MINT"]
  }
}

### 9.2 Default Configuration

config.js:
screening: {
  shariaEnabled: true,         // Enable/disable entirely
  shariaApproveWithNotes: true, // Allow approved_with_notes
}

---

## 10. Migration Path

### Phase 1: Base Implementation (1-2 days)

- [ ] Create tools/sharia-advisor.js
- [ ] Add base allowlist (SOL, USDC, USDT)
- [ ] Add hard-block rules (lending, perps, meme, new tokens)
- [ ] Integrate into getTopCandidates() hard filter
- [ ] Add sharia_score to candidate blocks
- [ ] Add Sharia instructions to SCREENER prompt

### Phase 2: API Enhancement (Optional, 1 day)

- [ ] Connect to Agent Meridian /sharia/rate endpoint
- [ ] Fallback to local allowlist if API unavailable
- [ ] Add sharia_verdict and sharia_notes to candidate blocks

### Phase 3: User Config & Testing (1 day)

- [ ] Add shariaEnabled config to user-config.example.json
- [ ] Add unit tests
- [ ] Add integration tests
- [ ] Manual testing with real pools

---

## 11. Risk Mitigation

### 11.1 Safety Features

| Risk | Mitigation |
|------|------------|
| False positives (block good pools) | Disable sharia or add pair to allowlist |
| API downtime | Fallback to local allowlist/blocklist |
| Over-blocking | shariaApproveWithNotes flag for lenient mode |
| Unknown tokens auto-rejected | User can whitelist via Telegram |

---

## 12. Conclusion

The Sharia Advisor is designed as a **minimal, hard-filtered screening layer** that:

1. **Reuses existing patterns** (blacklist, blocklist, config, logging)
2. **Requires zero new files** (Phase 1 - embed in existing screening.js)
3. **Uses existing data** (pool discovery API provides everything needed)
4. **Provides transparent reasoning** (verdict + notes for LLM and users)
5. **Is fully configurable** (shariaEnabled, allowlist/blocklist)

The design follows Meridian's existing architecture patterns and integrates seamlessly with the screening flow without modifying the core agent loop or requiring extensive changes to existing code.

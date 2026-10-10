import assert from "node:assert/strict";
import test from "node:test";
import { config } from "../config.js";
import { discoverPools } from "../tools/screening.js";
import { executeTool } from "../tools/executor.js";
import { getPoolRestrictionReason, normalizeTokenAllowlist, SOL_MINT } from "../token-allowlist.js";

const GHOST_MINT = "BBKPiLM9KjdJW7oQSKt99RVWcZdhF6sEHRKnwqeBGHST";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

test("allowlist requires canonical mint objects and both sides of a SOL pair", () => {
  const allowlist = normalizeTokenAllowlist([
    { name: "GHOST", mint: GHOST_MINT },
    { name: "SOL", mint: SOL_MINT },
  ]);
  assert.equal(getPoolRestrictionReason(GHOST_MINT, SOL_MINT, allowlist), null);
  assert.match(getPoolRestrictionReason(USDC_MINT, SOL_MINT, allowlist), /both pool token mints/);
  assert.match(getPoolRestrictionReason(GHOST_MINT, USDC_MINT, allowlist), /token Y must be SOL/);
  assert.match(getPoolRestrictionReason(GHOST_MINT, SOL_MINT, []), /tokenAllowlist is empty/);
  assert.throws(() => normalizeTokenAllowlist([{ name: "bad", mint: "bad mint" }]), /invalid mint/);
  assert.throws(() => normalizeTokenAllowlist("GHOST"), /must be an array/);
});

test("discovery keeps pools outside the allowlist for manual screening", async () => {
  const screening = config.screening;
  const original = { ...screening };
  const originalFetch = globalThis.fetch;
  const pool = (address, baseMint, quoteMint) => ({
    pool_address: address,
    name: address,
    pool_type: "dlmm",
    token_x: { address: baseMint, symbol: "BASE", market_cap: 1_000_000, organic_score: 90 },
    token_y: { address: quoteMint, symbol: "QUOTE", organic_score: 90 },
    base_token_holders: 1000,
    volume: 10_000,
    tvl: 20_000,
    active_tvl: 10_000,
    fee_active_tvl_ratio: 1,
    volatility: 1,
    dlmm_params: { bin_step: 100 },
  });
  let calls = 0;
  try {
    Object.assign(screening, {
      tokenAllowlist: normalizeTokenAllowlist([
        { name: "GHOST", mint: GHOST_MINT },
        { name: "SOL", mint: SOL_MINT },
        { name: "USDC", mint: USDC_MINT },
      ]),
      timeframe: "30m", useDiscordSignals: false, excludeHighSupplyConcentration: false,
      minTvl: 1, maxTvl: null, minVolume: 1, minMcap: 1, maxMcap: 10_000_000,
      minHolders: 1, minOrganic: 1, minQuoteOrganic: 1,
      minBinStep: 1, maxBinStep: 1000, minFeeActiveTvlRatio: 0,
      allowedLaunchpads: [], blockedLaunchpads: [], minTokenAgeHours: null, maxTokenAgeHours: null,
    });
    globalThis.fetch = async () => {
      calls++;
      return {
        ok: true,
        json: async () => ({ total: 3, data: [
          pool("allowed", GHOST_MINT, SOL_MINT),
          pool("blocked-base", USDC_MINT, SOL_MINT),
          pool("blocked-quote", GHOST_MINT, USDC_MINT),
        ] }),
      };
    };
    // Remove USDC as an allowed base while keeping the quote restriction explicit.
    screening.tokenAllowlist = screening.tokenAllowlist.filter((entry) => entry.mint !== USDC_MINT);
    const result = await discoverPools();
    assert.deepEqual(result.pools.map((candidate) => candidate.pool), ["allowed", "blocked-base", "blocked-quote"]);
    assert.equal(result.screened, 3);
    assert.equal(result.filtered_examples.length, 0);
    assert.equal(calls, 1);
  } finally {
    Object.assign(screening, original);
    globalThis.fetch = originalFetch;
  }
});

test("deploy tool blocks a pool outside the allowlist before wallet checks", async () => {
  const originalAllowlist = config.screening.tokenAllowlist;
  const originalFetch = globalThis.fetch;
  let calls = 0;
  try {
    config.screening.tokenAllowlist = normalizeTokenAllowlist([
      { name: "GHOST", mint: GHOST_MINT },
      { name: "SOL", mint: SOL_MINT },
    ]);
    globalThis.fetch = async () => {
      calls++;
      return {
        ok: true,
        json: async () => ({ data: [{
          pool_address: "blocked",
          token_x: { address: USDC_MINT },
          token_y: { address: SOL_MINT },
        }] }),
      };
    };
    const result = await executeTool("deploy_position", { pool_address: "blocked" });
    assert.equal(result.blocked, true);
    assert.match(result.reason, /both pool token mints/);
    config.screening.tokenAllowlist = [];
    const emptyResult = await executeTool("deploy_position", { pool_address: "blocked" });
    assert.equal(emptyResult.blocked, true);
    assert.match(emptyResult.reason, /tokenAllowlist is empty/);
    assert.equal(calls, 2);
  } finally {
    config.screening.tokenAllowlist = originalAllowlist;
    globalThis.fetch = originalFetch;
  }
});

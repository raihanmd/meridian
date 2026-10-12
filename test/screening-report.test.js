import assert from "node:assert/strict";
import test from "node:test";
import { formatAllowlistedPoolDiagnostics, formatConfirmedDeploy, formatDryRunDeploy, formatEntryEvidence } from "../screening-report.js";

test("simulated deploy report names the selected pool without claiming a live position", () => {
  const text = formatDryRunDeploy({
    dry_run: true,
    would_deploy: {
      pool_address: "pool-address",
      amount_y: 0.25,
      strategy: "bid_ask",
      bins_below: 75,
      bins_above: 0,
    },
  }, [{ pool: "pool-address", name: "DARK-SOL" }]);
  assert.match(text, /^🧪 DRY RUN · WOULD DEPLOY/);
  assert.match(text, /DARK-SOL/);
  assert.match(text, /0\.25 SOL/);
  assert.match(text, /No transaction was sent and no position was created/);
  assert.doesNotMatch(text, /🚀 DEPLOYED/);
});

test("confirmed report takes range and costs from the tool result, including recovered deploy", () => {
  const result = {
    success: true, dual_token: true, position: "position-address", pool: "pool-address", pool_name: "STRK-USDC",
    amount_sol: 0.5, amount_x: 150, amount_y: 15, strategy: "curve",
    bin_range: { min: -919, active: -905, max: -884 },
    price_range: { min: 0.0001068, max: 0.0001513 },
    range_coverage: { downside_pct: 12.38, upside_pct: 24.11, width_pct: 41.67 },
    rent_estimate_sol: 0.05, transaction_fees_sol: 0.0003,
    txs: ["swap-x", "swap-y", "mint-tx"],
  };
  const candidate = {
    pool: "pool-address", fee_active_tvl_ratio: 0.6, volume_window: 800000, tvl: 300000, organic_score: 90,
    indicator_confirmation: { enabled: true, confirmed: true, preset: "supertrend_break", reason: "confirmed", intervals: [{ interval: "5_MINUTE", ok: true, confirmed: true }] },
  };
  const report = formatConfirmedDeploy(result, { candidate, agentNarrative: "Near resistance, but volume is strong." });
  assert.match(report, /24\.11% upside/);
  assert.match(report, /Execution fees: 0\.000300 SOL/);
  assert.match(report, /Liquidity tx: mint-tx/);
  assert.match(report, /Indicator: CONFIRMED/);
  assert.match(report, /Agent assessment \(unverified\)/);
  assert.doesNotMatch(report, /0\.00% upside/);
  assert.match(formatConfirmedDeploy({ ...result, range_coverage: null }), /Range cover: unavailable/);
});

test("entry evidence names missing chart data instead of claiming confirmation", () => {
  const lines = formatEntryEvidence({
    eligible: true, strategy: "spot", latestCandleEndAt: "2026-10-12T00:00:00.000Z", candleAgeSeconds: 120,
    distanceToOneHourHighPct: 1.97, distanceToSixHourHighPct: 4,
    metrics: { oneHour: { netChangePct: 2 }, sixHour: { netChangePct: 5 } },
  }, {
    enabled: true, confirmed: true, skipped: true, preset: "supertrend_break", reason: "API unavailable",
    intervals: [{ interval: "5_MINUTE", ok: false }],
  });
  assert.match(lines.join("\n"), /1h 1\.97%/);
  assert.match(lines.join("\n"), /Indicator: SKIPPED/);
  assert.match(lines.join("\n"), /5_MINUTE unavailable/);
});

test("allowlisted token diagnosis remains visible after repeated earlier pool rejects", () => {
  const pools = Array.from({ length: 32 }, (_, i) => ({
    pool: `jpad-pool-${i}`,
    name: "JPAD-SOL",
    base: { mint: "jpad-mint" },
  }));
  pools.push({ pool: "dark-pool", name: "DARK-SOL", base: { mint: "dark-mint" } });
  const filtered = pools.map((pool) => ({
    pool: pool.pool,
    reason: pool.base.mint === "dark-mint" ? "volatility unknown is unusable" : "base token is not approved",
  }));
  const text = formatAllowlistedPoolDiagnostics(pools, [
    { mint: "jpad-mint" }, { mint: "dark-mint" },
  ], filtered, [], 270);
  assert.match(text, /DARK-SOL \[dark-poo\]: volatility unknown is unusable/);
  assert.match(text, /more pool\(s\) omitted/);
});

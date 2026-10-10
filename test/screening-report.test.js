import assert from "node:assert/strict";
import test from "node:test";
import { formatAllowlistedPoolDiagnostics, formatDryRunDeploy } from "../screening-report.js";

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

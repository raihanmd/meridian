import assert from "node:assert/strict";
import test from "node:test";
import { formatDryRunDeploy } from "../screening-report.js";

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

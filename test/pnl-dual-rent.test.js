import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { computeDualPnl } from "../tools/dual-deploy.js";
import { valuePoolTokens } from "../tools/pnl.js";

// Exercise the private report builder without contacting Meteora, Jupiter, or RPC.
const source = readFileSync(new URL("../tools/pnl.js", import.meta.url), "utf8");
const helpers = source.slice(source.indexOf("function safeNum("), source.indexOf("// ─── Meteora /pnl"));
const builder = source.slice(source.indexOf("function buildPosition("), source.indexOf("// ─── Main entry:"));
assert.ok(helpers.includes("function round("));
assert.ok(builder.includes("function buildPosition("));

function report({ depositsSol = 0.5, positionRentSol = 0.02, rentPaidSol = 0.02, rentEstimateSol = 0.2, ataBudgetSol = 0.1, feeXRaw = "0", feeYRaw = "0" } = {}) {
  const tracked = {
    dual_token: true,
    dual_deploy: {
      amount_sol: 0.52,
      transaction_fees_sol: 0.001,
      fee_accounting_complete: true,
      position_rent_paid_sol: rentPaidSol,
      position_rent_estimate_sol: rentEstimateSol,
      ata_rent_budget_sol: ataBudgetSol,
    },
  };
  const context = {
    computeDualPnl,
    valuePoolTokens,
    getTrackedPosition: () => tracked,
    markInRange: () => {},
    markOutOfRange: () => {},
    minutesOutOfRange: () => 0,
    log: () => {},
  };
  const buildPosition = vm.runInNewContext(`${helpers}\n${builder}\nbuildPosition`, context);
  const position = {
    position: "position-address", pool: "pool-address", baseMint: "token-x", quoteMint: "token-y",
    decX: 9, decY: 9, xRaw: "5000000000", yRaw: "0", feeXRaw, feeYRaw,
    active: 10, lower: 0, upper: 20,
  };
  const meteora = {
    allTimeDeposits: { total: { sol: depositsSol, usd: depositsSol * 100 } },
    allTimeWithdrawals: { total: { sol: 0, usd: 0 } },
    allTimeFees: { total: { sol: 0, usd: 0 } },
  };
  return buildPosition(position, { "token-x": 10, "token-y": 100 }, 100, meteora, false, positionRentSol);
}

test("dual report fails closed when Meteora deposit basis is missing", () => {
  const position = report({ depositsSol: 0 });
  assert.equal(position.pnl_pct, null);
  assert.equal(position.pnl_usd, null);
  assert.equal(position.pnl_true_usd, null);
  assert.equal(position.pnl_sol_net, null);
  assert.equal(position.pnl_pct_suspicious, true);
  assert.ok(position.raw_pnl_sol > 0, "raw PnL would otherwise look profitable without a cost basis");
});

test("dual report uses actual position rent instead of quote estimate or ATA reserve", () => {
  const position = report();
  assert.equal(position.dual_rent_paid_sol, 0.02);
  assert.equal(position.dual_rent_recovered_sol, 0.02);
  assert.equal(position.pnl_sol_net, -0.021);
  assert.equal(position.pnl_pct, -4.04);
  assert.equal(position.pnl_true_usd, -2.1);
  assert.equal(position.pnl_pct_suspicious, false);
});

test("position report preserves raw on-chain fee balances for the TP hold guard", () => {
  const position = report({ feeXRaw: "12345678901234567890" });
  assert.equal(position.unclaimed_fee_x_raw, "12345678901234567890");
  assert.equal(position.unclaimed_fee_y_raw, "0");
});

test("dual report uses current account rent as basis when historical paid rent is unavailable", () => {
  const position = report({ rentPaidSol: null, positionRentSol: 0.025 });
  assert.equal(position.dual_rent_paid_sol, 0.025);
  assert.equal(position.dual_rent_recovered_sol, 0.025);
  assert.equal(position.pnl_sol_net, -0.021);
});

test("dual report fails closed when actual position rent cannot be read", () => {
  const position = report({ positionRentSol: null });
  assert.equal(position.pnl_pct, null);
  assert.equal(position.pnl_sol_net, null);
  assert.equal(position.pnl_pct_suspicious, true);
});

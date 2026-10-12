import assert from "node:assert/strict";
import test from "node:test";
import { formatStayReason, getDeterministicCloseRule, isLowYieldEligible } from "../management-decision.js";

const config = {
  stopLossPct: -10,
  takeProfitPct: 5,
  trailingTakeProfit: true,
  trailingTriggerPct: 3,
  trailingDropPct: 1.5,
  outOfRangeWaitMinutes: 30,
  outOfRangeBinsToClose: 10,
  minAgeBeforeYieldCheck: 120,
  minFeePerTvl24h: 3,
};
const position = {
  pair: "STRK-USDC", pnl_pct: 2.2, age_minutes: 60,
  fee_per_tvl_24h: 1, in_range: true,
  lower_bin: -920, upper_bin: -885, active_bin: -905,
};

test("low-yield action and HOLD reason use the same configured age", () => {
  assert.equal(isLowYieldEligible(position, config), false);
  assert.equal(getDeterministicCloseRule(position, config), null);
  assert.match(formatStayReason(position, config), /starts at 120m \(age 60m\)/);
  const oldEnough = { ...position, age_minutes: 120 };
  assert.equal(isLowYieldEligible(oldEnough, config), true);
  assert.deepEqual(getDeterministicCloseRule(oldEnough, config), { action: "CLOSE", rule: 5, reason: "low yield" });
  assert.throws(() => formatStayReason(oldEnough, config), /Cannot explain HOLD/);
  assert.equal(isLowYieldEligible({ ...oldEnough, age_minutes: null }, config), false);
});

test("PnL data gap pauses profit exits while the explanation identifies the gap", () => {
  const suspect = { ...position, pnl_pct: 900, pnl_pct_suspicious: true, age_minutes: 130, fee_per_tvl_24h: 4 };
  assert.equal(getDeterministicCloseRule(suspect, config), null);
  assert.match(formatStayReason(suspect, config), /PnL unavailable\/suspect/);
  assert.deepEqual(getDeterministicCloseRule({ ...position, pnl_pct: 5.01 }, config)?.rule, 2);
  assert.deepEqual(getDeterministicCloseRule({ ...position, pnl_pct: -10.01 }, config)?.rule, 1);
});

test("range and trailing status remain visible without inventing an exit", () => {
  const nearOor = { ...position, in_range: false, active_bin: -884, minutes_out_of_range: 29, fee_per_tvl_24h: 4 };
  assert.equal(getDeterministicCloseRule(nearOor, config), null);
  assert.match(formatStayReason(nearOor, config, { trailing_active: true, peak_pnl_pct: 3.5 }), /OOR 29\/30m/);
  assert.match(formatStayReason(nearOor, config, { trailing_active: true, peak_pnl_pct: 3.5 }), /trailing active/);
  assert.equal(getDeterministicCloseRule({ ...nearOor, minutes_out_of_range: 30 }, config)?.rule, 4);
  assert.equal(getDeterministicCloseRule({ ...nearOor, active_bin: -874 }, config)?.rule, 3);
});

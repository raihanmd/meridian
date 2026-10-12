import assert from "node:assert/strict";
import test from "node:test";
import { computePriceRangeCoverage } from "../range-coverage.js";

test("dual-token range has both downside and upside around the active bin", () => {
  const coverage = computePriceRangeCoverage({ min: 0.0001068, active: 0.0001219, max: 0.0001513 });
  assert.ok(coverage.downside_pct > 12 && coverage.downside_pct < 13);
  assert.ok(coverage.upside_pct > 24 && coverage.upside_pct < 25);
  assert.ok(coverage.width_pct > 41 && coverage.width_pct < 42);
});

test("range coverage works from persisted recovery-plan prices and rejects broken plans", () => {
  const plan = JSON.parse(JSON.stringify({ price_range: { min: 1, max: 1.2 }, active_price: 1.1 }));
  assert.ok(computePriceRangeCoverage({ min: plan.price_range.min, max: plan.price_range.max, active: plan.active_price }).upside_pct > 0);
  assert.throws(() => computePriceRangeCoverage({ min: 1.2, max: 1, active: 1.1 }), /valid range/);
  assert.throws(() => computePriceRangeCoverage({ min: 1, max: 1.2, active: NaN }), /valid range/);
});

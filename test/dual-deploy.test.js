import assert from "node:assert/strict";
import test from "node:test";
import { buildDualDeployPlan, computeDualPnl, validateSwapOutcome } from "../tools/dual-deploy.js";

const SOL = "So11111111111111111111111111111111111111112";
const X = "TokenX11111111111111111111111111111111111";
const Y = "TokenY11111111111111111111111111111111111";

test("allocates the SOL budget across two tokens and leaves the reserve untouched", () => {
  const plan = buildDualDeployPlan({
    mintX: X, mintY: Y, solMint: SOL, amountSol: 0.5, walletSol: 1,
    reserveSol: 0.3, valueSplit: { xValueShare: 0.6, yValueShare: 0.4 },
    routes: { [X]: true, [Y]: true },
  });
  assert.deepEqual(plan.swaps.map(({ side, inputSol }) => [side, inputSol]), [["x", 0.3], ["y", 0.2]]);
  assert.equal(plan.retainedSol, 0);
  assert.equal(plan.budgetSol, 0.5);
});

test("retains the SOL side and swaps only the opposite allocation", () => {
  const plan = buildDualDeployPlan({
    mintX: SOL, mintY: Y, solMint: SOL, amountSol: 1, walletSol: 2,
    reserveSol: 0.4, valueSplit: { xValueShare: 0.25, yValueShare: 0.75 },
    routes: { [Y]: true },
  });
  assert.equal(plan.retainedSol, 0.25);
  assert.equal(plan.swaps.length, 1);
  assert.equal(plan.swaps[0].inputSol, 0.75);
  assert.equal(plan.tokenXIsSol, true);
});

test("fails closed for reserves, missing routes, malformed splits, and unsafe swap outcomes", () => {
  const input = {
    mintX: X, mintY: Y, solMint: SOL, amountSol: 1, walletSol: 1.2,
    reserveSol: 0.3, valueSplit: { xValueShare: 0.5, yValueShare: 0.5 },
    routes: { [X]: true, [Y]: true },
  };
  assert.throws(() => buildDualDeployPlan(input), /Insufficient SOL/);
  assert.throws(() => buildDualDeployPlan({ ...input, walletSol: 2, routes: { [X]: true } }), /No validated SOL swap route/);
  assert.throws(() => buildDualDeployPlan({ ...input, walletSol: 2, valueSplit: { xValueShare: 0.4, yValueShare: 0.4 } }), /sum to 1/);
  assert.throws(() => validateSwapOutcome({ expectedInputLamports: "10", actualInputLamports: "11", minOutput: "1", actualOutput: "1" }), /spent more/);
  assert.throws(() => validateSwapOutcome({ expectedInputLamports: "10", actualInputLamports: "10", minOutput: "2", actualOutput: "1" }), /below its quote minimum/);
  assert.deepEqual(validateSwapOutcome({ expectedInputLamports: "10", actualInputLamports: "8", minOutput: "1", actualOutput: "2" }), { unusedInputLamports: "2", outputLamports: "2" });
});

test("separates capital movement, LP fees, execution fees, and unrecovered rent", () => {
  const pnl = computeDualPnl({
    rawPnlSol: 0.1,
    depositsSol: 0.49,
    budgetSol: 0.5,
    feeIncomeSol: 0.03,
    transactionFeesSol: 0.01,
    rentPaidSol: 0.02,
    rentRecoveredSol: 0.015,
  });
  assert.equal(pnl.capitalPnlBeforeCostsSol, 0.07);
  assert.ok(Math.abs(pnl.capitalPnlSol - 0.045) < 1e-12);
  assert.ok(Math.abs(pnl.unrecoveredRentSol - 0.005) < 1e-12);
  assert.ok(Math.abs(pnl.netPnlSol - 0.075) < 1e-12);
  assert.ok(Math.abs(pnl.netPnlPct - 15) < 1e-12);
  assert.throws(() => computeDualPnl({ rawPnlSol: 1, depositsSol: 0, budgetSol: 0 }), /cannot be negative/);
  assert.throws(() => computeDualPnl({ rawPnlSol: 1, depositsSol: 1, budgetSol: 1, transactionFeesSol: null }), /inputs are incomplete/);
});

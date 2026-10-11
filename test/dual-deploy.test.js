import assert from "node:assert/strict";
import test from "node:test";
import {
  addOperationTokenDelta,
  buildDualDeployPlan,
  calculateOperationOwnedAmounts,
  computeDualPnl,
  confirmedTransactionHasSigner,
  getConfirmedOwnerMintDelta,
  hasUnresolvedSwapTransactions,
  validatePreparedDualSwapQuote,
  validateSwapOutcome,
} from "../tools/dual-deploy.js";

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

test("uses the signed Jupiter order's minimum when its quote changed after preflight", () => {
  const current = validatePreparedDualSwapQuote({
    expectedInput: "500000000", preparedInput: "500000000", minOutput: "1499999",
    priceImpactPct: 0.4, maxPriceImpactPct: 1,
  });
  assert.equal(current.minOutput, "1499999");
  assert.deepEqual(validateSwapOutcome({
    expectedInputLamports: "500000000", actualInputLamports: "500000000",
    minOutput: current.minOutput, actualOutput: "1499999",
  }), { unusedInputLamports: "0", outputLamports: "1499999" });
  assert.throws(() => validateSwapOutcome({
    expectedInputLamports: "500000000", actualInputLamports: "500000000",
    minOutput: current.minOutput, actualOutput: "1499998",
  }), /below its quote minimum/);
});

test("rejects changed input, invalid minimum, and excessive or unknown price impact", () => {
  const base = { expectedInput: "500000000", preparedInput: "500000000", minOutput: "1499999", priceImpactPct: 0.4, maxPriceImpactPct: 1 };
  assert.throws(() => validatePreparedDualSwapQuote({ ...base, preparedInput: "500000001" }), /differs from the planned/);
  assert.throws(() => validatePreparedDualSwapQuote({ ...base, minOutput: "0" }), /valid minimum/);
  assert.throws(() => validatePreparedDualSwapQuote({ ...base, priceImpactPct: 1.01 }), /price impact/);
  assert.throws(() => validatePreparedDualSwapQuote({ ...base, priceImpactPct: Number.NaN }), /price impact/);
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

test("attributes output to the confirmed swap transaction, independent of pre-existing wallet balances", () => {
  const transaction = {
    meta: {
      err: null,
      preTokenBalances: [
        { owner: "wallet", mint: "USDC", uiTokenAmount: { amount: "15385906" } },
        { owner: "wallet", mint: "STRK", uiTokenAmount: { amount: "0" } },
      ],
      postTokenBalances: [
        { owner: "wallet", mint: "USDC", uiTokenAmount: { amount: "15385906" } },
        { owner: "wallet", mint: "STRK", uiTokenAmount: { amount: "151779004048" } },
      ],
    },
  };
  assert.equal(getConfirmedOwnerMintDelta({ transaction, owner: "wallet", mint: "STRK" }), "151779004048");
  assert.equal(getConfirmedOwnerMintDelta({ transaction, owner: "wallet", mint: "USDC" }), "0");
  assert.equal(addOperationTokenDelta("0", "151779004048"), "151779004048");
});

test("attributes ATA creation, account closure, and multiple owned token accounts", () => {
  const transaction = {
    meta: {
      err: null,
      preTokenBalances: [
        { accountIndex: 3, owner: "wallet", mint: "STRK", uiTokenAmount: { amount: "40" } },
      ],
      postTokenBalances: [
        { accountIndex: 3, owner: "wallet", mint: "STRK", uiTokenAmount: { amount: "45" } },
        { accountIndex: 8, owner: "wallet", mint: "STRK", uiTokenAmount: { amount: "12" } },
        { accountIndex: 9, owner: "other", mint: "STRK", uiTokenAmount: { amount: "1000" } },
      ],
    },
  };
  assert.equal(getConfirmedOwnerMintDelta({ transaction, owner: "wallet", mint: "STRK" }), "17");
});

test("only confirmed operation-owned swaps and rollbacks determine recovery amounts", () => {
  const transactions = [
    { kind: "swap_x", signature: "buy-strk", status: "confirmed", metadata: { side: "x", role: "acquire", outputDeltaRaw: "151779004048" } },
    { kind: "swap_y", signature: "buy-usdc", status: "submitted", metadata: { side: "y", role: "acquire", outputDeltaRaw: "25000000" } },
    { kind: "rollback_x", signature: "sell-part-strk", status: "confirmed", metadata: { side: "x", role: "rollback", inputSpentRaw: "100000000000" } },
    { kind: "swap_y", signature: "failed-usdc", status: "failed", metadata: { side: "y", role: "acquire", outputDeltaRaw: "999999999" } },
  ];
  assert.deepEqual(calculateOperationOwnedAmounts(transactions), {
    x: "51779004048", y: "0", complete: true, missingSignatures: [],
  });
  assert.deepEqual(calculateOperationOwnedAmounts([...transactions, transactions[0]]), {
    x: "51779004048", y: "0", complete: true, missingSignatures: [],
  });
});

test("a failed second-side swap cannot make the operation claim or roll back pre-existing USDC", () => {
  const operationTransactions = [
    { kind: "swap_x", signature: "buy-strk", status: "confirmed", metadata: { side: "x", role: "acquire", outputDeltaRaw: "151779004048" } },
    { kind: "swap_y", signature: "usdc-never-submitted", status: "failed", metadata: { side: "y", role: "acquire" } },
  ];
  assert.deepEqual(calculateOperationOwnedAmounts(operationTransactions), {
    x: "151779004048", y: "0", complete: true, missingSignatures: [],
  });
  operationTransactions.push({
    kind: "rollback_x", signature: "return-strk-to-sol", status: "confirmed",
    metadata: { side: "x", role: "rollback", inputSpentRaw: "151779004048" },
  });
  assert.deepEqual(calculateOperationOwnedAmounts(operationTransactions), {
    x: "0", y: "0", complete: true, missingSignatures: [],
  });
});

test("reports missing confirmed deltas instead of guessing from a wallet balance", () => {
  const ledger = calculateOperationOwnedAmounts([
    { kind: "swap_y", signature: "legacy-swap", status: "confirmed", metadata: { side: "y" } },
  ]);
  assert.deepEqual(ledger, { x: "0", y: "0", complete: false, missingSignatures: ["legacy-swap"] });
});

test("refuses over-rollback and negative acquired amounts", () => {
  assert.throws(() => calculateOperationOwnedAmounts([
    { kind: "swap_x", signature: "buy", status: "confirmed", metadata: { side: "x", role: "acquire", outputDeltaRaw: "5" } },
    { kind: "rollback_x", signature: "overspend", status: "confirmed", metadata: { side: "x", role: "rollback", inputSpentRaw: "6" } },
  ]), /spends more/);
  assert.throws(() => addOperationTokenDelta("0", "-1"), /cannot be negative/);
});

test("does not interpret failed, unconfirmed, or incomplete transactions as token acquisitions", () => {
  const ledger = calculateOperationOwnedAmounts([
    { kind: "swap_x", signature: "failed", status: "failed", metadata: { side: "x", role: "acquire", outputDeltaRaw: "9" } },
    { kind: "swap_y", signature: "pending", status: "submitted", metadata: { side: "y", role: "acquire", outputDeltaRaw: "8" } },
  ]);
  assert.deepEqual(ledger, { x: "0", y: "0", complete: true, missingSignatures: [] });
});

test("waits for both mismatched Jupiter signatures to resolve before rollback or deploy", () => {
  const transactions = [
    { kind: "swap_x", signature: "journaled-signature", status: "superseded", metadata: { side: "x" } },
    { kind: "swap_x_response", signature: "jupiter-response-signature", status: "submitted", metadata: { side: "x" } },
  ];
  assert.equal(hasUnresolvedSwapTransactions(transactions), true);
  transactions[0].status = "failed";
  assert.equal(hasUnresolvedSwapTransactions(transactions), true);
  transactions[1].status = "confirmed";
  assert.equal(hasUnresolvedSwapTransactions(transactions), false);
});

test("requires a successful confirmed transaction with owner and mint attribution", () => {
  assert.throws(() => getConfirmedOwnerMintDelta({ transaction: {}, owner: "wallet", mint: "STRK" }), /successful confirmed/);
  assert.throws(() => getConfirmedOwnerMintDelta({ transaction: { meta: { err: { failed: true } } }, owner: "wallet", mint: "STRK" }), /successful confirmed/);
  assert.throws(() => getConfirmedOwnerMintDelta({ transaction: { meta: { err: null } }, owner: "", mint: "STRK" }), /requires owner and mint/);
});

test("accepts only transactions whose required signer set includes the configured wallet", () => {
  const transaction = {
    transaction: {
      message: {
        header: { numRequiredSignatures: 2 },
        staticAccountKeys: ["fee-payer", "wallet", "program"],
      },
    },
    meta: { err: null },
  };
  assert.equal(confirmedTransactionHasSigner(transaction, "wallet"), true);
  assert.equal(confirmedTransactionHasSigner(transaction, "program"), false);
  assert.equal(confirmedTransactionHasSigner({ transaction: { message: { staticAccountKeys: ["wallet"] } } }, "wallet"), false);
});

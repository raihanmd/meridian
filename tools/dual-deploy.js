import { computeDualValueSplit } from "./dual-ta.js";

export function buildDualDeployPlan({
  mintX,
  mintY,
  solMint,
  amountSol,
  walletSol,
  reserveSol,
  valueSplit,
  routes = {},
}) {
  if (!mintX || !mintY || !solMint || mintX === mintY) throw new Error("Dual deploy requires two distinct pool mints and a SOL mint");
  const budget = Number(amountSol);
  const balance = Number(walletSol);
  const reserve = Number(reserveSol);
  if (![budget, balance, reserve].every(Number.isFinite) || budget <= 0 || reserve < 0) throw new Error("Dual deploy budget, wallet balance, or reserve is invalid");
  if (balance + 1e-9 < budget + reserve) throw new Error(`Insufficient SOL: ${budget} SOL budget plus ${reserve} SOL reserve exceeds wallet balance ${balance} SOL`);
  if (!valueSplit || !Number.isFinite(valueSplit.xValueShare) || !Number.isFinite(valueSplit.yValueShare) || valueSplit.xValueShare <= 0 || valueSplit.yValueShare <= 0) {
    throw new Error("TA distribution must allocate positive value to both pool sides");
  }
  const sum = valueSplit.xValueShare + valueSplit.yValueShare;
  if (Math.abs(sum - 1) > 1e-6) throw new Error("TA distribution value shares must sum to 1");
  const sidePlans = [
    { side: "x", mint: mintX, budgetSol: budget * valueSplit.xValueShare },
    { side: "y", mint: mintY, budgetSol: budget * valueSplit.yValueShare },
  ];
  const swaps = sidePlans.filter((side) => side.mint !== solMint).map((side) => {
    if (routes[side.mint] !== true) throw new Error(`No validated SOL swap route for pool token ${side.mint}`);
    return { side: side.side, inputMint: solMint, outputMint: side.mint, inputSol: side.budgetSol };
  });
  const retainedSol = sidePlans.filter((side) => side.mint === solMint).reduce((total, side) => total + side.budgetSol, 0);
  return {
    budgetSol: budget,
    reserveSol: reserve,
    sides: sidePlans,
    swaps,
    retainedSol,
    tokenXIsSol: mintX === solMint,
    tokenYIsSol: mintY === solMint,
  };
}

export function validateSwapOutcome({ expectedInputLamports, actualInputLamports, minOutput, actualOutput }) {
  const values = [expectedInputLamports, actualInputLamports, minOutput, actualOutput].map((value) => BigInt(value));
  const [expectedInput, actualInput, minimumOutput, output] = values;
  if (expectedInput <= 0n || actualInput <= 0n || minimumOutput <= 0n || output <= 0n) throw new Error("Swap outcome has a zero or negative amount");
  if (actualInput > expectedInput) throw new Error("Swap spent more SOL than the journaled allocation");
  if (output < minimumOutput) throw new Error("Swap output is below its quote minimum");
  return { unusedInputLamports: (expectedInput - actualInput).toString(), outputLamports: output.toString() };
}

/**
 * Return the exact net token delta for one owner and mint in a confirmed
 * transaction. This is transaction scoped: wallet balances that existed
 * before the operation, or changed in another transaction, are never counted.
 */
export function getConfirmedOwnerMintDelta({ transaction, owner, mint }) {
  if (!transaction?.meta || transaction.meta.err) throw new Error("Cannot attribute token delta without a successful confirmed transaction");
  if (!owner || !mint) throw new Error("Token delta attribution requires owner and mint");
  const readAmount = (balances) => (balances || [])
    .filter((entry) => entry.owner === owner && entry.mint === mint)
    .reduce((sum, entry) => sum + BigInt(entry.uiTokenAmount?.amount ?? "0"), 0n);
  const before = readAmount(transaction.meta.preTokenBalances);
  const after = readAmount(transaction.meta.postTokenBalances);
  return (after - before).toString();
}

export function confirmedTransactionHasSigner(transaction, owner) {
  const message = transaction?.transaction?.message ?? transaction?.message;
  const keys = message?.staticAccountKeys ?? message?.accountKeys;
  const signerCount = Number(message?.header?.numRequiredSignatures);
  if (!Array.isArray(keys) || !Number.isInteger(signerCount) || signerCount <= 0 || !owner) return false;
  return keys.slice(0, signerCount).some((key) => String(key?.pubkey ?? key) === owner);
}

export function addOperationTokenDelta(priorRaw, transactionDeltaRaw) {
  const prior = BigInt(priorRaw ?? "0");
  const delta = BigInt(transactionDeltaRaw);
  if (prior < 0n || delta < 0n) throw new Error("Operation-owned token amounts cannot be negative");
  return (prior + delta).toString();
}

export function calculateOperationOwnedAmounts(transactions = []) {
  const totals = { x: 0n, y: 0n };
  const acquired = { x: 0n, y: 0n };
  const spent = { x: 0n, y: 0n };
  const missing = [];
  const seenSignatures = new Set();
  for (const tx of transactions) {
    if (tx.status !== "confirmed" || seenSignatures.has(tx.signature)) continue;
    seenSignatures.add(tx.signature);
    const side = tx.metadata?.side ?? (tx.kind?.match(/(?:swap|rollback)_([xy])/)?.[1] ?? null);
    if (!side) continue;
    if (tx.metadata?.role === "acquire" || tx.kind?.startsWith(`swap_${side}`)) {
      const amount = tx.metadata?.outputDeltaRaw;
      if (amount == null) { missing.push(tx.signature); continue; }
      const value = BigInt(amount);
      if (value <= 0n) throw new Error(`Confirmed acquisition ${tx.signature} has no positive transaction-scoped token delta`);
      acquired[side] += value;
    } else if (tx.metadata?.role === "rollback" || tx.kind?.startsWith(`rollback_${side}`)) {
      const amount = tx.metadata?.inputSpentRaw;
      if (amount == null) { missing.push(tx.signature); continue; }
      const value = BigInt(amount);
      if (value <= 0n) throw new Error(`Confirmed rollback ${tx.signature} has no positive transaction-scoped spend`);
      spent[side] += value;
    }
  }
  for (const side of ["x", "y"]) {
    if (spent[side] > acquired[side]) throw new Error(`Confirmed rollback spends more ${side.toUpperCase()} than this operation acquired`);
    totals[side] = acquired[side] - spent[side];
  }
  return { x: totals.x.toString(), y: totals.y.toString(), complete: missing.length === 0, missingSignatures: missing };
}

export function hasUnresolvedSwapTransactions(transactions = []) {
  return transactions.some((transaction) =>
    ["signed", "submitted", "superseded"].includes(transaction.status)
      && (transaction.kind?.startsWith("swap_") || transaction.kind?.startsWith("rollback_")));
}

export function computeDualPnl({ rawPnlSol, depositsSol, budgetSol, feeIncomeSol = 0, transactionFeesSol = 0, rentPaidSol = 0, rentRecoveredSol = 0 }) {
  if ([rawPnlSol, depositsSol, budgetSol, feeIncomeSol, transactionFeesSol, rentPaidSol, rentRecoveredSol].some((value) => value == null || value === "")) {
    throw new Error("Dual PnL inputs are incomplete; fee and rent accounting must be verified");
  }
  const values = [rawPnlSol, depositsSol, budgetSol, feeIncomeSol, transactionFeesSol, rentPaidSol, rentRecoveredSol].map(Number);
  if (!values.every(Number.isFinite) || values[1] < 0 || values[2] <= 0 || values.slice(3).some((value) => value < 0)) {
    throw new Error("Dual PnL inputs must be finite and costs/budget cannot be negative");
  }
  const [rawPnl, deposits, budget, feeIncome, fees, rentPaid, rentRecovered] = values;
  const rentLoss = Math.max(0, rentPaid - rentRecovered);
  const netPnlSol = rawPnl + deposits - budget - fees - rentLoss;
  return {
    rawPnlSol,
    capitalPnlBeforeCostsSol: rawPnl - feeIncome,
    capitalPnlSol: rawPnl - feeIncome + deposits - budget - fees - rentLoss,
    feeIncomeSol: feeIncome,
    executionFeesSol: fees,
    rentPaidSol: rentPaid,
    rentRecoveredSol: rentRecovered,
    unrecoveredRentSol: rentLoss,
    netPnlSol,
    netPnlPct: (netPnlSol / budget) * 100,
  };
}

export { computeDualValueSplit };

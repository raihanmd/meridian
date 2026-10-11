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

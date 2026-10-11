import {
  Connection,
  Keypair,
  PublicKey,
  SystemInstruction,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  VersionedTransaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import BN from "bn.js";
import bs58 from "bs58";
import { config, computeDeployAmount, MIN_SAFE_BINS_BELOW } from "../config.js";
import { log } from "../logger.js";
import {
  trackPosition,
  markOutOfRange,
  markInRange,
  recordClaim,
  recordClose,
  getTrackedPosition,
  getTrackedPositions,
  minutesOutOfRange,
  syncOpenPositions,
} from "../state.js";
import { recordPerformance } from "../lessons.js";
import { isBaseMintOnCooldown, isPoolOnCooldown } from "../pool-memory.js";
import { normalizeMint, quoteSolSwap, resumeJupiterSwap, swapToken } from "./wallet.js";
import { appendDecision } from "../decision-log.js";
import { agentMeridianJson, getAgentIdForRequests, getAgentMeridianHeaders } from "./agent-meridian.js";
import { getAndClearStagedSignals } from "../signal-tracker.js";
import { computePositions, fetchDlmmPnlForPool, getSolUsdPrice } from "./pnl.js";
import { verifyMissingPositions } from "./position-discovery.js";
import { getDualPoolRestrictionReason, getPoolRestrictionReason } from "../token-allowlist.js";
import { analyzeDualTokenRange, fetchDualTokenOhlcv } from "./dual-ta.js";
import {
  addOperationTokenDelta,
  buildDualDeployPlan,
  calculateOperationOwnedAmounts,
  confirmedTransactionHasSigner,
  computeDualPnl,
  computeDualValueSplit,
  getConfirmedOwnerMintDelta,
  hasUnresolvedSwapTransactions,
  validatePreparedDualSwapQuote,
  validateSwapOutcome,
} from "./dual-deploy.js";
import { dualOperationJournal } from "./dual-operations.js";

// ─── Lazy SDK loader ───────────────────────────────────────────
// @meteora-ag/dlmm → @coral-xyz/anchor uses CJS directory imports
// that break in ESM on Node 24. Dynamic import defers loading until
// an actual on-chain call is needed (never triggered in dry-run).
let _DLMM = null;
let _StrategyType = null;
let _getBinIdFromPrice = null;
let _getPriceOfBinByBinId = null;
let _getBinArrayKeysCoverage = null;
let _getBinArrayIndexesCoverage = null;
let _deriveBinArrayBitmapExtension = null;
let _isOverflowDefaultBinArrayBitmap = null;
let _BIN_ARRAY_FEE = null;
let _BIN_ARRAY_BITMAP_FEE = null;
let _calculateSpotDistribution = null;
let _calculateNormalDistribution = null;

async function getDLMM() {
  if (!_DLMM) {
    const mod = await import("@meteora-ag/dlmm");
    _DLMM = mod.default;
    _StrategyType = mod.StrategyType;
    _getBinIdFromPrice = mod.default?.getBinIdFromPrice;
    _getPriceOfBinByBinId = mod.getPriceOfBinByBinId;
    _getBinArrayKeysCoverage = mod.getBinArrayKeysCoverage;
    _getBinArrayIndexesCoverage = mod.getBinArrayIndexesCoverage;
    _deriveBinArrayBitmapExtension = mod.deriveBinArrayBitmapExtension;
    _isOverflowDefaultBinArrayBitmap = mod.isOverflowDefaultBinArrayBitmap;
    _BIN_ARRAY_FEE = mod.BIN_ARRAY_FEE;
    _BIN_ARRAY_BITMAP_FEE = mod.BIN_ARRAY_BITMAP_FEE;
    _calculateSpotDistribution = mod.calculateSpotDistribution;
    _calculateNormalDistribution = mod.calculateNormalDistribution;
  }
  return {
    DLMM: _DLMM,
    StrategyType: _StrategyType,
    getBinIdFromPrice: _getBinIdFromPrice,
    getPriceOfBinByBinId: _getPriceOfBinByBinId,
    getBinArrayKeysCoverage: _getBinArrayKeysCoverage,
    getBinArrayIndexesCoverage: _getBinArrayIndexesCoverage,
    deriveBinArrayBitmapExtension: _deriveBinArrayBitmapExtension,
    isOverflowDefaultBinArrayBitmap: _isOverflowDefaultBinArrayBitmap,
    BIN_ARRAY_FEE: _BIN_ARRAY_FEE,
    BIN_ARRAY_BITMAP_FEE: _BIN_ARRAY_BITMAP_FEE,
    calculateSpotDistribution: _calculateSpotDistribution,
    calculateNormalDistribution: _calculateNormalDistribution,
  };
}

// ─── Lazy wallet/connection init ──────────────────────────────
// Avoids crashing on import when WALLET_PRIVATE_KEY is not yet set
// (e.g. during screening-only tests).
let _connection = null;
let _wallet = null;

function getConnection() {
  if (!_connection) {
    _connection = new Connection(process.env.RPC_URL, "confirmed");
  }
  return _connection;
}

function getWallet() {
  if (!_wallet) {
    if (!process.env.WALLET_PRIVATE_KEY) {
      throw new Error("WALLET_PRIVATE_KEY not set");
    }
    _wallet = Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY));
    log("init", `Wallet: ${_wallet.publicKey.toString()}`);
  }
  return _wallet;
}

function shouldUseLpAgentRelay() {
  return !!config.api.lpAgentRelayEnabled;
}

function shouldUseLpAgentRelayForDeploy() {
  // Zap-in relay is intentionally disabled; deploys use the local Meteora SDK path.
  return false;
}

function signSerializedTransaction(serialized, wallet) {
  const bytes = Buffer.from(serialized, "base64");
  try {
    const versioned = VersionedTransaction.deserialize(bytes);
    versioned.sign([wallet]);
    return Buffer.from(versioned.serialize()).toString("base64");
  } catch {
    const legacy = Transaction.from(bytes);
    legacy.partialSign(wallet);
    return legacy
      .serialize({ requireAllSignatures: false, verifySignatures: false })
      .toString("base64");
  }
}

function deserializeSignedTransaction(signedBase64) {
  const bytes = Buffer.from(signedBase64, "base64");
  try {
    return VersionedTransaction.deserialize(bytes);
  } catch {
    return Transaction.from(bytes);
  }
}

function getStaticAccountKeyStrings(tx) {
  if (tx instanceof VersionedTransaction) {
    return tx.message.staticAccountKeys.map((key) => key.toString());
  }
  return tx.compileMessage().accountKeys.map((key) => key.toString());
}

function getTransactionInstructions(tx) {
  if (!(tx instanceof VersionedTransaction)) return tx.instructions;

  const keys = tx.message.staticAccountKeys;
  return tx.message.compiledInstructions
    .map((ix) => {
      const programId = keys[ix.programIdIndex];
      if (!programId) return null;
      const indexes = ix.accountKeyIndexes || ix.accounts || [];
      const accounts = indexes
        .map((accountIndex) => keys[accountIndex])
        .filter(Boolean);
      return new TransactionInstruction({
        programId,
        keys: accounts.map((pubkey) => ({ pubkey, isSigner: false, isWritable: false })),
        data: Buffer.from(ix.data),
      });
    })
    .filter(Boolean);
}

function assertNoUnsafeSystemTransfer(tx, wallet, allowedDestinations = []) {
  const owner = wallet.publicKey.toString();
  const allowed = new Set(allowedDestinations.filter(Boolean).map(String));

  for (const ix of getTransactionInstructions(tx)) {
    if (!ix.programId.equals(SystemProgram.programId)) continue;

    let type = null;
    try {
      type = SystemInstruction.decodeInstructionType(ix);
    } catch {
      continue;
    }
    if (type !== "Transfer" && type !== "TransferWithSeed") continue;

    const decoded = type === "Transfer"
      ? SystemInstruction.decodeTransfer(ix)
      : SystemInstruction.decodeTransferWithSeed(ix);
    const source = decoded.fromPubkey?.toString();
    const destination = decoded.toPubkey?.toString();
    if (source === owner && !allowed.has(destination)) {
      throw new Error(
        `Relay transaction contains direct SOL transfer from owner to ${destination?.slice(0, 8) || "unknown"}.`,
      );
    }
  }
}

function signSerializedTransactions(serializedTxs, wallet) {
  return (serializedTxs || [])
    .filter((entry) => typeof entry === "string" && entry.length > 0)
    .map((entry) => signSerializedTransaction(entry, wallet));
}

async function signAndSimulateRelayTransactions(serializedTxs, wallet, {
  label,
  allowedDebitMints = [],
  allowedSystemTransferDestinations = [],
  maxSolLoss = 0.05,
  requiredStaticAccounts = [],
} = {}) {
  const signed = [];
  const owner = wallet.publicKey.toString();
  const allowedMints = new Set(allowedDebitMints.filter(Boolean).map(String));
  const maxLamportLoss = Math.floor(Number(maxSolLoss) * 1e9);

  for (const [index, serialized] of (serializedTxs || []).entries()) {
    if (typeof serialized !== "string" || serialized.length === 0) continue;

    const signedBase64 = signSerializedTransaction(serialized, wallet);
    const tx = deserializeSignedTransaction(signedBase64);
    assertNoUnsafeSystemTransfer(tx, wallet, allowedSystemTransferDestinations);
    const staticKeys = getStaticAccountKeyStrings(tx);
    for (const account of requiredStaticAccounts.filter(Boolean)) {
      if (!staticKeys.includes(String(account))) {
        throw new Error(`Relay ${label || "transaction"} ${index + 1} missing required account ${String(account).slice(0, 8)}.`);
      }
    }

    const ownerIndex = staticKeys.indexOf(owner);
    const simulation = await getConnection().simulateTransaction(tx, {
      sigVerify: false,
      replaceRecentBlockhash: false,
    });
    const value = simulation.value;
    if (value.err) {
      throw new Error(`Relay ${label || "transaction"} ${index + 1} simulation failed: ${JSON.stringify(value.err)}`);
    }

    if (ownerIndex >= 0 && value.preBalances?.[ownerIndex] != null && value.postBalances?.[ownerIndex] != null) {
      const lamportDelta = value.postBalances[ownerIndex] - value.preBalances[ownerIndex];
      if (lamportDelta < -maxLamportLoss) {
        throw new Error(
          `Relay ${label || "transaction"} ${index + 1} would debit ${(Math.abs(lamportDelta) / 1e9).toFixed(6)} SOL from owner.`,
        );
      }
    }

    const preByMint = new Map();
    for (const balance of value.preTokenBalances || []) {
      if (balance.owner !== owner) continue;
      preByMint.set(balance.mint, BigInt(balance.uiTokenAmount?.amount || "0"));
    }
    for (const balance of value.postTokenBalances || []) {
      if (balance.owner !== owner) continue;
      const preAmount = preByMint.get(balance.mint) ?? 0n;
      const postAmount = BigInt(balance.uiTokenAmount?.amount || "0");
      if (postAmount < preAmount && !allowedMints.has(balance.mint)) {
        throw new Error(
          `Relay ${label || "transaction"} ${index + 1} would debit unrelated token mint ${balance.mint}.`,
        );
      }
      preByMint.delete(balance.mint);
    }
    for (const [mint, preAmount] of preByMint) {
      if (preAmount > 0n && !allowedMints.has(mint)) {
        throw new Error(`Relay ${label || "transaction"} ${index + 1} would close/debit unrelated token mint ${mint}.`);
      }
    }

    signed.push(signedBase64);
  }

  return signed;
}

function normalizeExecutionSignatures(result) {
  const signatures = [];
  const seen = new Set();
  for (const value of []
    .concat(result?.signatures || [])
    .concat(result?.result?.txHashes || [])
    .concat(result?.result?.signatures || [])
    .concat(result?.result?.signature ? [result.result.signature] : [])) {
    if (typeof value !== "string" || !value) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    signatures.push(value);
  }
  return signatures;
}

const METEORA_INIT_BIN_ARRAY_DISCRIMINATOR = Buffer.from([35, 86, 19, 185, 78, 212, 75, 211]).toString("hex");
const METEORA_INIT_BITMAP_EXTENSION_DISCRIMINATOR = Buffer.from([47, 157, 226, 180, 12, 240, 33, 71]).toString("hex");

function getDlmmProgramId() {
  return new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
}

function formatSolFee(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number.toFixed(8).replace(/0+$/, "").replace(/\.$/, "") : "unknown";
}

async function assertRangeDoesNotRequireBinArrayInitialization(pool, minBinId, maxBinId) {
  const {
    getBinArrayKeysCoverage,
    getBinArrayIndexesCoverage,
    deriveBinArrayBitmapExtension,
    isOverflowDefaultBinArrayBitmap,
    BIN_ARRAY_FEE,
    BIN_ARRAY_BITMAP_FEE,
  } = await getDLMM();

  if (!getBinArrayKeysCoverage || !getBinArrayIndexesCoverage) {
    throw new Error("Cannot verify Meteora bin-array initialization risk; refusing deploy.");
  }

  const programId = getDlmmProgramId();
  const poolPubkey = new PublicKey(pool.pubkey?.toString?.() || pool.lbPair?.publicKey?.toString?.() || pool.lbPair?.pubkey?.toString?.());
  const lower = new BN(Math.min(minBinId, maxBinId));
  const upper = new BN(Math.max(minBinId, maxBinId));
  const indexes = getBinArrayIndexesCoverage(lower, upper);
  const keys = getBinArrayKeysCoverage(lower, upper, poolPubkey, programId);
  const accounts = await getConnection().getMultipleAccountsInfo(keys, "confirmed");
  const missing = accounts
    .map((account, index) => account ? null : {
      index: indexes[index]?.toString?.() ?? String(index),
      address: keys[index].toString(),
    })
    .filter(Boolean);

  if (missing.length > 0) {
    const totalFee = missing.length * Number(BIN_ARRAY_FEE ?? 0.07143744);
    const sample = missing.slice(0, 3).map((entry) => `${entry.index}:${entry.address.slice(0, 8)}`).join(", ");
    throw new Error(
      `Deploy skipped: selected range requires ${missing.length} missing Meteora bin-array initialization(s) ` +
      `(~${formatSolFee(totalFee)} SOL non-refundable pool rent; ${formatSolFee(BIN_ARRAY_FEE ?? 0.07143744)} SOL each). ` +
      `Missing indexes: ${sample}${missing.length > 3 ? ", ..." : ""}. Pick an already-initialized range/pool.`,
    );
  }

  if (deriveBinArrayBitmapExtension && isOverflowDefaultBinArrayBitmap) {
    const needsBitmapExtension = indexes.some((index) => isOverflowDefaultBinArrayBitmap(index));
    if (needsBitmapExtension) {
      const [bitmapExtension] = deriveBinArrayBitmapExtension(poolPubkey, programId);
      const account = await getConnection().getAccountInfo(bitmapExtension, "confirmed");
      if (!account) {
        throw new Error(
          `Deploy skipped: selected range requires Meteora bin-array bitmap extension initialization ` +
          `(~${formatSolFee(BIN_ARRAY_BITMAP_FEE ?? 0.01180416)} SOL non-refundable pool rent). Pick a closer initialized range/pool.`,
        );
      }
    }
  }
}

async function getMintBalanceRaw(owner, mint) {
  if (mint === config.tokens.SOL) return (await getConnection().getBalance(owner, "confirmed")).toString();
  const mintAccount = await getConnection().getAccountInfo(new PublicKey(mint), "confirmed");
  if (!mintAccount) throw new Error(`Token mint ${mint} does not exist`);
  const accounts = await getConnection().getParsedTokenAccountsByOwner(owner, { programId: mintAccount.owner }, "confirmed");
  return accounts.value.reduce((total, account) => {
    const info = account.account.data?.parsed?.info;
    if (info?.mint !== mint) return total;
    return total + BigInt(info?.tokenAmount?.amount || "0");
  }, 0n).toString();
}

async function readSignatureStatus(signature) {
  const response = await getConnection().getSignatureStatuses([signature], { searchTransactionHistory: true });
  return response.value[0] ?? null;
}

async function getConfirmedTransactionFeeSol(signature) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const transaction = await getConnection().getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    }).catch(() => null);
    if (transaction?.meta && Number.isFinite(transaction.meta.fee)) return transaction.meta.fee / 1e9;
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return null;
}

async function getConfirmedTransaction(signature) {
  return getConnection().getTransaction(signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  }).catch(() => null);
}

function dualSwapSide(transaction) {
  return transaction.metadata?.side ?? transaction.kind?.match(/(?:swap|rollback)_([xy])/)?.[1] ?? null;
}

function dualTransactionMint(operation, transaction) {
  const side = dualSwapSide(transaction);
  const isRollback = transaction.metadata?.role === "rollback" || transaction.kind.startsWith("rollback_");
  return (isRollback ? transaction.metadata?.input_mint : transaction.metadata?.output_mint)
    ?? (side === "x" ? operation.plan.token_x_mint : operation.plan.token_y_mint);
}

async function recordJupiterExecutionResponse(operationId, transaction, response) {
  const signature = response?.signature;
  const metadata = {
    executionStatus: response?.status ?? null,
    executionCode: response?.code ?? null,
    executionInputRaw: response?.inputAmountResult ?? null,
    executionOutputRaw: response?.outputAmountResult ?? null,
    executionTotalInputRaw: response?.totalInputAmount ?? null,
    executionTotalOutputRaw: response?.totalOutputAmount ?? null,
    executionReportedAt: new Date().toISOString(),
  };
  if (!signature) {
    await dualOperationJournal.recordTransaction(operationId, { ...transaction, metadata });
    return;
  }
  if (signature === transaction.signature) {
    await dualOperationJournal.recordTransaction(operationId, { ...transaction, status: "submitted", metadata });
    return;
  }

  await dualOperationJournal.recordTransaction(operationId, {
    ...transaction,
    status: "superseded",
    metadata: { ...metadata, responseSignature: signature },
  });
  await dualOperationJournal.recordTransaction(operationId, {
    kind: `${transaction.kind}_response`,
    signature,
    status: "submitted",
    metadata: {
      side: dualSwapSide(transaction),
      role: transaction.kind.startsWith("rollback_") ? "rollback" : "acquire",
      input_mint: transaction.metadata?.input_mint,
      output_mint: transaction.metadata?.output_mint,
      amount_raw: transaction.metadata?.amount_raw,
      requestId: transaction.metadata?.requestId,
      lastValidBlockHeight: transaction.metadata?.lastValidBlockHeight,
      relatedSignature: transaction.signature,
      ...metadata,
    },
  });
}

function sumRecordedDualTransactionFees(operation) {
  const confirmed = (operation.transactions || []).filter((transaction) => transaction.status === "confirmed");
  if (confirmed.some((transaction) => transaction.metadata?.feeSol == null || !Number.isFinite(Number(transaction.metadata.feeSol)))) return null;
  return confirmed.reduce((total, transaction) => total + Number(transaction.metadata.feeSol), 0);
}

async function readPositionRentSol(positionAddress) {
  const account = await getConnection().getAccountInfo(new PublicKey(positionAddress), "confirmed").catch(() => null);
  return account?.lamports != null ? account.lamports / 1e9 : null;
}

async function syncVerifiedOpenPositions(activeAddresses) {
  const { confirmedMissing, unresolved } = await verifyMissingPositions(
    activeAddresses,
    getTrackedPositions(true),
    (address) => getConnection().getAccountInfo(new PublicKey(address), "confirmed"),
  );
  if (unresolved.length) throw new Error(`Position discovery incomplete for ${unresolved.map((address) => address.slice(0, 8)).join(", ")}; on-chain presence is unresolved`);
  syncOpenPositions(activeAddresses, confirmedMissing);
}

async function signedTransactionStillValid(signedTransaction) {
  try {
    const bytes = Buffer.from(signedTransaction, "base64");
    const tx = VersionedTransaction.deserialize(bytes);
    const blockhash = tx.message.recentBlockhash;
    return (await getConnection().isBlockhashValid(blockhash, "confirmed")).value;
  } catch {
    try {
      const tx = Transaction.from(Buffer.from(signedTransaction, "base64"));
      if (!tx.recentBlockhash) return false;
      return (await getConnection().isBlockhashValid(tx.recentBlockhash, "confirmed")).value;
    } catch {
      return false;
    }
  }
}

async function finalizeDualPosition(operation, pool, wallet) {
  const plan = operation.plan;
  const xRaw = operation.amountXRaw ?? operation.acquiredRaw?.x;
  const yRaw = operation.amountYRaw ?? operation.acquiredRaw?.y;
  const decimalsX = operation.tokenDecimals?.x;
  const decimalsY = operation.tokenDecimals?.y;
  if (!operation.positionAddress || !xRaw || !yRaw || !Number.isInteger(decimalsX) || !Number.isInteger(decimalsY)) {
    throw new Error(`Dual operation ${operation.id} lacks persisted position or amount details`);
  }
  const recordedFees = sumRecordedDualTransactionFees(operation);
  const transactionFeesSol = recordedFees === null ? null : recordedFees ?? operation.transactionFeesSol ?? null;
  const positionRentPaidSol = await readPositionRentSol(operation.positionAddress);
  trackPosition({
    position: operation.positionAddress, pool: operation.poolAddress, pool_name: plan.pool_name,
    strategy: plan.strategy,
    bin_range: { min: plan.min_bin_id, max: plan.max_bin_id, bins_below: plan.bins_below, bins_above: plan.bins_above },
    amount_sol: plan.amount_sol,
    amount_x: Number(xRaw) / 10 ** decimalsX,
    active_bin: plan.active_bin, bin_step: plan.bin_step, volatility: plan.volatility,
    fee_tvl_ratio: plan.fee_tvl_ratio, organic_score: plan.organic_score, initial_value_usd: plan.initial_value_usd,
    entry_mcap: plan.entry_mcap, entry_tvl: plan.entry_tvl, entry_volume: plan.entry_volume, entry_holders: plan.entry_holders,
    token_x_mint: plan.token_x_mint, token_y_mint: plan.token_y_mint, dual_token: true,
    dual_deploy: {
      amount_sol: plan.amount_sol, x_raw: String(xRaw), y_raw: String(yRaw), x_decimals: decimalsX, y_decimals: decimalsY,
      swaps: operation.swapResults || {}, position_rent_estimate_sol: operation.positionRentSol,
      position_rent_paid_sol: positionRentPaidSol,
      ata_rent_budget_sol: plan.ata_rent_budget_sol, ta: plan.ta.metrics,
      transaction_fees_sol: transactionFeesSol,
      fee_accounting_complete: transactionFeesSol != null,
    },
  });
  await dualOperationJournal.transition(operation.id, "completed", {
    completedAt: new Date().toISOString(),
    ...(operation.recoveryError ? { reconciledError: operation.recoveryError, recoveryError: null } : {}),
  });
  _positionsCacheAt = 0;
  return {
    success: true, dual_token: true, position: operation.positionAddress, pool: operation.poolAddress,
    pool_name: plan.pool_name, strategy: plan.strategy,
    bin_range: { min: plan.min_bin_id, max: plan.max_bin_id, active: plan.active_bin },
    price_range: plan.price_range, amount_sol: plan.amount_sol,
    token_x_mint: plan.token_x_mint, token_y_mint: plan.token_y_mint,
    amount_x: Number(xRaw) / 10 ** decimalsX, amount_y: Number(yRaw) / 10 ** decimalsY,
    txs: [...Object.values(operation.swapResults || {}).map((result) => result.tx).filter(Boolean), operation.positionSignature],
    rent_estimate_sol: operation.positionRentSol, reserve_sol: operation.reserveSol,
    transaction_fees_sol: transactionFeesSol, fee_accounting_complete: transactionFeesSol != null, ta: plan.ta.metrics,
  };
}

async function reconcileDualOperation(operation, pool, wallet) {
  for (const transaction of operation.transactions || []) {
    if (transaction.status !== "confirmed") continue;
    const isAcquire = transaction.kind.startsWith("swap_");
    const isRollback = transaction.kind.startsWith("rollback_");
    if (!isAcquire && !isRollback) continue;
    const recordedAmount = isRollback ? transaction.metadata?.inputSpentRaw : transaction.metadata?.outputDeltaRaw;
    if (recordedAmount != null) continue;
    const confirmedTx = await getConfirmedTransaction(transaction.signature);
    if (!confirmedTx?.meta || confirmedTx.meta.err || !confirmedTransactionHasSigner(confirmedTx, wallet.publicKey.toString())) {
      return { success: false, recovery_pending: true, operation_id: operation.id, error: `Legacy confirmed swap ${transaction.signature} has no verifiable transaction evidence; manual reconciliation required` };
    }
    const mint = dualTransactionMint(operation, transaction);
    const side = dualSwapSide(transaction);
    if (!mint || !side) return { success: false, recovery_pending: true, operation_id: operation.id, error: `Legacy confirmed swap ${transaction.signature} lacks mint/side attribution` };
    const delta = BigInt(getConfirmedOwnerMintDelta({ transaction: confirmedTx, owner: wallet.publicKey.toString(), mint }));
    if ((isRollback && delta >= 0n) || (isAcquire && delta <= 0n)) {
      return { success: false, recovery_pending: true, operation_id: operation.id, error: `Legacy confirmed swap ${transaction.signature} has no attributable token delta` };
    }
    await dualOperationJournal.recordTransaction(operation.id, {
      ...transaction,
      status: "confirmed",
      metadata: {
        ...transaction.metadata,
        side,
        role: isRollback ? "rollback" : "acquire",
        ...(isRollback ? { inputSpentRaw: (-delta).toString() } : { outputDeltaRaw: delta.toString() }),
        feeSol: transaction.metadata?.feeSol ?? (Number.isFinite(confirmedTx.meta.fee) ? confirmedTx.meta.fee / 1e9 : null),
        deltaRecoveredFromRpc: true,
      },
    });
  }
  operation = await dualOperationJournal.get(operation.id);
  const unresolved = (operation.transactions || []).filter((transaction) => ["signed", "submitted", "superseded"].includes(transaction.status));
  for (const transaction of unresolved) {
    const status = await readSignatureStatus(transaction.signature);
    if (status?.err) {
      await dualOperationJournal.recordTransaction(operation.id, { ...transaction, status: "failed", metadata: { rpcError: status.err } });
      continue;
    }
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") {
      const confirmedTx = await getConfirmedTransaction(transaction.signature);
      if (!confirmedTx?.meta || confirmedTx.meta.err) continue;
      const isRollback = transaction.metadata?.role === "rollback" || transaction.kind.startsWith("rollback_");
      const side = dualSwapSide(transaction);
      if (!side || !transaction.kind.startsWith("swap_") && !isRollback) continue;
      const mint = dualTransactionMint(operation, transaction);
      if (!mint) continue;
      if (!confirmedTransactionHasSigner(confirmedTx, wallet.publicKey.toString())) {
        await dualOperationJournal.transition(operation.id, "recovery_pending", {
          recoveryError: `Confirmed transaction ${transaction.signature} is not signed by this wallet; manual reconciliation required`,
        });
        return { success: false, recovery_pending: true, operation_id: operation.id, error: "Confirmed signature is not signed by the configured wallet; no token balance was attributed" };
      }
      const deltaRaw = getConfirmedOwnerMintDelta({ transaction: confirmedTx, owner: wallet.publicKey.toString(), mint });
      const amountRaw = BigInt(deltaRaw);
      if ((isRollback && amountRaw >= 0n) || (!isRollback && amountRaw <= 0n)) {
        await dualOperationJournal.transition(operation.id, "recovery_pending", {
          recoveryError: `Confirmed transaction ${transaction.signature} has no attributable ${isRollback ? "token spend" : "token output"}; manual reconciliation required`,
        });
        return { success: false, recovery_pending: true, operation_id: operation.id, error: "Confirmed swap token movement could not be attributed; no wallet balance fallback was used" };
      }
      const feeSol = Number.isFinite(confirmedTx.meta.fee) ? confirmedTx.meta.fee / 1e9 : null;
      const metadata = {
        ...transaction.metadata,
        side,
        role: isRollback ? "rollback" : "acquire",
        ...(isRollback ? { inputSpentRaw: (-amountRaw).toString() } : { outputDeltaRaw: amountRaw.toString() }),
        feeSol,
      };
      const latest = await dualOperationJournal.get(operation.id);
      const updatedTransactions = (latest.transactions || []).map((entry) => entry.signature === transaction.signature
        ? { ...entry, status: "confirmed", metadata: { ...entry.metadata, ...metadata } }
        : entry);
      const owned = calculateOperationOwnedAmounts(updatedTransactions);
      if (!owned.complete) {
        await dualOperationJournal.recordTransaction(operation.id, { ...transaction, status: "confirmed", metadata: { ...metadata, attributionError: "another confirmed operation transaction lacks exact token deltas" } });
        await dualOperationJournal.transition(operation.id, "recovery_pending", { recoveryError: `Exact token deltas are missing for ${owned.missingSignatures.join(", ")}` });
        return { success: false, recovery_pending: true, operation_id: operation.id, error: "A confirmed transaction is missing exact token deltas; manual reconciliation required" };
      }
      operation.acquiredRaw = { x: owned.x, y: owned.y };
      await dualOperationJournal.recordTransaction(operation.id, {
        ...transaction,
        status: "confirmed",
        metadata,
        operationPatch: {
          acquiredRaw: operation.acquiredRaw,
          transactionFeesSol: sumRecordedDualTransactionFees({ transactions: updatedTransactions }),
        },
      });
      continue;
    }

    const lastValidBlockHeight = Number(transaction.metadata?.lastValidBlockHeight);
    const currentBlockHeight = Number.isFinite(lastValidBlockHeight) ? await getConnection().getBlockHeight("confirmed") : null;
    if (Number.isFinite(lastValidBlockHeight) && currentBlockHeight > lastValidBlockHeight) {
      await dualOperationJournal.recordTransaction(operation.id, { ...transaction, status: "expired" });
      continue;
    }

    const signed = transaction.metadata?.signedTransaction;
    if (!signed || transaction.metadata?.responseSignature || transaction.kind.endsWith("_response") || !(await signedTransactionStillValid(signed))) continue;
    const result = await resumeJupiterSwap({
      signedTransaction: signed,
      requestId: transaction.metadata.requestId,
      onExecutionReported: async (response) => recordJupiterExecutionResponse(operation.id, transaction, response),
    }).catch(() => null);
    if (result?.success && result.tx !== transaction.signature) {
      return { success: false, recovery_pending: true, operation_id: operation.id, error: "Jupiter returned a different signature while resuming; both signatures are being reconciled before any recovery swap" };
    }
  }

  operation = await dualOperationJournal.get(operation.id);
  const pendingSwap = hasUnresolvedSwapTransactions(operation.transactions || []);
  if (pendingSwap) return { success: false, recovery_pending: true, operation_id: operation.id, error: "A swap signature is still unresolved; waiting before retrying or converting assets" };

  const ledger = calculateOperationOwnedAmounts(operation.transactions || []);
  if (!ledger.complete) return { success: false, recovery_pending: true, operation_id: operation.id, error: `Exact transaction token deltas are unavailable for ${ledger.missingSignatures.join(", ")}; manual reconciliation required` };
  operation.acquiredRaw = { x: ledger.x, y: ledger.y };

  operation = await dualOperationJournal.get(operation.id);
  if (operation.positionSignature) {
    const status = await readSignatureStatus(operation.positionSignature);
    if (status && !status.err && (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized")) {
      const feeSol = await getConfirmedTransactionFeeSol(operation.positionSignature);
      await dualOperationJournal.recordTransaction(operation.id, { kind: "add_liquidity", signature: operation.positionSignature, status: "confirmed", metadata: { feeSol } });
      operation.transactionFeesSol = sumRecordedDualTransactionFees(await dualOperationJournal.get(operation.id));
      await dualOperationJournal.transition(operation.id, "recovery_pending", { transactionFeesSol: operation.transactionFeesSol });
      return finalizeDualPosition(await dualOperationJournal.get(operation.id), pool, wallet);
    }
    if (!status && operation.positionTransaction && Number(operation.lastValidBlockHeight) >= await getConnection().getBlockHeight("confirmed")) {
      try {
        await getConnection().sendRawTransaction(Buffer.from(operation.positionTransaction, "base64"), { skipPreflight: false, maxRetries: 3 });
        const confirmed = await getConnection().confirmTransaction({ signature: operation.positionSignature, blockhash: Transaction.from(Buffer.from(operation.positionTransaction, "base64")).recentBlockhash, lastValidBlockHeight: operation.lastValidBlockHeight }, "confirmed");
        if (!confirmed.value.err) return finalizeDualPosition(operation, pool, wallet);
      } catch (error) {
        log("dual_recovery_warn", `Could not resume DLMM transaction ${operation.positionSignature}: ${error.message}`);
      }
    }
    if (!status && operation.positionAddress) {
      const positionAccount = await getConnection().getAccountInfo(new PublicKey(operation.positionAddress), "confirmed").catch(() => null);
      if (positionAccount) {
        try {
          const positionData = await pool.getPosition(new PublicKey(operation.positionAddress));
          const bins = positionData?.positionData?.positionBinData || [];
          if (bins.some((bin) => new BN(bin.positionLiquidity || "0").gt(new BN(0)))) {
            const feeSol = await getConfirmedTransactionFeeSol(operation.positionSignature);
            await dualOperationJournal.recordTransaction(operation.id, {
              kind: "add_liquidity", signature: operation.positionSignature, status: "confirmed",
              metadata: { recoveredFromPositionAccount: true, feeSol },
            });
            return finalizeDualPosition(await dualOperationJournal.get(operation.id), pool, wallet);
          }
          if (Number(operation.lastValidBlockHeight) < await getConnection().getBlockHeight("confirmed")) {
            const closeTx = await pool.closePosition({ owner: wallet.publicKey, position: { publicKey: new PublicKey(operation.positionAddress) } });
            const closeSignature = await sendAndConfirmTransaction(getConnection(), closeTx, [wallet]);
            await dualOperationJournal.recordTransaction(operation.id, { kind: "close_empty_position", signature: closeSignature, status: "confirmed" });
          }
        } catch (error) {
          return { success: false, recovery_pending: true, operation_id: operation.id, error: `Position account exists but its liquidity cannot yet be verified: ${error.message}` };
        }
      } else if (Number(operation.lastValidBlockHeight) < await getConnection().getBlockHeight("confirmed")) {
        await dualOperationJournal.recordTransaction(operation.id, { kind: "add_liquidity", signature: operation.positionSignature, status: "expired" });
      }
    }
    if (!status && Number(operation.lastValidBlockHeight) >= await getConnection().getBlockHeight("confirmed")) {
      return { success: false, recovery_pending: true, operation_id: operation.id, error: "DLMM transaction outcome is still being reconciled" };
    }
    if (status && !status.err && status.confirmationStatus !== "confirmed" && status.confirmationStatus !== "finalized") {
      return { success: false, recovery_pending: true, operation_id: operation.id, error: "DLMM transaction outcome is still being reconciled" };
    }
  }

  operation = await dualOperationJournal.get(operation.id);
  const acquiredRaw = { x: "0", y: "0", ...(operation.acquiredRaw || {}) };
  for (const side of ["x", "y"]) {
    const amountRaw = BigInt(acquiredRaw[side] || "0");
    const mint = side === "x" ? operation.plan.token_x_mint : operation.plan.token_y_mint;
    if (amountRaw <= 0n || mint === config.tokens.SOL) continue;
    try {
      const info = await getConnection().getParsedAccountInfo(new PublicKey(mint), "confirmed");
      const decimals = info.value?.data?.parsed?.info?.decimals;
      if (!Number.isInteger(decimals)) throw new Error("Token decimals are unavailable");
      const returned = await swapToken({
        input_mint: mint,
        output_mint: config.tokens.SOL,
        require_self_paid: true,
        amount_raw: amountRaw.toString(),
        input_decimals: decimals,
        onPrepared: async (prepared) => {
          validatePreparedDualSwapQuote({
            expectedInput: amountRaw.toString(),
            preparedInput: prepared.amount_in,
            minOutput: prepared.min_amount_out,
            priceImpactPct: prepared.price_impact_pct,
            maxPriceImpactPct: config.strategy.dualToken.maxPriceImpactPct,
          });
          operation.rollbackSignatures ??= {};
          operation.rollbackSignatures[side] = prepared.signature;
          await dualOperationJournal.recordTransaction(operation.id, {
            kind: `rollback_${side}`, signature: prepared.signature, status: "signed",
            metadata: { ...prepared, side, role: "rollback", amount_raw: amountRaw.toString() },
          });
        },
        onExecutionReported: async (response) => {
          const current = await dualOperationJournal.get(operation.id);
          const intent = current.transactions.find((entry) => entry.signature === operation.rollbackSignatures?.[side]);
          if (intent) await recordJupiterExecutionResponse(operation.id, intent, response);
        },
      });
      if (!returned?.success) throw new Error(returned?.error || "Rollback swap failed");
      if (returned.tx !== operation.rollbackSignatures?.[side]) throw new Error("Rollback returned a different signature than the journaled transaction");
      const confirmedTx = await getConfirmedTransaction(returned.tx);
      if (!confirmedTx?.meta || confirmedTx.meta.err) throw new Error("Jupiter reported rollback success but RPC cannot verify the transaction yet");
      if (!confirmedTransactionHasSigner(confirmedTx, wallet.publicKey.toString())) throw new Error("Confirmed rollback transaction is not signed by the configured wallet");
      const tokenDelta = BigInt(getConfirmedOwnerMintDelta({ transaction: confirmedTx, owner: wallet.publicKey.toString(), mint }));
      if (tokenDelta >= 0n || -tokenDelta > amountRaw) throw new Error("Confirmed rollback token spend is missing or exceeds the operation-owned amount");
      const inputSpentRaw = (-tokenDelta).toString();
      const rollbackMetadata = { ...returned, side, role: "rollback", inputSpentRaw, feeSol: confirmedTx.meta.fee / 1e9 };
      const current = await dualOperationJournal.get(operation.id);
      const updatedTransactions = current.transactions.map((entry) => entry.signature === returned.tx
        ? { ...entry, status: "confirmed", metadata: { ...entry.metadata, ...rollbackMetadata } }
        : entry);
      const owned = calculateOperationOwnedAmounts(updatedTransactions);
      if (!owned.complete) throw new Error("Cannot verify the remaining operation-owned token balance after rollback");
      acquiredRaw.x = owned.x;
      acquiredRaw.y = owned.y;
      await dualOperationJournal.recordTransaction(operation.id, {
        kind: `rollback_${side}`, signature: returned.tx, status: "confirmed", metadata: rollbackMetadata,
        operationPatch: { acquiredRaw: { ...acquiredRaw } },
      });
    } catch (error) {
      await dualOperationJournal.transition(operation.id, "recovery_pending", { acquiredRaw: { ...acquiredRaw }, recoveryError: error.message });
      return { success: false, recovery_pending: true, operation_id: operation.id, error: error.message };
    }
  }
  const finalState = await dualOperationJournal.get(operation.id);
  if ((finalState.transactions || []).some((transaction) => ["signed", "submitted", "superseded"].includes(transaction.status))) {
    return { success: false, recovery_pending: true, operation_id: operation.id, error: "A submitted transaction still needs chain confirmation" };
  }
  const finalLedger = calculateOperationOwnedAmounts(finalState.transactions || []);
  if (!finalLedger.complete || finalLedger.x !== "0" || finalLedger.y !== "0") {
    return { success: false, recovery_pending: true, operation_id: operation.id, error: "Recovery is incomplete; operation-owned tokens remain and will not be spent from the wallet balance" };
  }
  await dualOperationJournal.transition(operation.id, "cancelled", { acquiredRaw: { x: "0", y: "0" }, cancelledAt: new Date().toISOString() });
  return { success: false, recovery_pending: false, operation_id: operation.id, recovered: true, error: "Previous dual-token deploy was rolled back to SOL; start a fresh screening cycle" };
}

async function executeOrResumeDualExit({ positionAddress, poolAddress, wallet, assets, positionRentRecoveredSol = null }) {
  return dualOperationJournal.withPoolLock(poolAddress, wallet.publicKey.toString(), async () => {
    let operation = (await dualOperationJournal.list({ includeTerminal: true }))
      .find((entry) => entry.idempotencyKey === `dual-exit:${positionAddress}`);
    if (!operation) {
      operation = await dualOperationJournal.create({
        idempotencyKey: `dual-exit:${positionAddress}`,
        poolAddress,
        walletAddress: wallet.publicKey.toString(),
        kind: "exit",
        positionAddress,
        assetsRemaining: Object.fromEntries(assets.map((asset) => [asset.mint, { ...asset }])),
        solReceivedLamports: "0",
        positionRentRecoveredSol,
        transactionFeesSol: 0,
      });
    }
    if (operation.stage === "completed") return operation;
    if (operation.stage === "cancelled") throw new Error("Dual exit was already cancelled; manual reconciliation is required");

    const applyConfirmedExitSwap = async (transaction, result) => {
      const expected = transaction.metadata?.amountRaw;
      const minimum = transaction.metadata?.minAmountOut;
      const outcome = validateSwapOutcome({
        expectedInputLamports: expected,
        actualInputLamports: result.amount_in,
        minOutput: minimum,
        actualOutput: result.amount_out,
      });
      if (result.tx !== transaction.signature) throw new Error("Dual exit swap signature differs from journaled transaction");
      const feeSol = await getConfirmedTransactionFeeSol(transaction.signature);
      await dualOperationJournal.recordTransaction(operation.id, {
        ...transaction,
        status: "confirmed",
        metadata: { ...result, feeSol, minAmountOut: minimum },
      });
      const current = await dualOperationJournal.get(operation.id);
      const assetsRemaining = { ...current.assetsRemaining };
      const asset = assetsRemaining[transaction.metadata.mint];
      if (asset) asset.amount_raw = "0";
      await dualOperationJournal.transition(operation.id, "exit_swaps_pending", {
        assetsRemaining,
        solReceivedLamports: (BigInt(current.solReceivedLamports || "0") + BigInt(outcome.outputLamports)).toString(),
        transactionFeesSol: sumRecordedDualTransactionFees(await dualOperationJournal.get(operation.id)),
      });
    };

    for (const transaction of (operation.transactions || []).filter((entry) => entry.status === "signed" && entry.kind.startsWith("exit_swap:"))) {
      const status = await readSignatureStatus(transaction.signature);
      if (status?.err) {
        await dualOperationJournal.recordTransaction(operation.id, { ...transaction, status: "failed", metadata: { rpcError: status.err } });
        continue;
      }
      if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") {
        const signed = transaction.metadata?.signedTransaction;
        if (signed && transaction.metadata?.requestId) {
          const resumed = await resumeJupiterSwap({ signedTransaction: signed, requestId: transaction.metadata.requestId }).catch(() => null);
          if (resumed?.success) {
            if (resumed.tx !== transaction.signature) throw new Error("Confirmed Jupiter exit returned a different journaled signature");
            await applyConfirmedExitSwap(transaction, resumed);
            operation = await dualOperationJournal.get(operation.id);
            continue;
          }
        }
        const chainTx = await getConnection().getTransaction(transaction.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }).catch(() => null);
        const owner = wallet.publicKey.toString();
        const keys = (chainTx?.transaction?.message?.accountKeys || []).map((key) =>
          typeof key === "string" ? key : key.pubkey?.toString?.() || key.toString?.()
        );
        const ownerIndex = keys.indexOf(owner);
        const delta = ownerIndex >= 0 && chainTx?.meta?.postBalances?.[ownerIndex] != null && chainTx?.meta?.preBalances?.[ownerIndex] != null
          ? Number(chainTx.meta.postBalances[ownerIndex]) - Number(chainTx.meta.preBalances[ownerIndex]) + Number(chainTx.meta.fee || 0)
          : 0;
        if (delta <= 0) return { stage: "recovery_pending", operation_id: operation.id, error: "Confirmed exit swap has no verifiable SOL credit yet" };
        await applyConfirmedExitSwap(transaction, {
          success: true,
          tx: transaction.signature,
          amount_in: transaction.metadata.amountRaw,
          amount_out: String(delta),
          output_amount_source: "owner_balance_delta_including_recoverable_account_lamports",
        });
        operation = await dualOperationJournal.get(operation.id);
        continue;
      }
      const signed = transaction.metadata?.signedTransaction;
      if (!signed || !(await signedTransactionStillValid(signed))) {
        await dualOperationJournal.recordTransaction(operation.id, { ...transaction, status: "expired" });
        continue;
      }
      const resumed = await resumeJupiterSwap({ signedTransaction: signed, requestId: transaction.metadata.requestId }).catch(() => null);
      if (resumed?.success) {
        if (resumed.tx !== transaction.signature) throw new Error("Resumed exit swap has a different signature");
        await applyConfirmedExitSwap(transaction, resumed);
        operation = await dualOperationJournal.get(operation.id);
      }
    }

    operation = await dualOperationJournal.get(operation.id);
    if ((operation.transactions || []).some((transaction) => transaction.status === "signed" && transaction.kind.startsWith("exit_swap:"))) {
      return { stage: "recovery_pending", operation_id: operation.id, error: "A submitted exit swap is still awaiting chain confirmation" };
    }
    await dualOperationJournal.transition(operation.id, "exit_swaps_pending", {});
    for (const asset of Object.values(operation.assetsRemaining || {})) {
      if (BigInt(asset.amount_raw || "0") <= 0n) continue;
      let prepared = null;
      const result = await swapToken({
        input_mint: asset.mint,
        output_mint: config.tokens.SOL,
        require_self_paid: true,
        amount_raw: asset.amount_raw,
        input_decimals: asset.decimals,
        slippage_bps: config.strategy.dualToken.maxSlippageBps,
        onPrepared: async (quote) => {
          prepared = quote;
          validatePreparedDualSwapQuote({
            expectedInput: asset.amount_raw,
            preparedInput: quote.amount_in,
            minOutput: quote.min_amount_out,
            priceImpactPct: quote.price_impact_pct,
            maxPriceImpactPct: config.strategy.dualToken.maxPriceImpactPct,
          });
          await dualOperationJournal.recordTransaction(operation.id, {
            kind: `exit_swap:${asset.mint}`,
            signature: quote.signature,
            status: "signed",
            metadata: { ...quote, mint: asset.mint, amountRaw: asset.amount_raw, minAmountOut: quote.min_amount_out },
          });
        },
      });
      if (!result?.success) {
        operation = await dualOperationJournal.get(operation.id);
        return { stage: "recovery_pending", operation_id: operation.id, error: result?.error || "Exit swap is pending reconciliation" };
      }
      if (result.tx !== prepared?.signature) throw new Error("Dual exit execution returned a signature different from its journaled transaction");
      const transaction = await dualOperationJournal.get(operation.id).then((current) => current.transactions.find((entry) => entry.signature === prepared?.signature));
      if (!transaction) return { stage: "recovery_pending", operation_id: operation.id, error: "Exit swap succeeded but its signed intent is missing from the journal" };
      await applyConfirmedExitSwap(transaction, result);
      operation = await dualOperationJournal.get(operation.id);
    }
    operation = await dualOperationJournal.get(operation.id);
    const remaining = Object.values(operation.assetsRemaining || {}).filter((asset) => BigInt(asset.amount_raw || "0") > 0n);
    if (remaining.length) return { stage: "recovery_pending", operation_id: operation.id, error: "Some pool tokens still need conversion to SOL" };
    const completed = await dualOperationJournal.transition(operation.id, "completed", { completedAt: new Date().toISOString() });
    return completed;
  });
}

async function reconcilePendingDualExits(wallet = getWallet()) {
  const pending = (await dualOperationJournal.list()).filter((operation) => operation.kind === "exit");
  for (const operation of pending) {
    if (operation.walletAddress !== wallet.publicKey.toString()) continue;
    try {
      const result = await executeOrResumeDualExit({
        positionAddress: operation.positionAddress,
        poolAddress: operation.poolAddress,
        wallet,
        assets: [],
        positionRentRecoveredSol: operation.positionRentRecoveredSol ?? null,
      });
      if (result.stage !== "completed") {
        log("dual_exit_pending", `Exit ${operation.positionAddress.slice(0, 8)} remains pending: ${result.error || "one or more token swaps need retry"}`);
      }
    } catch (error) {
      log("dual_exit_warn", `Could not resume exit ${operation.positionAddress.slice(0, 8)}: ${error.message}`);
    }
  }
}

async function deployDualTokenPosition(args) {
  const poolAddress = normalizeMint(args.pool_address);
  const wallet = getWallet();
  await reconcilePendingDualExits(wallet);
  return dualOperationJournal.withPoolLock(poolAddress, wallet.publicKey.toString(), () => deployDualTokenPositionLocked(args));
}

async function deployDualTokenPositionLocked(args) {
  const poolAddress = normalizeMint(args.pool_address);
  if (isPoolOnCooldown(poolAddress)) return { success: false, error: "Pool is on cooldown" };
  const pool = await getPool(poolAddress);
  const mintX = pool.lbPair.tokenXMint.toString();
  const mintY = pool.lbPair.tokenYMint.toString();
  const policyReason = getDualPoolRestrictionReason(mintX, mintY, config.screening.tokenAllowlist, config.strategy.dualToken.baseMints);
  if (policyReason) throw new Error(`Pool blocked: ${policyReason}`);
  const splTokenProgram = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
  for (const mint of [mintX, mintY].filter((address) => address !== config.tokens.SOL)) {
    const mintAccount = await getConnection().getAccountInfo(new PublicKey(mint), "confirmed");
    if (!mintAccount || !mintAccount.owner.equals(splTokenProgram)) {
      throw new Error(`Dual-token deployment currently supports only standard SPL Token mints; refusing ${mint.slice(0, 8)}`);
    }
  }

  const wallet = getWallet();
  const pendingExit = (await dualOperationJournal.list()).find((operation) => operation.kind === "exit" && operation.poolAddress === poolAddress && operation.walletAddress === wallet.publicKey.toString());
  if (pendingExit) return { success: false, recovery_pending: true, operation_id: pendingExit.id, error: "A prior dual-token exit is still converting withdrawn assets to SOL" };
  const pending = (await dualOperationJournal.list()).find((operation) => operation.kind !== "exit" && operation.poolAddress === poolAddress && operation.walletAddress === wallet.publicKey.toString());
  if (pending) {
    return reconcileDualOperation(pending, pool, wallet);
  }

  const active = await pool.getActiveBin();
  const binStep = Number(pool.lbPair.binStep);
  const { calculateSpotDistribution, calculateNormalDistribution, StrategyType, getPriceOfBinByBinId } = await getDLMM();
  const ohlcv = await fetchDualTokenOhlcv(poolAddress);
  if (!ohlcv.ok) throw new Error(`Dual-token TA unavailable: ${ohlcv.reason}`);
  const ta = analyzeDualTokenRange({
    candles: ohlcv.candles,
    activeBin: active.binId,
    binStep,
    ...config.strategy.dualToken,
  });
  if (!ta.eligible) throw new Error(`Dual-token deployment skipped: ${ta.reason}`);
  if (ta.binsBelow + ta.binsAbove > 69 || ta.binsBelow < config.strategy.dualToken.minBinsPerSide || ta.binsAbove < config.strategy.dualToken.minBinsPerSide) {
    throw new Error("Dual-token TA range violates configured side-width or atomic range limits");
  }

  const minBinId = ta.minBinId;
  const maxBinId = ta.maxBinId;
  await assertRangeDoesNotRequireBinArrayInitialization(pool, minBinId, maxBinId);
  const rangeStrategy = ta.strategy === "spot" ? StrategyType.Spot : StrategyType.Curve;
  const binIds = Array.from({ length: maxBinId - minBinId + 1 }, (_, index) => minBinId + index);
  const distribution = ta.strategy === "spot"
    ? calculateSpotDistribution(active.binId, binIds)
    : calculateNormalDistribution(active.binId, binIds);
  const valueSplit = computeDualValueSplit({ distribution, activeBin: active.binId, binStep });
  const requestedBudget = Number(args.amount_sol ?? args.amount_y ?? computeDeployAmount((await getWalletBalances()).sol));
  if (!Number.isFinite(requestedBudget) || requestedBudget <= 0) throw new Error("Dual-token deploy needs a positive SOL budget");

  const creationQuote = await pool.quoteCreatePosition({ strategy: { minBinId, maxBinId } });
  if (Number(creationQuote.binArrayCost ?? 0) > 0 || Number(creationQuote.bitmapExtensionCost ?? 0) > 0) {
    throw new Error("Dual-token range requires non-refundable bin-array rent; refusing deployment");
  }
  const positionRentSol = Number(creationQuote.positionCost ?? 0) + Number(creationQuote.positionReallocCost ?? 0);
  const ataRentLamports = await getConnection().getMinimumBalanceForRentExemption(165, "confirmed");
  let temporaryAccountReserveLamports = 0;
  for (const mint of [mintX, mintY].filter((address) => address !== config.tokens.SOL)) {
    const account = getAssociatedTokenAddressSync(new PublicKey(mint), wallet.publicKey);
    if (!(await getConnection().getAccountInfo(account, "confirmed"))) temporaryAccountReserveLamports += ataRentLamports;
  }
  const temporaryAccountReserveSol = temporaryAccountReserveLamports / 1e9;
  const reserveSol = config.management.gasReserve + positionRentSol + temporaryAccountReserveSol + config.strategy.dualToken.maxTransactionFeesSol;
  const walletSol = (await getConnection().getBalance(wallet.publicKey, "confirmed")) / 1e9;
  const plan = buildDualDeployPlan({
    mintX, mintY, solMint: config.tokens.SOL,
    amountSol: requestedBudget,
    walletSol,
    reserveSol,
    valueSplit,
    routes: Object.fromEntries([mintX, mintY].filter((mint) => mint !== config.tokens.SOL).map((mint) => [mint, true])),
  });

  const quotes = {};
  for (const swap of plan.swaps) {
    const quote = await quoteSolSwap({ output_mint: swap.outputMint, amount_sol: swap.inputSol });
    validatePreparedDualSwapQuote({
      expectedInput: String(Math.floor(swap.inputSol * 1e9)),
      preparedInput: quote.in_amount,
      minOutput: quote.min_out_amount,
      priceImpactPct: quote.price_impact_pct,
      maxPriceImpactPct: config.strategy.dualToken.maxPriceImpactPct,
    });
    quotes[swap.side] = quote;
  }

  const minPrice = Number(getPriceOfBinByBinId(minBinId, binStep).toString());
  const maxPrice = Number(getPriceOfBinByBinId(maxBinId, binStep).toString());
  const activePrice = Number(getPriceOfBinByBinId(active.binId, binStep).toString());
  const deployPlan = {
    pool_address: poolAddress,
    pool_name: args.pool_name || poolAddress.slice(0, 8),
    dual_token: true,
    token_x_mint: mintX,
    token_y_mint: mintY,
    strategy: ta.strategy,
    bins_below: ta.binsBelow,
    bins_above: ta.binsAbove,
    min_bin_id: minBinId,
    max_bin_id: maxBinId,
    active_bin: active.binId,
    active_price: activePrice,
    price_range: { min: minPrice, max: maxPrice },
    amount_sol: requestedBudget,
    x_value_share: valueSplit.xValueShare,
    y_value_share: valueSplit.yValueShare,
    swaps: plan.swaps.map((swap) => ({ ...swap, quote: quotes[swap.side] })),
    reserve_sol: reserveSol,
    position_rent_estimate_sol: positionRentSol,
    ata_rent_budget_sol: temporaryAccountReserveSol,
    ata_rent_lamports: temporaryAccountReserveLamports,
    bin_step: binStep,
    volatility: args.volatility,
    fee_tvl_ratio: args.fee_tvl_ratio,
    organic_score: args.organic_score,
    initial_value_usd: args.initial_value_usd,
    entry_mcap: args.entry_mcap,
    entry_tvl: args.entry_tvl,
    entry_volume: args.entry_volume,
    entry_holders: args.entry_holders,
    ta,
  };
  if (process.env.DRY_RUN === "true") {
    return { dry_run: true, would_deploy: deployPlan, message: "DRY RUN — no transaction sent" };
  }

  const nowKey = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
  const operation = await dualOperationJournal.create({
    idempotencyKey: `dual:${wallet.publicKey}:${poolAddress}:${nowKey}`,
    poolAddress,
    walletAddress: wallet.publicKey.toString(),
    plan: deployPlan,
    quotes,
    positionRentSol,
    reserveSol,
  });
  const acquiredRaw = { x: "0", y: "0" };
  const swapResults = {};
  try {
    for (const swap of plan.swaps) {
      const quote = quotes[swap.side];
      const pendingStage = swap.side === "x" ? "swap_x_pending" : "swap_y_pending";
      await dualOperationJournal.transition(operation.id, pendingStage, {
        acquiredRaw: { ...acquiredRaw },
        currentSwapSide: swap.side,
      });
      let preparedSignature = null;
      let preparedMinimumOutput = null;
      const result = await swapToken({
        input_mint: config.tokens.SOL,
        output_mint: swap.outputMint,
        require_self_paid: true,
        amount: swap.inputSol,
        onPrepared: async (prepared) => {
          preparedSignature = prepared.signature;
          const validated = validatePreparedDualSwapQuote({
            expectedInput: quote.in_amount,
            preparedInput: prepared.amount_in,
            minOutput: prepared.min_amount_out,
            priceImpactPct: prepared.price_impact_pct,
            maxPriceImpactPct: config.strategy.dualToken.maxPriceImpactPct,
          });
          preparedMinimumOutput = validated.minOutput;
          await dualOperationJournal.recordTransaction(operation.id, {
            kind: `swap_${swap.side}`,
            signature: prepared.signature,
            status: "signed",
            metadata: { ...prepared, side: swap.side, role: "acquire", quote: { ...quote } },
          });
        },
        onExecutionReported: async (response) => {
          const current = await dualOperationJournal.get(operation.id);
          const intent = current.transactions.find((entry) => entry.signature === preparedSignature);
          if (intent) await recordJupiterExecutionResponse(operation.id, intent, response);
        },
      });
      if (!result?.success) throw new Error(result?.error || `Jupiter ${swap.side.toUpperCase()} swap failed`);
      if (result.tx !== preparedSignature) {
        throw new Error("Jupiter execution returned a signature that differs from the journaled signed transaction");
      }
      const confirmedTx = await getConfirmedTransaction(result.tx);
      if (!confirmedTx?.meta || confirmedTx.meta.err) throw new Error("Jupiter reported success but RPC cannot verify the confirmed swap transaction yet");
      if (!confirmedTransactionHasSigner(confirmedTx, wallet.publicKey.toString())) throw new Error("Confirmed Jupiter transaction is not signed by the configured wallet");
      const outputDeltaRaw = getConfirmedOwnerMintDelta({
        transaction: confirmedTx,
        owner: wallet.publicKey.toString(),
        mint: swap.outputMint,
      });
      if (BigInt(outputDeltaRaw) <= 0n) throw new Error("Confirmed Jupiter transaction did not produce an attributable output-token balance increase");
      acquiredRaw[swap.side] = addOperationTokenDelta(acquiredRaw[swap.side], outputDeltaRaw);
      const swapFeeSol = Number.isFinite(confirmedTx.meta.fee) ? confirmedTx.meta.fee / 1e9 : null;
      const confirmedMetadata = { ...result, side: swap.side, role: "acquire", outputDeltaRaw, feeSol: swapFeeSol };
      await dualOperationJournal.recordTransaction(operation.id, {
        kind: `swap_${swap.side}`,
        signature: result.tx,
        status: "confirmed",
        metadata: confirmedMetadata,
        operationPatch: {
          acquiredRaw: { ...acquiredRaw },
          transactionFeesSol: sumRecordedDualTransactionFees({
            transactions: (await dualOperationJournal.get(operation.id)).transactions.map((entry) => entry.signature === result.tx
              ? { ...entry, status: "confirmed", metadata: { ...entry.metadata, ...confirmedMetadata } }
              : entry),
          }),
        },
      });
      const outcome = validateSwapOutcome({
        expectedInputLamports: quote.in_amount,
        actualInputLamports: result.amount_in,
        minOutput: preparedMinimumOutput,
        actualOutput: outputDeltaRaw,
      });
      if (result.amount_out != null && BigInt(result.amount_out) !== BigInt(outputDeltaRaw)) {
        throw new Error("Jupiter output amount does not match the confirmed wallet token delta; recovery will use the on-chain delta");
      }
      operation.transactionFeesSol = sumRecordedDualTransactionFees(await dualOperationJournal.get(operation.id));
      const confirmedStage = swap.side === "x" ? "swap_x_confirmed" : "swap_y_confirmed";
      swapResults[swap.side] = result;
      await dualOperationJournal.transition(operation.id, confirmedStage, { acquiredRaw, swapResults: { ...swapResults }, transactionFeesSol: operation.transactionFeesSol });
    }

    const latestActive = await pool.getActiveBin();
    const latestActiveBinId = Number(latestActive.binId);
    const activeBinDrift = Math.abs(latestActiveBinId - active.binId);
    if (!Number.isInteger(latestActiveBinId) || activeBinDrift > 0 || latestActiveBinId < minBinId || latestActiveBinId > maxBinId) {
      throw new Error(`Active bin moved ${activeBinDrift} bins during swaps; position range is no longer safe`);
    }

    const tokenDecimals = async (mint) => mint === config.tokens.SOL ? 9 :
      (await getConnection().getParsedAccountInfo(new PublicKey(mint), "confirmed")).value?.data?.parsed?.info?.decimals;
    const decimalsX = await tokenDecimals(mintX);
    const decimalsY = await tokenDecimals(mintY);
    if (!Number.isInteger(decimalsX) || !Number.isInteger(decimalsY)) throw new Error("Could not verify token decimals after swaps");
    const xLamports = mintX === config.tokens.SOL
      ? new BN(Math.floor(plan.sides[0].budgetSol * 1e9)) : new BN(acquiredRaw.x);
    const yLamports = mintY === config.tokens.SOL
      ? new BN(Math.floor(plan.sides[1].budgetSol * 1e9)) : new BN(acquiredRaw.y);
    if (xLamports.isZero() || yLamports.isZero()) throw new Error("Swap results did not produce positive liquidity on both sides");

    const newPosition = Keypair.generate();
    const transaction = await pool.initializePositionAndAddLiquidityByStrategy({
      positionPubKey: newPosition.publicKey,
      user: wallet.publicKey,
      totalXAmount: xLamports,
      totalYAmount: yLamports,
      strategy: { minBinId, maxBinId, strategyType: rangeStrategy },
      slippage: config.strategy.dualToken.maxSlippageBps / 100,
    });
    const { blockhash, lastValidBlockHeight } = await getConnection().getLatestBlockhash("confirmed");
    transaction.feePayer = wallet.publicKey;
    transaction.recentBlockhash = blockhash;
    transaction.lastValidBlockHeight = lastValidBlockHeight;
    transaction.partialSign(wallet, newPosition);
    const rawTransaction = transaction.serialize();
    const signature = bs58.encode(transaction.signature);
    await dualOperationJournal.transition(operation.id, "position_pending", {
      positionAddress: newPosition.publicKey.toString(),
      positionSignature: signature,
      positionTransaction: rawTransaction.toString("base64"),
      lastValidBlockHeight,
      acquiredRaw,
      amountXRaw: xLamports.toString(),
      amountYRaw: yLamports.toString(),
      tokenDecimals: { x: decimalsX, y: decimalsY },
    });
    const sentSignature = await getConnection().sendRawTransaction(rawTransaction, { skipPreflight: false, maxRetries: 3 });
    if (sentSignature !== signature) throw new Error("RPC returned a signature that differs from the journaled DLMM signature");
    const confirmation = await getConnection().confirmTransaction({ signature, blockhash: transaction.recentBlockhash, lastValidBlockHeight }, "confirmed");
    if (confirmation.value.err) throw new Error(`DLMM dual-token transaction failed: ${JSON.stringify(confirmation.value.err)}`);
    const positionFeeSol = await getConfirmedTransactionFeeSol(signature);
    await dualOperationJournal.recordTransaction(operation.id, { kind: "add_liquidity", signature, status: "confirmed", metadata: { feeSol: positionFeeSol } });
    operation.transactionFeesSol = sumRecordedDualTransactionFees(await dualOperationJournal.get(operation.id));
    const positionRentPaidSol = await readPositionRentSol(newPosition.publicKey.toString());

    trackPosition({
      position: newPosition.publicKey.toString(), pool: poolAddress, pool_name: args.pool_name,
      strategy: ta.strategy, bin_range: { min: minBinId, max: maxBinId, bins_below: ta.binsBelow, bins_above: ta.binsAbove },
      amount_sol: requestedBudget, amount_x: Number(xLamports.toString()) / 10 ** decimalsX,
      active_bin: active.binId, bin_step: binStep, volatility: args.volatility,
      fee_tvl_ratio: args.fee_tvl_ratio, organic_score: args.organic_score, initial_value_usd: args.initial_value_usd,
      entry_mcap: args.entry_mcap, entry_tvl: args.entry_tvl, entry_volume: args.entry_volume, entry_holders: args.entry_holders,
      token_x_mint: mintX, token_y_mint: mintY, dual_token: true,
      dual_deploy: {
        amount_sol: requestedBudget, x_raw: xLamports.toString(), y_raw: yLamports.toString(),
        x_decimals: decimalsX, y_decimals: decimalsY, swaps: { ...swapResults },
        position_rent_estimate_sol: positionRentSol, ata_rent_budget_sol: temporaryAccountReserveSol, ta: ta.metrics,
        position_rent_paid_sol: positionRentPaidSol,
        transaction_fees_sol: operation.transactionFeesSol,
        fee_accounting_complete: operation.transactionFeesSol != null,
      },
    });
    await dualOperationJournal.transition(operation.id, "completed", { positionAddress: newPosition.publicKey.toString(), positionSignature: signature, transactionFeesSol: operation.transactionFeesSol, completedAt: new Date().toISOString() });
    _positionsCacheAt = 0;
    return {
      success: true, dual_token: true, position: newPosition.publicKey.toString(), pool: poolAddress,
      pool_name: args.pool_name, strategy: ta.strategy, bin_range: { min: minBinId, max: maxBinId, active: active.binId },
      price_range: { min: minPrice, max: maxPrice }, amount_sol: requestedBudget,
      token_x_mint: mintX, token_y_mint: mintY, amount_x: Number(xLamports.toString()) / 10 ** decimalsX,
      amount_y: Number(yLamports.toString()) / 10 ** decimalsY,
      txs: [...Object.values(swapResults).map((result) => result.tx).filter(Boolean), signature],
      rent_estimate_sol: positionRentSol, reserve_sol: reserveSol, ta: ta.metrics,
      transaction_fees_sol: operation.transactionFeesSol,
    };
  } catch (error) {
    const latest = await dualOperationJournal.get(operation.id);
    let recoveryResult = null;
    if (latest && !["completed", "cancelled"].includes(latest.stage)) {
      await dualOperationJournal.transition(operation.id, "recovery_pending", {
        recoveryError: error.message,
        acquiredRaw: { ...acquiredRaw },
      }).catch(() => {});
      recoveryResult = await reconcileDualOperation(latest, pool, wallet).catch((recoveryError) => {
        log("dual_recovery_error", `Operation ${operation.id} reconciliation failed: ${recoveryError.message}`);
        return null;
      });
      if (recoveryResult?.success) {
        log("dual_deploy_reconciled", `Operation ${operation.id} completed on-chain after the original submission reported an error`);
        return recoveryResult;
      }
      if (recoveryResult?.recovery_pending) {
        log("dual_recovery_pending", `Operation ${operation.id} awaits reconciliation: ${recoveryResult.error || error.message}`);
      } else if (recoveryResult?.recovered) {
        log("dual_recovery", `Operation ${operation.id} returned operation-owned assets to SOL; fresh screening is required`);
      }
    }
    log("dual_deploy_error", `Operation ${operation.id} requires reconciliation: ${error.message}`);
    return {
      success: false,
      recovery_pending: recoveryResult?.recovery_pending ?? true,
      recovered: recoveryResult?.recovered ?? false,
      operation_id: operation.id,
      error: recoveryResult?.recovered
        ? "Deployment was cancelled safely; no operation-owned pool tokens remain outside SOL. A fresh screening cycle is required."
        : recoveryResult?.error || error.message,
    };
  }
}

function assertNoInitializeBinArrayInstructions(serializedTxs) {
  const offenders = [];
  for (const serialized of serializedTxs || []) {
    if (typeof serialized !== "string" || serialized.length === 0) continue;
    for (const discriminator of getDlmmInstructionDiscriminators(serialized)) {
      if (discriminator === METEORA_INIT_BIN_ARRAY_DISCRIMINATOR) {
        offenders.push("initializeBinArray");
      } else if (discriminator === METEORA_INIT_BITMAP_EXTENSION_DISCRIMINATOR) {
        offenders.push("initializeBinArrayBitmapExtension");
      }
    }
  }
  if (offenders.length > 0) {
    throw new Error(
      `Deploy skipped: generated transaction includes Meteora ${[...new Set(offenders)].join(" / ")} ` +
      "instruction(s), which would charge non-refundable pool initialization rent.",
    );
  }
}

function getDlmmInstructionDiscriminators(serialized) {
  const bytes = Buffer.from(serialized, "base64");
  const dlmmProgramId = getDlmmProgramId().toString();
  try {
    const versioned = VersionedTransaction.deserialize(bytes);
    return versioned.message.compiledInstructions
      .map((ix) => {
        const programId = versioned.message.staticAccountKeys[ix.programIdIndex]?.toString();
        if (programId !== dlmmProgramId) return null;
        return Buffer.from(ix.data || []).subarray(0, 8).toString("hex");
      })
      .filter(Boolean);
  } catch {
    const legacy = Transaction.from(bytes);
    return legacy.instructions
      .map((ix) => ix.programId.toString() === dlmmProgramId ? Buffer.from(ix.data || []).subarray(0, 8).toString("hex") : null)
      .filter(Boolean);
  }
}

// ─── Pool Cache ────────────────────────────────────────────────
const poolCache = new Map();
const poolMetadataCache = new Map();

async function getPool(poolAddress) {
  const key = poolAddress.toString();
  if (!poolCache.has(key)) {
    const { DLMM } = await getDLMM();
    const pool = await DLMM.create(getConnection(), new PublicKey(poolAddress));
    poolCache.set(key, pool);
  }
  return poolCache.get(key);
}

setInterval(() => poolCache.clear(), 5 * 60 * 1000);
setInterval(() => poolMetadataCache.clear(), 15 * 60 * 1000);

async function getPoolMetadata(poolAddress) {
  const key = String(poolAddress);
  if (poolMetadataCache.has(key)) {
    return poolMetadataCache.get(key);
  }

  try {
    const res = await fetch(`https://dlmm.datapi.meteora.ag/pools/${key}`);
    if (!res.ok) {
      throw new Error(`Pool metadata API ${res.status}`);
    }

    const data = await res.json();
    const tokenX = data?.token_x?.symbol || null;
    const tokenY = data?.token_y?.symbol || null;
    const pair = data?.name || (tokenX && tokenY ? `${tokenX}-${tokenY}` : null);
    const meta = {
      address: data?.address || key,
      name: pair,
      token_x_symbol: tokenX,
      token_y_symbol: tokenY,
    };
    poolMetadataCache.set(key, meta);
    return meta;
  } catch (error) {
    log("pool_meta_warn", `Pool metadata lookup failed for ${key.slice(0, 8)}: ${error.message}`);
    const fallback = { address: key, name: null, token_x_symbol: null, token_y_symbol: null };
    poolMetadataCache.set(key, fallback);
    return fallback;
  }
}

// ─── Get Active Bin ────────────────────────────────────────────
export async function getActiveBin({ pool_address }) {
  pool_address = normalizeMint(pool_address);
  const pool = await getPool(pool_address);
  const activeBin = await pool.getActiveBin();

  return {
    binId: activeBin.binId,
    price: pool.fromPricePerLamport(Number(activeBin.price)),
    pricePerLamport: activeBin.price.toString(),
  };
}

// ─── Deploy Position ───────────────────────────────────────────
export async function deployPosition({
  pool_address,
  amount_sol, // legacy: will be used as amount_y if amount_y is not provided
  amount_x,
  amount_y,
  strategy,
  bins_below,
  bins_above,
  downside_pct,
  upside_pct,
  // optional pool metadata for learning (passed by agent when available)
  pool_name,
  bin_step,
  base_fee,
  volatility,
  fee_tvl_ratio,
  organic_score,
  initial_value_usd,
  // entry market conditions (injected by executor safety checks)
  entry_mcap,
  entry_tvl,
  entry_volume,
  entry_holders,
}) {
  if (config.strategy.dualToken.enabled) {
    return deployDualTokenPosition({
      pool_address, amount_sol, amount_x, amount_y, pool_name, volatility, fee_tvl_ratio,
      organic_score, initial_value_usd, entry_mcap, entry_tvl, entry_volume, entry_holders,
    });
  }
  pool_address = normalizeMint(pool_address);
  const activeStrategy = strategy || config.strategy.strategy;
  let activeBinsBelow = bins_below ?? config.strategy.defaultBinsBelow ?? config.strategy.minBinsBelow;
  let activeBinsAbove = bins_above ?? 0;
  const parsedVolatility = volatility == null ? null : Number(volatility);
  const normalizedVolatility = parsedVolatility != null && Number.isFinite(parsedVolatility) ? parsedVolatility : null;

  if (volatility != null && (normalizedVolatility == null || normalizedVolatility <= 0)) {
    throw new Error(`Invalid volatility ${volatility} — refusing deploy because the volatility feed is unusable.`);
  }

  if (isPoolOnCooldown(pool_address)) {
    log("deploy", `Pool ${pool_address.slice(0, 8)} is on cooldown — skipping`);
    return { success: false, error: "Pool on cooldown — was recently closed with a cooldown reason. Try a different pool." };
  }

  const { StrategyType, getBinIdFromPrice, getPriceOfBinByBinId } = await getDLMM();
  const pool = await getPool(pool_address);
  const baseMint = pool.lbPair.tokenXMint.toString();
  const quoteMint = pool.lbPair.tokenYMint.toString();
  const poolRestriction = getPoolRestrictionReason(baseMint, quoteMint, config.screening.tokenAllowlist);
  if (poolRestriction) throw new Error(`Pool blocked: ${poolRestriction}.`);
  if (isBaseMintOnCooldown(baseMint)) {
    log("deploy", `Base mint ${baseMint.slice(0, 8)} is on cooldown — skipping deploy for pool ${pool_address.slice(0, 8)}`);
    return { success: false, error: "Token on cooldown — recently closed out-of-range too many times. Try a different token." };
  }
  const activeBin = await pool.getActiveBin();
  const actualBinStep = pool.lbPair.binStep;
  const activePrice = Number(getPriceOfBinByBinId(activeBin.binId, actualBinStep).toString());

  if (downside_pct != null || upside_pct != null) {
    const downsidePct = Math.max(0, Number(downside_pct ?? 0));
    const upsidePct = Math.max(0, Number(upside_pct ?? 0));

    if (!Number.isFinite(downsidePct) || !Number.isFinite(upsidePct)) {
      throw new Error("downside_pct and upside_pct must be valid numbers.");
    }
    if (downsidePct >= 100) {
      throw new Error("downside_pct must be less than 100.");
    }

    const lowerTargetPrice = activePrice * (1 - downsidePct / 100);
    const upperTargetPrice = activePrice * (1 + upsidePct / 100);
    const lowerBinId = getBinIdFromPrice(lowerTargetPrice, actualBinStep, true);
    const upperBinId = getBinIdFromPrice(upperTargetPrice, actualBinStep, false);

    activeBinsBelow = Math.max(0, activeBin.binId - lowerBinId);
    activeBinsAbove = Math.max(0, upperBinId - activeBin.binId);
  }

  const strategyMap = {
    spot: StrategyType.Spot,
    curve: StrategyType.Curve,
    bid_ask: StrategyType.BidAsk,
  };

  const strategyType = strategyMap[activeStrategy];
  if (strategyType === undefined) {
    throw new Error(`Invalid strategy: ${activeStrategy}. Use spot, curve, or bid_ask.`);
  }

  // Calculate amounts
  // If no explicit SOL amount is provided, fall back to the configured dynamic deploy size.
  const fallbackAmountY =
    amount_y == null && amount_sol == null
      ? computeDeployAmount((await getWalletBalances()).sol)
      : 0;
  const finalAmountY = Number(amount_y ?? amount_sol ?? fallbackAmountY);
  const finalAmountX = Number(amount_x ?? 0);
  if (!Number.isFinite(finalAmountY) || !Number.isFinite(finalAmountX) || finalAmountY < 0 || finalAmountX < 0) {
    throw new Error("Invalid deploy amount: amount_x and amount_y must be valid non-negative numbers.");
  }
  if (finalAmountX > 0) {
    throw new Error("Unsupported deploy amount: this agent only supports single-side SOL deploys. Use amount_y/amount_sol and keep amount_x=0.");
  }
  if (finalAmountY <= 0) {
    throw new Error("Invalid deploy amount: provide a positive amount_y/amount_sol.");
  }
  const isSingleSidedSol = finalAmountX <= 0 && finalAmountY > 0;
  if (isSingleSidedSol && (Number(bins_above ?? 0) > 0 || Number(upside_pct ?? 0) > 0)) {
    throw new Error(
      "Single-side SOL deploy cannot use bins_above or upside_pct. Use amount_y with bins_below only; the upper bin is the SDK active bin.",
    );
  }
  if (isSingleSidedSol) {
    activeBinsAbove = 0;
  }
  activeBinsBelow = Number(activeBinsBelow);
  activeBinsAbove = Number(activeBinsAbove);
  if (!Number.isFinite(activeBinsBelow) || !Number.isFinite(activeBinsAbove)) {
    throw new Error("Invalid bin range: bins_below and bins_above must be valid numbers.");
  }
  if (activeBinsBelow < 0 || activeBinsAbove < 0) {
    throw new Error("Invalid bin range: bins_below and bins_above cannot be negative.");
  }
  if (!Number.isInteger(activeBinsBelow) || !Number.isInteger(activeBinsAbove)) {
    throw new Error("Invalid bin range: bins_below and bins_above must be whole-bin integers.");
  }
  const minBinsBelow = Math.max(MIN_SAFE_BINS_BELOW, Number(config.strategy.minBinsBelow ?? MIN_SAFE_BINS_BELOW));
  const totalBins = activeBinsBelow + activeBinsAbove;
  if (totalBins < minBinsBelow) {
    throw new Error(
      `Invalid deploy range: total bins ${totalBins} is below minimum ${minBinsBelow}. Refusing 1-bin/tiny-range deploy.`,
    );
  }

  if (process.env.DRY_RUN === "true") {
    return {
      dry_run: true,
      would_deploy: {
        pool_address,
        strategy: activeStrategy,
        bins_below: activeBinsBelow,
        bins_above: activeBinsAbove,
        downside_pct: downside_pct ?? null,
        upside_pct: upside_pct ?? null,
        amount_x: finalAmountX,
        amount_y: finalAmountY,
        wide_range: totalBins > 69,
      },
      message: "DRY RUN — no transaction sent",
    };
  }

  const isWideRange = totalBins > 69;
  const minBinId = activeBin.binId - activeBinsBelow;
  const maxBinId = isSingleSidedSol ? activeBin.binId : activeBin.binId + activeBinsAbove;

  if (minBinId > maxBinId) {
    throw new Error(`Invalid bin range: ${minBinId} -> ${maxBinId}`);
  }
  if (isSingleSidedSol && maxBinId !== activeBin.binId) {
    throw new Error(
      `Single-side SOL deploy must end at the SDK active bin. Expected ${activeBin.binId}, got ${maxBinId}.`,
    );
  }

  await assertRangeDoesNotRequireBinArrayInitialization(pool, minBinId, maxBinId);

  const minPrice = Number(getPriceOfBinByBinId(minBinId, actualBinStep).toString());
  const maxPrice = Number(getPriceOfBinByBinId(maxBinId, actualBinStep).toString());
  const downsideCoveragePct = activePrice > 0 ? ((activePrice - minPrice) / activePrice) * 100 : null;
  const upsideCoveragePct = activePrice > 0 ? ((maxPrice - activePrice) / activePrice) * 100 : null;
  const totalWidthPct = minPrice > 0 ? ((maxPrice - minPrice) / minPrice) * 100 : null;

  // Read base fee directly from pool — baseFactor * binStep / 10^6 gives fee in %
  const baseFactor = pool.lbPair.parameters?.baseFactor ?? 0;
  const actualBaseFee = base_fee ?? (baseFactor > 0 ? parseFloat((baseFactor * actualBinStep / 1e6 * 100).toFixed(4)) : null);

  const totalYLamports = new BN(Math.floor(finalAmountY * 1e9));
  // Token X amount uses mint decimals when available, falling back to 9.
  let totalXLamports = new BN(0);
  if (finalAmountX > 0) {
    const mintInfo = await getConnection().getParsedAccountInfo(new PublicKey(pool.lbPair.tokenXMint));
    const decimals = mintInfo.value?.data?.parsed?.info?.decimals ?? 9;
    totalXLamports = new BN(Math.floor(finalAmountX * Math.pow(10, decimals)));
  }

  if (shouldUseLpAgentRelayForDeploy()) {
    try {
      const wallet = getWallet();
      log(
        "deploy",
        `Relay deploy via Agent Meridian: ${pool_address} activeBin ${activeBin.binId} bins ${minBinId}->${maxBinId} amountY=${finalAmountY}`,
      );
      const order = await agentMeridianJson("/execution/zap-in/order", {
        method: "POST",
        headers: getAgentMeridianHeaders({ json: true }),
        body: JSON.stringify({
          agentId: getAgentIdForRequests(),
          idempotencyKey: `deploy:${pool_address}:${minBinId}:${maxBinId}:${finalAmountY}:${finalAmountX}`,
          poolId: pool_address,
          owner: wallet.publicKey.toString(),
          strategy: activeStrategy === "spot" ? "Spot" : "BidAsk",
          inputSOL: finalAmountY,
          amountY: finalAmountY,
          amountX: finalAmountX,
          percentX: finalAmountX > 0 && finalAmountY > 0 ? 0.5 : 0,
          fromBinId: minBinId,
          toBinId: maxBinId,
          slippageBps: 500,
          provider: "JUPITER_ULTRA",
        }),
      });

      const addLiquidityUnsigned = order?.order?.transactions?.addLiquidity || [];
      const swapUnsigned = order?.order?.transactions?.swap || [];
      if (addLiquidityUnsigned.length + swapUnsigned.length === 0) {
        throw new Error("LPAgent order returned no transactions. Check the pool address, deploy amount, and selected range.");
      }
      assertNoInitializeBinArrayInstructions(addLiquidityUnsigned);

      const addLiquidity = signSerializedTransactions(addLiquidityUnsigned, wallet);
      const swap = signSerializedTransactions(swapUnsigned, wallet);
      const submit = await agentMeridianJson("/execution/zap-in/submit", {
        method: "POST",
        headers: getAgentMeridianHeaders({ json: true }),
        body: JSON.stringify({
          requestId: order.requestId,
          lastValidBlockHeight: order?.order?.lastValidBlockHeight,
          transactions: {
            addLiquidity,
            swap,
          },
          meta: {
            pool: pool_address,
            strategy: activeStrategy,
          },
        }),
      });

      await new Promise((resolve) => setTimeout(resolve, 5000));
      _positionsCacheAt = 0;
      const refreshed = await getMyPositions({ force: true, silent: true }).catch(() => null);
      const matching = refreshed?.positions?.find(
        (position) => position.pool === pool_address && position.lower_bin === minBinId && position.upper_bin === maxBinId,
      ) || refreshed?.positions?.find((position) => position.pool === pool_address);

      const positionAddress = matching?.position || null;
      if (positionAddress) {
        const signalSnapshot = config.darwin?.enabled
          ? getAndClearStagedSignals(pool_address, baseMint)
          : null;
        trackPosition({
          position: positionAddress,
          pool: pool_address,
          pool_name,
          strategy: activeStrategy,
          bin_range: { min: minBinId, max: maxBinId, bins_below: activeBinsBelow, bins_above: activeBinsAbove },
          bin_step,
          volatility: normalizedVolatility,
          fee_tvl_ratio,
          organic_score,
          amount_sol: finalAmountY,
          amount_x: finalAmountX,
          active_bin: activeBin.binId,
          initial_value_usd,
          signal_snapshot: signalSnapshot,
          entry_mcap,
          entry_tvl,
          entry_volume,
          entry_holders,
        });
      }

      appendDecision({
        type: "deploy",
        actor: "SCREENER",
        pool: pool_address,
        pool_name,
        position: positionAddress,
        summary: `Relay deployed ${finalAmountY} SOL with ${activeStrategy}`,
        reason: `Chosen range ${minBinId}→${maxBinId} around active bin ${activeBin.binId}`,
        risks: [
          normalizedVolatility != null ? `volatility ${normalizedVolatility}` : null,
          fee_tvl_ratio != null ? `fee/TVL ${fee_tvl_ratio}%` : null,
        ].filter(Boolean),
        metrics: {
          amount_sol: finalAmountY,
          strategy: activeStrategy,
          active_bin: activeBin.binId,
          min_bin: minBinId,
          max_bin: maxBinId,
          downside_pct: downside_pct ?? downsideCoveragePct,
          upside_pct: upside_pct ?? upsideCoveragePct,
        },
      });

      return {
        success: true,
        relay: true,
        request_id: order.requestId,
        position: positionAddress,
        pool: pool_address,
        pool_name,
        bin_range: { min: minBinId, max: maxBinId, active: activeBin.binId },
        price_range: { min: minPrice, max: maxPrice },
        range_coverage: {
          downside_pct: downsideCoveragePct,
          upside_pct: upsideCoveragePct,
          width_pct: totalWidthPct,
          active_price: activePrice,
        },
        bin_step: actualBinStep,
        base_fee: actualBaseFee,
        strategy: activeStrategy,
        wide_range: isWideRange,
        amount_x: finalAmountX,
        amount_y: finalAmountY,
        txs: normalizeExecutionSignatures(submit),
      };
    } catch (error) {
      log("deploy_error", `Relay deploy failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  const wallet = getWallet();
  const newPosition = Keypair.generate();

  log("deploy", `Pool: ${pool_address}`);
  log("deploy", `Strategy: ${activeStrategy}, Bins: ${minBinId} to ${maxBinId} (${totalBins} bins${isWideRange ? " — WIDE RANGE" : ""})`);
  log("deploy", `Amount: ${finalAmountX} X, ${finalAmountY} Y`);
  log("deploy", `Position: ${newPosition.publicKey.toString()}`);

  try {
    const txHashes = [];

    if (isWideRange) {
      // ── Wide Range Path (>69 bins) ─────────────────────────────────
      // Solana limits inner instruction realloc to 10240 bytes, so we can't create
      // a large position in a single initializePosition ix.
      // Solution: createExtendedEmptyPosition (returns Transaction | Transaction[]),
      //           then addLiquidityByStrategyChunkable (returns Transaction[]).

      // Phase 1: Create empty position (may be multiple txs)
      const createTxs = await pool.createExtendedEmptyPosition(
        minBinId,
        maxBinId,
        newPosition.publicKey,
        wallet.publicKey,
      );
      const createTxArray = Array.isArray(createTxs) ? createTxs : [createTxs];
      for (let i = 0; i < createTxArray.length; i++) {
        const signers = i === 0 ? [wallet, newPosition] : [wallet];
        const txHash = await sendAndConfirmTransaction(getConnection(), createTxArray[i], signers);
        txHashes.push(txHash);
        log("deploy", `Create tx ${i + 1}/${createTxArray.length}: ${txHash}`);
      }

      // Phase 2: Add liquidity (may be multiple txs)
      const addTxs = await pool.addLiquidityByStrategyChunkable({
        positionPubKey: newPosition.publicKey,
        user: wallet.publicKey,
        totalXAmount: totalXLamports,
        totalYAmount: totalYLamports,
        strategy: { minBinId, maxBinId, strategyType },
        slippage: 10, // 10%
      });
      const addTxArray = Array.isArray(addTxs) ? addTxs : [addTxs];
      for (let i = 0; i < addTxArray.length; i++) {
        const txHash = await sendAndConfirmTransaction(getConnection(), addTxArray[i], [wallet]);
        txHashes.push(txHash);
        log("deploy", `Add liquidity tx ${i + 1}/${addTxArray.length}: ${txHash}`);
      }
    } else {
      // ── Standard Path (≤69 bins) ─────────────────────────────────
      const tx = await pool.initializePositionAndAddLiquidityByStrategy({
        positionPubKey: newPosition.publicKey,
        user: wallet.publicKey,
        totalXAmount: totalXLamports,
        totalYAmount: totalYLamports,
        strategy: { maxBinId, minBinId, strategyType },
        slippage: 1000, // 10% in bps
      });
      const txHash = await sendAndConfirmTransaction(getConnection(), tx, [wallet, newPosition]);
      txHashes.push(txHash);
    }

    log("deploy", `SUCCESS — ${txHashes.length} tx(s): ${txHashes[0]}`);

    _positionsCacheAt = 0;
    const signalSnapshot = config.darwin?.enabled
      ? getAndClearStagedSignals(pool_address, baseMint)
      : null;
    trackPosition({
      position: newPosition.publicKey.toString(),
      pool: pool_address,
      pool_name,
      strategy: activeStrategy,
      bin_range: { min: minBinId, max: maxBinId, bins_below: activeBinsBelow, bins_above: activeBinsAbove },
      bin_step,
      volatility: normalizedVolatility,
      fee_tvl_ratio,
      organic_score,
      amount_sol: finalAmountY,
      amount_x: finalAmountX,
      active_bin: activeBin.binId,
      initial_value_usd,
      signal_snapshot: signalSnapshot,
      entry_mcap,
      entry_tvl,
      entry_volume,
      entry_holders,
    });

    appendDecision({
      type: "deploy",
      actor: "SCREENER",
      pool: pool_address,
      pool_name,
      position: newPosition.publicKey.toString(),
      summary: `Deployed ${finalAmountY} SOL with ${activeStrategy}`,
      reason: `Chosen range ${minBinId}→${maxBinId} around active bin ${activeBin.binId}`,
      risks: [
        normalizedVolatility != null ? `volatility ${normalizedVolatility}` : null,
        fee_tvl_ratio != null ? `fee/TVL ${fee_tvl_ratio}%` : null,
      ].filter(Boolean),
      metrics: {
        amount_sol: finalAmountY,
        strategy: activeStrategy,
        active_bin: activeBin.binId,
        min_bin: minBinId,
        max_bin: maxBinId,
        downside_pct: downside_pct ?? null,
        upside_pct: upside_pct ?? null,
      },
    });

    return {
      success: true,
      position: newPosition.publicKey.toString(),
      pool: pool_address,
      pool_name,
      bin_range: { min: minBinId, max: maxBinId, active: activeBin.binId },
      price_range: { min: minPrice, max: maxPrice },
      range_coverage: {
        downside_pct: downsideCoveragePct,
        upside_pct: upsideCoveragePct,
        width_pct: totalWidthPct,
        active_price: activePrice,
      },
      bin_step: actualBinStep,
      base_fee: actualBaseFee,
      strategy: activeStrategy,
      wide_range: isWideRange,
      amount_x: finalAmountX,
      amount_y: finalAmountY,
      txs: txHashes,
    };
  } catch (error) {
    log("deploy_error", error.message);
    return { success: false, error: error.message };
  }
}

const POSITIONS_CACHE_TTL = 5 * 60_000; // 5 minutes

let _positionsCache = null;
let _positionsCacheAt = 0;
let _positionsInflight = null; // deduplicates concurrent calls
const LPAGENT_API = "https://api.lpagent.io/open-api/v1";

async function fetchLpAgentOpenPositions(walletAddress) {
  if (!process.env.LPAGENT_API_KEY) return {};

  const url = `${LPAGENT_API}/lp-positions/opening?owner=${walletAddress}`;
  try {
    const res = await fetch(url, {
      headers: {
        "x-api-key": process.env.LPAGENT_API_KEY,
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      log("lpagent_api", `HTTP ${res.status} for owner ${walletAddress.slice(0, 8)}: ${body.slice(0, 160)}`);
      return {};
    }
    const data = await res.json();
    const positions = data?.data || [];
    const byAddress = {};
    for (const p of positions) {
      const addr = p.position || p.id || p.tokenId;
      if (addr) byAddress[addr] = p;
    }
    return byAddress;
  } catch (e) {
    log("lpagent_api", `Fetch error for owner ${walletAddress.slice(0, 8)}: ${e.message}`);
    return {};
  }
}

// ─── Get Position PnL (Meteora API) ─────────────────────────────
export async function getPositionPnl({ pool_address, position_address }) {
  pool_address = normalizeMint(pool_address);
  position_address = normalizeMint(position_address);
  const walletAddress = getWallet().publicKey.toString();
  // Prefer the public-infra path (RPC + Jupiter + Meteora deposits) used by getMyPositions.
  if (config.pnl.source === "rpc") {
    try {
      const payload = await getMyPositions({ force: true, silent: true });
      const p = payload?.positions?.find((position) => position.position === position_address);
      if (p) {
        return {
          pnl_usd: p.pnl_usd,
          pnl_pct: p.pnl_pct,
          capital_pnl_sol: p.capital_pnl_sol,
          capital_pnl_usd: p.capital_pnl_usd,
          fee_income_sol: p.fee_income_sol,
          fee_income_usd: p.fee_income_usd,
          pnl_includes_capital_gain: p.pnl_includes_capital_gain,
          current_value_usd: p.total_value_usd,
          unclaimed_fee_usd: p.unclaimed_fees_usd,
          all_time_fees_usd: p.collected_fees_usd,
          fee_per_tvl_24h: p.fee_per_tvl_24h,
          in_range: p.in_range,
          lower_bin: p.lower_bin,
          upper_bin: p.upper_bin,
          active_bin: p.active_bin,
          age_minutes: p.age_minutes,
        };
      }
    } catch (error) {
      log("pnl_warn", `RPC PnL lookup failed; falling back to direct Meteora PnL path: ${error.message}`);
    }
  }
  try {
    const byAddress = await fetchDlmmPnlForPool(pool_address, walletAddress);
    const p = byAddress[position_address];
    if (!p) return { error: "Position not found in PnL API" };

    const solMode = config.management.solMode;
    const unclaimedValue = solMode
      ? safeNum(p.unrealizedPnl?.unclaimedFeeTokenX?.amountSol) + safeNum(p.unrealizedPnl?.unclaimedFeeTokenY?.amountSol)
      : safeNum(p.unrealizedPnl?.unclaimedFeeTokenX?.usd) + safeNum(p.unrealizedPnl?.unclaimedFeeTokenY?.usd);
    const currentValue = solMode
      ? safeNum(p.unrealizedPnl?.balancesSol)
      : safeNum(p.unrealizedPnl?.balances);
    const reportedPnlPct = solMode
      ? maybeNum(p.pnlSolPctChange)
      : maybeNum(p.pnlPctChange);
    const derivedPnlPct = deriveOpenPnlPct(p, solMode);
    return {
      pnl_usd:           roundNum(solMode ? p.pnlSol : p.pnlUsd, 4),
      pnl_pct:           roundNum(reportedPnlPct ?? derivedPnlPct ?? 0, 2),
      current_value_usd: roundNum(currentValue, 4),
      unclaimed_fee_usd: roundNum(unclaimedValue, 4),
      all_time_fees_usd: roundNum(solMode ? p.allTimeFees?.total?.sol : p.allTimeFees?.total?.usd, 4),
      fee_per_tvl_24h:   Math.round(parseFloat(p.feePerTvl24h || 0) * 100) / 100,
      in_range:    !p.isOutOfRange,
      lower_bin:   p.lowerBinId      ?? null,
      upper_bin:   p.upperBinId      ?? null,
      active_bin:  p.poolActiveBinId ?? null,
      age_minutes: p.createdAt ? Math.floor((Date.now() - p.createdAt * 1000) / 60000) : null,
    };
  } catch (error) {
    log("pnl_error", error.message);
    return { error: error.message };
  }
}

function safeNum(value) {
  const n = parseFloat(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function maybeNum(value) {
  if (value == null || value === "") return null;
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

function roundNum(value, decimals = 4) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

const PERFORMANCE_SIGNAL_FIELDS = [
  "organic_score",
  "fee_tvl_ratio",
  "volume",
  "mcap",
  "holder_count",
  "smart_wallets_present",
  "narrative_quality",
  "study_win_rate",
  "hive_consensus",
  "volatility",
];

function resolvePerformanceSignalSnapshot({ poolAddress, baseMint, tracked }) {
  const staged = config.darwin?.enabled
    ? getAndClearStagedSignals(poolAddress, baseMint)
    : null;
  const snapshot = {
    ...(staged || {}),
    ...(tracked?.signal_snapshot || {}),
  };

  if (baseMint && snapshot.base_mint == null) snapshot.base_mint = baseMint;
  for (const field of PERFORMANCE_SIGNAL_FIELDS) {
    if (snapshot[field] == null && tracked?.[field] != null) {
      snapshot[field] = tracked[field];
    }
  }

  return Object.values(snapshot).some((value) => value != null) ? snapshot : null;
}

function getClosedPnlValue(posEntry, solMode = false) {
  return solMode
    ? maybeNum(posEntry?.pnlSol) ?? maybeNum(posEntry?.pnl?.valueNative) ?? 0
    : maybeNum(posEntry?.pnlUsd) ?? maybeNum(posEntry?.pnl?.value) ?? 0;
}

function getClosedPnlPct(posEntry, solMode = false) {
  const reported = solMode
    ? maybeNum(posEntry?.pnlSolPctChange) ?? maybeNum(posEntry?.pnl?.percentNative)
    : maybeNum(posEntry?.pnlPctChange) ?? maybeNum(posEntry?.pnl?.percent);
  if (reported != null) return reported;

  const pnl = getClosedPnlValue(posEntry, solMode);
  const deposit = solMode
    ? maybeNum(posEntry?.allTimeDeposits?.total?.sol)
    : maybeNum(posEntry?.allTimeDeposits?.total?.usd);
  return deposit && deposit > 0 ? (pnl / deposit) * 100 : 0;
}

function deriveOpenPnlPct(binData, solMode = false) {
  if (!binData) return null;

  const deposit = solMode
    ? safeNum(binData.allTimeDeposits?.total?.sol)
    : safeNum(binData.allTimeDeposits?.total?.usd);
  if (deposit <= 0) return null;

  const balances = solMode
    ? safeNum(binData.unrealizedPnl?.balancesSol)
    : safeNum(binData.unrealizedPnl?.balances);
  const unclaimedFees = solMode
    ? safeNum(binData.unrealizedPnl?.unclaimedFeeTokenX?.amountSol) + safeNum(binData.unrealizedPnl?.unclaimedFeeTokenY?.amountSol)
    : safeNum(binData.unrealizedPnl?.unclaimedFeeTokenX?.usd) + safeNum(binData.unrealizedPnl?.unclaimedFeeTokenY?.usd);
  const withdrawals = solMode
    ? safeNum(binData.allTimeWithdrawals?.total?.sol)
    : safeNum(binData.allTimeWithdrawals?.total?.usd);
  const fees = solMode
    ? safeNum(binData.allTimeFees?.total?.sol)
    : safeNum(binData.allTimeFees?.total?.usd);

  const pnl = balances + unclaimedFees + withdrawals + fees - deposit;
  return (pnl / deposit) * 100;
}

function deriveLpAgentPnlPct(lpData, solMode = false) {
  if (!lpData) return null;
  const deposit = solMode ? safeNum(lpData.inputNative) : safeNum(lpData.inputValue);
  if (deposit <= 0) return null;

  const currentValue = solMode ? safeNum(lpData.valueNative) : safeNum(lpData.value);
  const unclaimedFees = solMode ? safeNum(lpData.unCollectedFeeNative) : safeNum(lpData.unCollectedFee);
  const pnl = currentValue + unclaimedFees - deposit;
  return (pnl / deposit) * 100;
}

async function fetchRawOpenPositionsFromMeridian({ walletAddress, agentId }) {
  const search = new URLSearchParams({
    owner: walletAddress,
    agentId: agentId || "agent-local",
  });
  const payload = await agentMeridianJson(`/positions/open/raw?${search.toString()}`, {
    headers: getAgentMeridianHeaders(),
    retry: {
      maxElapsedMs: 30_000,
      perAttemptTimeoutMs: 10_000,
    },
  });
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  const byPosition = {};
  for (const row of rows) {
    const addr = row?.position || row?.id || row?.tokenId;
    if (addr) byPosition[addr] = row;
  }
  return {
    ...payload,
    data: rows,
    byPosition,
  };
}

// ─── Get My Positions ──────────────────────────────────────────
export async function getMyPositions({ force = false, silent = false, wallet_address = null } = {}) {
  let walletOverride = null;
  try {
    walletOverride = wallet_address ? new PublicKey(wallet_address).toString() : null;
  } catch {
    return { wallet: wallet_address || null, total_positions: 0, positions: [], error: "Invalid wallet address" };
  }

  const useLocalWallet = !walletOverride;
  if (useLocalWallet && !force && _positionsCache && Date.now() - _positionsCacheAt < POSITIONS_CACHE_TTL) {
    return _positionsCache;
  }
  if (useLocalWallet && _positionsInflight) return _positionsInflight;

  let walletAddress;
  try {
    walletAddress = walletOverride || getWallet().publicKey.toString();
  } catch {
    return { wallet: null, total_positions: 0, positions: [], error: "Wallet not configured" };
  }

  const loadPositions = async () => { try {
    if (useLocalWallet) await reconcilePendingDualExits(getWallet());
    // ── Primary path: public infra (on-chain RPC + Jupiter + Meteora deposits) ──
    // No LPAgent / agentmeridian dependency, so the poller runs aggressively on
    // fully public resources. Falls through to the Meteora-API path on any error.
    if (config.pnl.source === "rpc") {
      try {
        if (!silent) log("positions", `Computing PnL from RPC (${new URL(config.pnl.rpcUrl).host})...`);
        const rpcResult = await computePositions(walletAddress);
        if (useLocalWallet) {
          await syncVerifiedOpenPositions(rpcResult.positions.map((p) => p.position));
          _positionsCache = rpcResult;
          _positionsCacheAt = Date.now();
        }
        return rpcResult;
      } catch (error) {
        const safeMessage = String(error.message).replaceAll(config.pnl.rpcUrl, "[PnL RPC URL]");
        log("positions_warn", `RPC PnL path failed; falling back to Meteora portfolio API: ${safeMessage}`);
      }
    }

    // ── Fallback path: Meteora portfolio + /pnl APIs (no LPAgent) ──
    if (!silent) log("positions", "Fetching portfolio via Meteora portfolio API...");
    const portfolioUrl = `https://dlmm.datapi.meteora.ag/portfolio/open?user=${walletAddress}`;
    const res = await fetch(portfolioUrl);
    if (!res.ok) throw new Error(`Portfolio API ${res.status}: ${await res.text().catch(() => "")}`);
    const portfolio = await res.json();

    const pools = portfolio.pools || [];
    log("positions", `Found ${pools.length} pool(s) with open positions`);

    // Fetch bin data (lowerBinId, upperBinId, poolActiveBinId) for all pools in parallel
    // Needed for rules 3 & 4 (active_bin vs upper_bin comparison)
    const binDataByPool = {};
    const pnlMaps = await Promise.all(pools.map(pool => fetchDlmmPnlForPool(pool.poolAddress, walletAddress)));
    const fallbackSolUsd = pools.some((pool) => (pool.listPositions || []).some((address) => getTrackedPosition(address)?.dual_token))
      ? await getSolUsdPrice() : null;
    pools.forEach((pool, i) => { binDataByPool[pool.poolAddress] = pnlMaps[i]; });
    const lpAgentByPosition = {}; // LPAgent removed — Meteora binData only

    const positions = [];
    for (const pool of pools) {
      for (const positionAddress of (pool.listPositions || [])) {
        const tracked = getTrackedPosition(positionAddress);
        const isOOR = pool.outOfRange || pool.positionsOutOfRange?.includes(positionAddress);

        if (isOOR) markOutOfRange(positionAddress);
        else markInRange(positionAddress);

        // Bin data: from supplemental PnL call (OOR) or tracked state (in-range)
        const binData = binDataByPool[pool.poolAddress]?.[positionAddress];
        if (!binData) {
          log("positions_warn", `PnL API missing data for ${positionAddress.slice(0, 8)} in pool ${pool.poolAddress.slice(0, 8)} — using portfolio only for open-position discovery`);
        }
        const lowerBin  = binData?.lowerBinId      ?? tracked?.bin_range?.min ?? null;
        const upperBin  = binData?.upperBinId      ?? tracked?.bin_range?.max ?? null;
        const activeBin = binData?.poolActiveBinId ?? tracked?.bin_range?.active ?? null;
        const lpData = lpAgentByPosition[positionAddress] || null;

        const ageFromState = tracked?.deployed_at
          ? Math.floor((Date.now() - new Date(tracked.deployed_at).getTime()) / 60000)
          : null;
        const reportedPnlPct = lpData
          ? parseFloat(config.management.solMode ? (lpData.pnl?.percentNative || 0) : (lpData.pnl?.percent || 0))
          : binData
            ? parseFloat(config.management.solMode ? (binData.pnlSolPctChange || 0) : (binData.pnlPctChange || 0))
            : null;
        const derivedPnlPct = lpData
          ? deriveLpAgentPnlPct(lpData, config.management.solMode)
          : binData
            ? deriveOpenPnlPct(binData, config.management.solMode)
            : null;
        const dualFeeIncomeSol = binData ?
          safeNum(binData.unrealizedPnl?.unclaimedFeeTokenX?.amountSol) +
          safeNum(binData.unrealizedPnl?.unclaimedFeeTokenY?.amountSol) +
          safeNum(binData.allTimeFees?.total?.sol) : null;
        let dualPnl = null;
        const positionRentSol = tracked?.dual_token ? await readPositionRentSol(positionAddress) : null;
        if (tracked?.dual_token && tracked.dual_deploy?.amount_sol > 0 && binData
          && maybeNum(binData.pnlSol) != null && maybeNum(binData.allTimeDeposits?.total?.sol) > 0
          && tracked.dual_deploy?.transaction_fees_sol != null && tracked.dual_deploy?.fee_accounting_complete !== false
          && positionRentSol != null) {
          try {
            dualPnl = computeDualPnl({
              rawPnlSol: safeNum(binData.pnlSol),
              depositsSol: safeNum(binData.allTimeDeposits?.total?.sol),
              budgetSol: tracked.dual_deploy.amount_sol,
              feeIncomeSol: dualFeeIncomeSol,
              transactionFeesSol: tracked.dual_deploy.transaction_fees_sol ?? 0,
              rentPaidSol: tracked.dual_deploy.position_rent_paid_sol ?? positionRentSol,
              rentRecoveredSol: positionRentSol,
            });
          } catch (error) {
            log("pnl_warn", `Dual-token fallback accounting unavailable for ${positionAddress.slice(0, 8)}: ${error.message}`);
          }
        }
        const effectivePnlPct = tracked?.dual_token ? dualPnl?.netPnlPct ?? null : derivedPnlPct ?? reportedPnlPct;
        const pnlPctDiff = !tracked?.dual_token && reportedPnlPct != null && derivedPnlPct != null
          ? Math.abs(reportedPnlPct - derivedPnlPct)
          : null;
        const pnlPctSuspicious = tracked?.dual_token ? !dualPnl : pnlPctDiff != null && pnlPctDiff > (config.management.pnlSanityMaxDiffPct ?? 5);
        if (pnlPctSuspicious) {
          log("positions_warn", `Suspicious pnl_pct for ${positionAddress.slice(0, 8)}: reported=${Number.isFinite(reportedPnlPct) ? reportedPnlPct.toFixed(2) : "unknown"} derived=${Number.isFinite(derivedPnlPct) ? derivedPnlPct.toFixed(2) : "unknown"} diff=${Number.isFinite(pnlPctDiff) ? pnlPctDiff.toFixed(2) : "unknown"}`);
        }

        positions.push({
          position:           positionAddress,
          pool:               pool.poolAddress,
          pair:               tracked?.pool_name || `${pool.tokenX}/${pool.tokenY}`,
          base_mint:          pool.tokenXMint,
          token_x_mint:       tracked?.token_x_mint || pool.tokenXMint,
          token_y_mint:       tracked?.token_y_mint || pool.tokenYMint,
          dual_token:         !!tracked?.dual_token,
          lower_bin:          lowerBin,
          upper_bin:          upperBin,
          active_bin:         activeBin,
          in_range:           binData ? !binData.isOutOfRange : !isOOR,
          unclaimed_fees_usd: lpData
            ? Math.round((
                config.management.solMode
                  ? safeNum(lpData.unCollectedFeeNative)
                  : safeNum(lpData.unCollectedFee)
              ) * 10000) / 10000
            : binData
            ? Math.round((
                config.management.solMode
                  ? parseFloat(binData.unrealizedPnl?.unclaimedFeeTokenX?.amountSol || 0) + parseFloat(binData.unrealizedPnl?.unclaimedFeeTokenY?.amountSol || 0)
                  : parseFloat(binData.unrealizedPnl?.unclaimedFeeTokenX?.usd || 0) + parseFloat(binData.unrealizedPnl?.unclaimedFeeTokenY?.usd || 0)
              ) * 10000) / 10000
            : null,
          total_value_usd:    lpData
            ? Math.round((
                config.management.solMode
                  ? safeNum(lpData.valueNative)
                  : safeNum(lpData.value)
              ) * 10000) / 10000
            : binData
            ? Math.round((
                config.management.solMode
                  ? parseFloat(binData.unrealizedPnl?.balancesSol || 0)
                  : parseFloat(binData.unrealizedPnl?.balances || 0)
              ) * 10000) / 10000
            : null,
          // Always-USD fields for internal accounting and lesson recording.
          total_value_true_usd: lpData
            ? Math.round(safeNum(lpData.value) * 10000) / 10000
            : binData
            ? Math.round(parseFloat(binData.unrealizedPnl?.balances || 0) * 10000) / 10000
            : null,
          collected_fees_usd: lpData
            ? Math.round((
                config.management.solMode
                  ? safeNum(lpData.collectedFeeNative)
                  : safeNum(lpData.collectedFee)
              ) * 10000) / 10000
            : binData
            ? Math.round(parseFloat(config.management.solMode ? (binData.allTimeFees?.total?.sol || 0) : (binData.allTimeFees?.total?.usd || 0)) * 10000) / 10000
            : null,
          collected_fees_true_usd: lpData
            ? Math.round(safeNum(lpData.collectedFee) * 10000) / 10000
            : binData
            ? Math.round(parseFloat(binData.allTimeFees?.total?.usd || 0) * 10000) / 10000
            : null,
          pnl_usd:            tracked?.dual_token
            ? (dualPnl ? (config.management.solMode ? dualPnl.netPnlSol : fallbackSolUsd == null ? null : Math.round(dualPnl.netPnlSol * fallbackSolUsd * 10000) / 10000) : null)
            : lpData
            ? Math.round((
                config.management.solMode
                  ? safeNum(lpData.pnl?.valueNative)
                  : safeNum(lpData.pnl?.value)
              ) * 10000) / 10000
            : binData
            ? Math.round(parseFloat(config.management.solMode ? (binData.pnlSol || 0) : (binData.pnlUsd || 0)) * 10000) / 10000
            : null,
          pnl_sol_net: dualPnl?.netPnlSol ?? null,
          capital_pnl_sol_net: dualPnl?.capitalPnlSol ?? null,
          dual_transaction_fees_sol: dualPnl?.executionFeesSol ?? null,
          dual_rent_paid_sol: dualPnl?.rentPaidSol ?? null,
          dual_rent_recovered_sol: dualPnl?.rentRecoveredSol ?? null,
          fee_income_sol: dualFeeIncomeSol,
          pnl_includes_capital_gain: !!(lpData || binData),
          pnl_true_usd:       tracked?.dual_token
            ? (dualPnl && fallbackSolUsd != null ? Math.round(dualPnl.netPnlSol * fallbackSolUsd * 10000) / 10000 : null)
            : lpData
            ? Math.round(safeNum(lpData.pnl?.value) * 10000) / 10000
            : binData
            ? Math.round(parseFloat(binData.pnlUsd || 0) * 10000) / 10000
            : null,
          raw_pnl_sol: binData ? safeNum(binData.pnlSol) : null,
          deposits_sol: binData ? safeNum(binData.allTimeDeposits?.total?.sol) : null,
          dual_fee_income_sol: binData ? Math.round((
            safeNum(binData.unrealizedPnl?.unclaimedFeeTokenX?.amountSol) +
            safeNum(binData.unrealizedPnl?.unclaimedFeeTokenY?.amountSol) +
            safeNum(binData.allTimeFees?.total?.sol)
          ) * 10000) / 10000 : null,
          capital_pnl_sol: binData
            ? Math.round((
                safeNum(binData.unrealizedPnl?.balancesSol) +
                safeNum(binData.allTimeWithdrawals?.total?.sol) -
                safeNum(binData.allTimeDeposits?.total?.sol)
              ) * 10000) / 10000
            : null,
          capital_pnl_usd: binData
            ? Math.round((
                safeNum(binData.unrealizedPnl?.balances) +
                safeNum(binData.allTimeWithdrawals?.total?.usd) -
                safeNum(binData.allTimeDeposits?.total?.usd)
              ) * 10000) / 10000
            : null,
          fee_income_sol: binData
            ? Math.round((
                safeNum(binData.unrealizedPnl?.unclaimedFeeTokenX?.amountSol) +
                safeNum(binData.unrealizedPnl?.unclaimedFeeTokenY?.amountSol) +
                safeNum(binData.allTimeFees?.total?.sol)
              ) * 10000) / 10000
            : null,
          fee_income_usd: binData
            ? Math.round((
                safeNum(binData.unrealizedPnl?.unclaimedFeeTokenX?.usd) +
                safeNum(binData.unrealizedPnl?.unclaimedFeeTokenY?.usd) +
                safeNum(binData.allTimeFees?.total?.usd)
              ) * 10000) / 10000
            : null,
          pnl_includes_capital_gain: !!(lpData || binData),
          pnl_pct:            effectivePnlPct != null
            ? Math.round(effectivePnlPct * 100) / 100
            : null,
          pnl_pct_derived:    derivedPnlPct != null ? Math.round(derivedPnlPct * 100) / 100 : null,
          pnl_pct_diff:       pnlPctDiff != null ? Math.round(pnlPctDiff * 100) / 100 : null,
          pnl_pct_suspicious: !!pnlPctSuspicious,
          unclaimed_fees_true_usd: lpData
            ? Math.round(safeNum(lpData.unCollectedFee) * 10000) / 10000
            : binData
            ? Math.round((parseFloat(binData.unrealizedPnl?.unclaimedFeeTokenX?.usd || 0) + parseFloat(binData.unrealizedPnl?.unclaimedFeeTokenY?.usd || 0)) * 10000) / 10000
            : null,
          fee_per_tvl_24h:    binData
            ? Math.round(parseFloat(binData.feePerTvl24h || 0) * 100) / 100
            : null,
          age_minutes:        binData?.createdAt ? Math.floor((Date.now() - binData.createdAt * 1000) / 60000) : ageFromState,
          minutes_out_of_range: minutesOutOfRange(positionAddress),
          instruction:        tracked?.instruction ?? null,
        });
      }
    }

    const result = {
      wallet: walletAddress,
      total_positions: positions.length,
      positions,
      source: "meteora",
    };
    if (useLocalWallet) {
      await syncVerifiedOpenPositions(positions.map(p => p.position));
      _positionsCache = result;
      _positionsCacheAt = Date.now();
    }
    return result;
  } catch (error) {
    log("positions_error", `Portfolio fetch failed: ${error.stack || error.message}`);
    return { wallet: walletAddress, total_positions: 0, positions: [], error: error.message };
  } finally {
    if (useLocalWallet) _positionsInflight = null;
  }
  };

  if (useLocalWallet) {
    _positionsInflight = loadPositions();
    return _positionsInflight;
  }

  return loadPositions();
}

// ─── Get Positions for Any Wallet ─────────────────────────────
export async function getWalletPositions({ wallet_address }) {
  try {
    const DLMM_PROGRAM = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");

    const accounts = await getConnection().getProgramAccounts(DLMM_PROGRAM, {
      filters: [{ memcmp: { offset: 40, bytes: new PublicKey(wallet_address).toBase58() } }],
    });

    if (accounts.length === 0) {
      return { wallet: wallet_address, total_positions: 0, positions: [] };
    }

    const raw = accounts.map((acc) => ({
      position: acc.pubkey.toBase58(),
      pool: new PublicKey(acc.account.data.slice(8, 40)).toBase58(),
    }));

    // Enrich with PnL API
    const uniquePools = [...new Set(raw.map((r) => r.pool))];
    const pnlMaps = await Promise.all(uniquePools.map((pool) => fetchDlmmPnlForPool(pool, wallet_address)));
    const pnlByPool = {};
    uniquePools.forEach((pool, i) => { pnlByPool[pool] = pnlMaps[i]; });

    const positions = raw.map((r) => {
      const p = pnlByPool[r.pool]?.[r.position] || null;
      const solMode = config.management.solMode;
      const unclaimedValue = p
        ? solMode
          ? safeNum(p.unrealizedPnl?.unclaimedFeeTokenX?.amountSol) + safeNum(p.unrealizedPnl?.unclaimedFeeTokenY?.amountSol)
          : safeNum(p.unrealizedPnl?.unclaimedFeeTokenX?.usd) + safeNum(p.unrealizedPnl?.unclaimedFeeTokenY?.usd)
        : 0;
      const currentValue = p
        ? solMode
          ? safeNum(p.unrealizedPnl?.balancesSol)
          : safeNum(p.unrealizedPnl?.balances)
        : 0;
      const reportedPnlPct = p
        ? solMode
          ? maybeNum(p.pnlSolPctChange)
          : maybeNum(p.pnlPctChange)
        : null;
      const derivedPnlPct = p ? deriveOpenPnlPct(p, solMode) : null;

      return {
        position:           r.position,
        pool:               r.pool,
        lower_bin:          p?.lowerBinId      ?? null,
        upper_bin:          p?.upperBinId      ?? null,
        active_bin:         p?.poolActiveBinId ?? null,
        in_range:           p ? !p.isOutOfRange : null,
        unclaimed_fees_usd: roundNum(unclaimedValue, 4),
        total_value_usd:    roundNum(currentValue, 4),
        pnl_usd:            roundNum(p ? (solMode ? p.pnlSol : p.pnlUsd) : 0, 4),
        pnl_pct:            roundNum(reportedPnlPct ?? derivedPnlPct ?? 0, 2),
        age_minutes:        p?.createdAt ? Math.floor((Date.now() - p.createdAt * 1000) / 60000) : null,
      };
    });

    return { wallet: wallet_address, total_positions: positions.length, positions };
  } catch (error) {
    log("wallet_positions_error", error.message);
    return { wallet: wallet_address, total_positions: 0, positions: [], error: error.message };
  }
}

// ─── Search Pools by Query ─────────────────────────────────────
export async function searchPools({ query, limit = 10 }) {
  const url = `https://dlmm.datapi.meteora.ag/pools?query=${encodeURIComponent(query)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Pool search API error: ${res.status} ${res.statusText}`);
  const data = await res.json();
  const pools = (Array.isArray(data) ? data : data.data || []).slice(0, limit);
  return {
    query,
    total: pools.length,
    pools: pools.map((p) => ({
      pool: p.address || p.pool_address,
      name: p.name,
      bin_step: p.bin_step ?? p.dlmm_params?.bin_step,
      fee_pct: p.base_fee_percentage ?? p.fee_pct,
      tvl: p.liquidity,
      volume_24h: p.trade_volume_24h,
      token_x: { symbol: p.mint_x_symbol ?? p.token_x?.symbol, mint: p.mint_x ?? p.token_x?.address },
      token_y: { symbol: p.mint_y_symbol ?? p.token_y?.symbol, mint: p.mint_y ?? p.token_y?.address },
    })),
  };
}

// ─── Claim Fees ────────────────────────────────────────────────
export async function claimFees({ position_address }) {
  position_address = normalizeMint(position_address);
  if (process.env.DRY_RUN === "true") {
    return { dry_run: true, would_claim: position_address, message: "DRY RUN — no transaction sent" };
  }

  const tracked = getTrackedPosition(position_address);
  if (tracked?.closed) {
    return { success: false, error: "Position already closed — fees were claimed during close" };
  }

  try {
    log("claim", `Claiming fees for position: ${position_address}`);
    const wallet = getWallet();
    const poolAddress = await lookupPoolForPosition(position_address, wallet.publicKey.toString());
    // Clear cached pool so SDK loads fresh position fee state
    poolCache.delete(poolAddress.toString());
    const pool = await getPool(poolAddress);

    const positionData = await pool.getPosition(new PublicKey(position_address));
    const txs = await pool.claimSwapFee({
      owner: wallet.publicKey,
      position: positionData,
    });

    if (!txs || txs.length === 0) {
      return { success: false, error: "No fees to claim — transaction is empty" };
    }

    const txHashes = [];
    for (const tx of txs) {
      const txHash = await sendAndConfirmTransaction(getConnection(), tx, [wallet]);
      txHashes.push(txHash);
    }
    log("claim", `SUCCESS txs: ${txHashes.join(", ")}`);
    _positionsCacheAt = 0; // invalidate cache after claim
    recordClaim(position_address);

    return { success: true, position: position_address, txs: txHashes, base_mint: pool.lbPair.tokenXMint.toString() };
  } catch (error) {
    log("claim_error", error.message);
    return { success: false, error: error.message };
  }
}

// ─── Close Position ────────────────────────────────────────────
export async function closePosition({ position_address, reason }) {
  position_address = normalizeMint(position_address);
  if (process.env.DRY_RUN === "true") {
    return { dry_run: true, would_close: position_address, message: "DRY RUN — no transaction sent" };
  }

  const tracked = getTrackedPosition(position_address);

  try {
    log("close", `Closing position: ${position_address}`);
    const wallet = getWallet();
    const poolAddress = await lookupPoolForPosition(position_address, wallet.publicKey.toString());
    const poolMeta = await getPoolMetadata(poolAddress);
    let pool = await getPool(poolAddress);
    const positionAccountBefore = tracked?.dual_token
      ? await getConnection().getAccountInfo(new PublicKey(position_address), "confirmed")
      : null;
    const dualMints = tracked?.dual_token
      ? [pool.lbPair.tokenXMint.toString(), pool.lbPair.tokenYMint.toString()]
      : [];
    const dualBalancesBefore = {};
    for (const mint of dualMints.filter((address) => address !== config.tokens.SOL)) {
      dualBalancesBefore[mint] = await getMintBalanceRaw(wallet.publicKey, mint);
    }
    const withDualCloseAssets = async (result) => {
      if (!tracked?.dual_token) return result;
      const assets = [];
      for (const mint of dualMints.filter((address) => address !== config.tokens.SOL)) {
        const balanceAfter = BigInt(await getMintBalanceRaw(wallet.publicKey, mint));
        const balanceBefore = BigInt(dualBalancesBefore[mint] || "0");
        const amountRaw = balanceAfter > balanceBefore ? balanceAfter - balanceBefore : 0n;
        if (amountRaw <= 0n) continue;
        const mintInfo = await getConnection().getParsedAccountInfo(new PublicKey(mint), "confirmed");
        const decimals = mintInfo.value?.data?.parsed?.info?.decimals;
        if (!Number.isInteger(decimals)) throw new Error(`Could not read decimals for closed token ${mint}`);
        assets.push({ mint, amount_raw: amountRaw.toString(), decimals });
      }
      const positionAccountAfter = await getConnection().getAccountInfo(new PublicKey(position_address), "confirmed");
      const positionRentRecoveredSol = positionAccountBefore && !positionAccountAfter
        ? positionAccountBefore.lamports / 1e9
        : null;
      let exitOperation = null;
      if (assets.length) {
        try {
          exitOperation = await executeOrResumeDualExit({
            positionAddress: position_address,
            poolAddress,
            wallet,
            assets,
            positionRentRecoveredSol,
          });
        } catch (error) {
          exitOperation = { stage: "recovery_pending", error: error.message };
          log("dual_exit_warn", `Position closed but token-to-SOL recovery needs retry: ${error.message}`);
        }
      }
      let persistedExit = exitOperation?.operation_id
        ? await dualOperationJournal.get(exitOperation.operation_id)
        : exitOperation?.id ? await dualOperationJournal.get(exitOperation.id) : null;
      if (!persistedExit && assets.length) {
        persistedExit = (await dualOperationJournal.list({ includeTerminal: true }))
          .find((operation) => operation.idempotencyKey === `dual-exit:${position_address}`) || null;
      }
      const remainingExitAssets = persistedExit
        ? Object.values(persistedExit.assetsRemaining || {}).filter((asset) => BigInt(asset.amount_raw || "0") > 0n)
        : assets;
      const exitSwapFeesSol = persistedExit ? sumRecordedDualTransactionFees(persistedExit) : 0;
      let dualPnl = null;
      const rentPaidSol = tracked?.dual_deploy?.position_rent_paid_sol
        ?? (positionAccountBefore?.lamports != null ? positionAccountBefore.lamports / 1e9 : null);
      if (tracked?.dual_token && Number.isFinite(result.dual_raw_pnl_sol) && Number.isFinite(result.dual_deposits_sol)
        && result.dual_deposits_sol > 0
        && tracked.dual_deploy?.transaction_fees_sol != null && tracked.dual_deploy?.fee_accounting_complete !== false) {
        let closeTransactionFeesSol = 0;
        let closeFeeAccountingComplete = true;
        for (const signature of result.txs || []) {
          const feeSol = await getConfirmedTransactionFeeSol(signature);
          if (feeSol == null) closeFeeAccountingComplete = false;
          else closeTransactionFeesSol += feeSol;
        }
        if (persistedExit && sumRecordedDualTransactionFees(persistedExit) == null) closeFeeAccountingComplete = false;
        if (closeFeeAccountingComplete && rentPaidSol != null && positionRentRecoveredSol != null) dualPnl = computeDualPnl({
          rawPnlSol: result.dual_raw_pnl_sol,
          depositsSol: result.dual_deposits_sol,
          budgetSol: tracked.dual_deploy.amount_sol,
          feeIncomeSol: result.dual_fee_income_sol ?? 0,
          transactionFeesSol: (tracked.dual_deploy.transaction_fees_sol ?? 0) + closeTransactionFeesSol + exitSwapFeesSol,
          rentPaidSol,
          rentRecoveredSol: positionRentRecoveredSol,
        });
      }
      return {
        ...result,
        dual_token: true,
        auto_swap_assets: remainingExitAssets,
        auto_swap_complete: persistedExit?.stage === "completed" || assets.length === 0,
        auto_swap_note: assets.length === 0
          ? "No non-SOL token balance was recovered from the pool."
          : persistedExit?.stage === "completed"
            ? `Both pool tokens converted to SOL; received ${(Number(BigInt(persistedExit.solReceivedLamports || "0")) / 1e9).toFixed(6)} SOL.`
            : persistedExit
              ? `Token-to-SOL conversion remains queued for automatic retry${exitOperation?.error ? `: ${exitOperation.error}` : "."}`
              : `Could not persist automatic token-to-SOL recovery. Manual attention is required${exitOperation?.error ? `: ${exitOperation.error}` : "."}`,
        exit_swap_txs: (persistedExit?.transactions || []).filter((transaction) => transaction.kind.startsWith("exit_swap:")).map((transaction) => transaction.signature),
        position_rent_recovered_sol: positionRentRecoveredSol,
        dual_pnl: dualPnl,
        ...(dualPnl ? { pnl_sol: dualPnl.netPnlSol, pnl_pct: dualPnl.netPnlPct } : {}),
      };
    };
    if (shouldUseLpAgentRelay() && !tracked?.dual_token) {
      let relaySubmitted = false;
      try {
      const relayAllowedDebitMints = [
        pool.lbPair.tokenXMint.toString(),
        pool.lbPair.tokenYMint.toString(),
        config.tokens.SOL,
      ];
      const livePositions = await getMyPositions({ force: true, silent: true });
      const livePosition = livePositions?.positions?.find((position) => position.position === position_address);
      const closeFromBinId = livePosition?.lower_bin ?? tracked?.bin_range?.min ?? -887272;
      const closeToBinId = livePosition?.upper_bin ?? tracked?.bin_range?.max ?? 887272;
      const closeOutput = "allToken1";

      const order = await agentMeridianJson("/execution/zap-out/order", {
        method: "POST",
        headers: getAgentMeridianHeaders({ json: true }),
        body: JSON.stringify({
          agentId: getAgentIdForRequests(),
          idempotencyKey: `close:${position_address}:10000`,
          positionId: position_address,
          owner: wallet.publicKey.toString(),
          bps: 10000,
          slippageBps: 5000,
          output: closeOutput,
          provider: "OKX",
          type: "meteora",
          fromBinId: closeFromBinId,
          toBinId: closeToBinId,
        }),
      });

      const closeUnsigned = order?.order?.transactions?.close || [];
      const swapUnsigned = order?.order?.transactions?.swap || [];
      if (closeUnsigned.length + swapUnsigned.length === 0) {
        throw new Error("LPAgent close order returned no transactions. Check the position, selected output, and relay order response.");
      }

      const closeSigned = await signAndSimulateRelayTransactions(closeUnsigned, wallet, {
        label: "zap-out close",
        allowedDebitMints: relayAllowedDebitMints,
        maxSolLoss: 0.05,
        requiredStaticAccounts: [wallet.publicKey.toString(), position_address],
      });
      const swapSigned = await signAndSimulateRelayTransactions(swapUnsigned, wallet, {
        label: "zap-out swap",
        allowedDebitMints: relayAllowedDebitMints,
        maxSolLoss: 0.05,
        requiredStaticAccounts: [wallet.publicKey.toString()],
      });

      relaySubmitted = true;
      const submit = await agentMeridianJson("/execution/zap-out/submit", {
        method: "POST",
        headers: getAgentMeridianHeaders({ json: true }),
        body: JSON.stringify({
          requestId: order.requestId,
          lastValidBlockHeight: order?.order?.lastValidBlockHeight,
          transactions: {
            close: closeSigned,
            swap: swapSigned,
          },
        }),
      });

      const claimTxHashes = [];
      const closeTxHashes = normalizeExecutionSignatures(submit);
      const txHashes = [...claimTxHashes, ...closeTxHashes];

      await new Promise((resolve) => setTimeout(resolve, 5000));
      _positionsCacheAt = 0;

      let closedConfirmed = false;
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          const refreshed = await getMyPositions({ force: true, silent: true });
          const stillOpen = refreshed?.positions?.some((p) => p.position === position_address);
          if (!stillOpen) {
            closedConfirmed = true;
            break;
          }
          log("close_warn", `Relay close still appears open after submit (attempt ${attempt + 1}/4)`);
        } catch (e) {
          log("close_warn", `Relay close verification failed (attempt ${attempt + 1}/4): ${e.message}`);
        }
        if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 3000));
      }

      if (!closedConfirmed) {
        return {
          success: false,
          error: "Close submit succeeded but position still appears open after verification window",
          position: position_address,
          pool: poolAddress,
          close_txs: closeTxHashes,
          txs: txHashes,
        };
      }

      recordClose(position_address, reason || "agent decision");

      if (tracked) {
        const deployedAt = new Date(tracked.deployed_at).getTime();
        const minutesHeld = Math.floor((Date.now() - deployedAt) / 60000);
        let minutesOOR = 0;
        if (tracked.out_of_range_since) {
          minutesOOR = Math.floor((Date.now() - new Date(tracked.out_of_range_since).getTime()) / 60000);
        }

        let pnlUsd = 0;
        let pnlTrueUsd = 0;
        let pnlPct = 0;
        let finalValueUsd = 0;
        let initialUsd = 0;
        let feesUsd = tracked.total_fees_claimed_usd || 0;
        try {
          const closedUrl = `https://dlmm.datapi.meteora.ag/positions/${poolAddress}/pnl?user=${wallet.publicKey.toString()}&status=closed&pageSize=50&page=1`;
          for (let attempt = 0; attempt < 6; attempt++) {
            const res = await fetch(closedUrl);
            if (res.ok) {
              const data = await res.json();
              const posEntry = (data.positions || []).find((entry) => entry.positionAddress === position_address);
              if (posEntry) {
                pnlTrueUsd = safeNum(posEntry.pnlUsd);
                pnlUsd = config.management.solMode ? getClosedPnlValue(posEntry, true) : pnlTrueUsd;
                pnlPct = getClosedPnlPct(posEntry, config.management.solMode);
                finalValueUsd = parseFloat(posEntry.allTimeWithdrawals?.total?.usd || 0);
                initialUsd = parseFloat(posEntry.allTimeDeposits?.total?.usd || 0);
                feesUsd = parseFloat(posEntry.allTimeFees?.total?.usd || 0) || feesUsd;
                break;
              }
            }
            if (attempt < 5) await new Promise((resolve) => setTimeout(resolve, 5000));
          }
        } catch (e) {
          log("close_warn", `Relay closed PnL fetch failed: ${e.message}`);
        }

        const closeBaseMint = livePosition?.base_mint || pool.lbPair.tokenXMint.toString();
        const signalSnapshot = resolvePerformanceSignalSnapshot({
          poolAddress,
          baseMint: closeBaseMint,
          tracked,
        });

        let exitMarket = {};
        try {
          const { default: fetch } = await import("node-fetch").catch(() => ({ default: globalThis.fetch }));
          const exitDetail = await fetch(`https://pool-discovery-api.datapi.meteora.ag/pools?page_size=1&filter_by=${encodeURIComponent(`pool_address=${poolAddress}`)}&timeframe=${encodeURIComponent(config.screening?.timeframe || "5m")}`).then(r => r.json()).catch(() => null);
          const ep = exitDetail?.data?.[0];
          if (ep) {
            exitMarket = {
              exit_mcap: parseFloat(ep?.token_x?.market_cap) || null,
              exit_tvl: parseFloat(ep?.tvl ?? ep?.active_tvl) || null,
              exit_volume: parseFloat(ep?.volume) || null,
            };
          }
        } catch { /* non-blocking */ }

        await recordPerformance({
          position: position_address,
          pool: poolAddress,
          pool_name: tracked.pool_name || poolMeta.name || poolAddress.slice(0, 8),
          base_mint: closeBaseMint,
          strategy: tracked.strategy,
          bin_range: tracked.bin_range,
          bin_step: tracked.bin_step || null,
          volatility: tracked.volatility ?? null,
          fee_tvl_ratio: tracked.fee_tvl_ratio || null,
          organic_score: tracked.organic_score || null,
          amount_sol: tracked.amount_sol,
          fees_earned_usd: feesUsd,
          final_value_usd: finalValueUsd,
          initial_value_usd: initialUsd,
          minutes_in_range: minutesHeld - minutesOOR,
          minutes_held: minutesHeld,
          close_reason: reason || "agent decision",
          signal_snapshot: signalSnapshot,
          entry_mcap: tracked.entry_mcap ?? null,
          entry_tvl: tracked.entry_tvl ?? null,
          entry_volume: tracked.entry_volume ?? null,
          entry_holders: tracked.entry_holders ?? null,
          ...exitMarket,
        });

        appendDecision({
          type: "close",
          actor: "MANAGER",
          pool: poolAddress,
          pool_name: tracked.pool_name || poolMeta.name || poolAddress.slice(0, 8),
          position: position_address,
          summary: `Relay closed at ${pnlPct.toFixed(2)}%`,
          reason: reason || "agent decision",
          risks: [
            minutesOOR > 0 ? `out of range ${minutesOOR}m` : null,
            tracked.volatility != null ? `volatility ${tracked.volatility}` : null,
          ].filter(Boolean),
          metrics: {
            pnl_usd: pnlUsd,
            pnl_pct: pnlPct,
            fees_usd: feesUsd,
            minutes_held: minutesHeld,
          },
        });

        return await withDualCloseAssets({
          success: true,
          relay: true,
          request_id: order.requestId,
          position: position_address,
          pool: poolAddress,
          pool_name: tracked.pool_name || poolMeta.name || null,
          claim_txs: claimTxHashes,
          close_txs: closeTxHashes,
          txs: txHashes,
          pnl_usd: pnlUsd,
          pnl_pct: pnlPct,
          base_mint: closeBaseMint,
        });
      }

      appendDecision({
        type: "close",
        actor: "MANAGER",
        pool: poolAddress,
        pool_name: poolMeta.name || poolAddress.slice(0, 8),
        position: position_address,
        summary: "Relay closed position",
        reason: reason || "agent decision",
        metrics: {},
      });

      return await withDualCloseAssets({
        success: true,
        relay: true,
        request_id: order.requestId,
        position: position_address,
        pool: poolAddress,
        pool_name: poolMeta.name || null,
        claim_txs: claimTxHashes,
        close_txs: closeTxHashes,
        txs: txHashes,
        base_mint: livePosition?.base_mint || null,
      });
      } catch (relayError) {
        if (relaySubmitted) throw relayError;
        log("close_warn", `Relay zap-out failed before submit; falling back to local close + Jupiter autoswap: ${relayError.message}`);
      }
    }

    // Clear cached pool so SDK loads fresh position fee state
    poolCache.delete(poolAddress.toString());
    pool = await getPool(poolAddress);

    const positionPubKey = new PublicKey(position_address);
    const claimTxHashes = [];
    const closeTxHashes = [];

    // ─── Step 1: Claim Fees (to clear account state) ───────────
    const recentlyClaimed = tracked?.last_claim_at && (Date.now() - new Date(tracked.last_claim_at).getTime()) < 60_000;
    try {
      if (recentlyClaimed) {
        log("close", `Step 1: Skipping claim — fees already claimed ${Math.round((Date.now() - new Date(tracked.last_claim_at).getTime()) / 1000)}s ago`);
      } else {
        log("close", `Step 1: Claiming fees for ${position_address}`);
        const positionData = await pool.getPosition(positionPubKey);
        const claimTxs = await pool.claimSwapFee({
          owner: wallet.publicKey,
          position: positionData,
        });
        if (claimTxs && claimTxs.length > 0) {
          for (const tx of claimTxs) {
            const claimHash = await sendAndConfirmTransaction(getConnection(), tx, [wallet]);
            claimTxHashes.push(claimHash);
          }
          log("close", `Step 1 OK (claim only): ${claimTxHashes.join(", ")}`);
        }
      }
    } catch (e) {
      log("close_warn", `Step 1 (Claim) failed or nothing to claim: ${e.message}`);
    }

    // ─── Step 2: Remove Liquidity & Close ──────────────────────
    let hasLiquidity = false;
    let closeFromBinId = -887272;
    let closeToBinId = 887272;
    try {
      const positionDataForClose = await pool.getPosition(positionPubKey);
      const processed = positionDataForClose?.positionData;
      if (processed) {
        closeFromBinId = processed.lowerBinId ?? closeFromBinId;
        closeToBinId = processed.upperBinId ?? closeToBinId;
        const bins = Array.isArray(processed.positionBinData) ? processed.positionBinData : [];
        hasLiquidity = bins.some((bin) => new BN(bin.positionLiquidity || "0").gt(new BN(0)));
      }
    } catch (e) {
      log("close_warn", `Could not check liquidity state: ${e.message}`);
    }

    if (hasLiquidity) {
      log("close", `Step 2: Removing liquidity and closing account`);
      const closeTx = await pool.removeLiquidity({
        user: wallet.publicKey,
        position: positionPubKey,
        fromBinId: closeFromBinId,
        toBinId: closeToBinId,
        bps: new BN(10000),
        shouldClaimAndClose: true,
      });

      for (const tx of Array.isArray(closeTx) ? closeTx : [closeTx]) {
        const txHash = await sendAndConfirmTransaction(getConnection(), tx, [wallet]);
        closeTxHashes.push(txHash);
      }
    } else {
      log("close", `Step 2: No position liquidity detected, closing account`);
      const closeTx = await pool.closePosition({
        owner: wallet.publicKey,
        position: { publicKey: positionPubKey },
      });
      const txHash = await sendAndConfirmTransaction(getConnection(), closeTx, [wallet]);
      closeTxHashes.push(txHash);
    }
    const txHashes = [...claimTxHashes, ...closeTxHashes];
    log("close", `Step 2 OK (close only): ${closeTxHashes.join(", ") || "none"}`);
    log("close", `SUCCESS txs: ${txHashes.join(", ")}`);
    // Wait for RPC to reflect withdrawn balances before returning — prevents
    // agent from seeing zero balance when attempting post-close swap
    await new Promise(r => setTimeout(r, 5000));
    _positionsCacheAt = 0;

    let closedConfirmed = false;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const refreshed = await getMyPositions({ force: true, silent: true });
        const stillOpen = refreshed?.positions?.some((p) => p.position === position_address);
        if (!stillOpen) {
          closedConfirmed = true;
          break;
        }
        log("close_warn", `Position ${position_address} still appears open after close txs (attempt ${attempt + 1}/4)`);
      } catch (e) {
        log("close_warn", `Close verification failed (attempt ${attempt + 1}/4): ${e.message}`);
      }
      if (attempt < 3) await new Promise((r) => setTimeout(r, 3000));
    }

    if (!closedConfirmed) {
      return {
        success: false,
        error: "Close transactions sent but position still appears open after verification window",
        position: position_address,
        pool: poolAddress,
        claim_txs: claimTxHashes,
        close_txs: closeTxHashes,
        txs: txHashes,
      };
    }

    recordClose(position_address, reason || "agent decision");

    // Record performance for learning
    if (tracked) {
      const deployedAt = new Date(tracked.deployed_at).getTime();
      const minutesHeld = Math.floor((Date.now() - deployedAt) / 60000);

      let minutesOOR = 0;
      if (tracked.out_of_range_since) {
        minutesOOR = Math.floor((Date.now() - new Date(tracked.out_of_range_since).getTime()) / 60000);
      }

      const shouldRejectClosedPnl = (pct, closeReasonText) => {
        if (!Number.isFinite(pct)) return false;
        const reasonText = String(closeReasonText || "").toLowerCase();
        const stopLossTriggered = reasonText.includes("stop loss");
        // Meteora sometimes briefly reports absurd closed pnl while the record is settling.
        // Trust legitimate stop-loss disasters, but reject obviously unsettled outliers otherwise.
        return !stopLossTriggered && pct <= -90;
      };

      // Fetch closed PnL from API — authoritative source after withdrawal settles
      let pnlUsd = 0;
      let pnlTrueUsd = 0;
      let pnlPct = 0;
      let finalValueUsd = 0;
      let initialUsd = 0;
      let feesUsd = tracked.total_fees_claimed_usd || 0;
      let dualRawPnlSol = null;
      let dualDepositsSol = null;
      let dualFeeIncomeSol = null;
      try {
        const closedUrl = `https://dlmm.datapi.meteora.ag/positions/${poolAddress}/pnl?user=${wallet.publicKey.toString()}&status=closed&pageSize=50&page=1`;
        for (let attempt = 0; attempt < 6; attempt++) {
          const res = await fetch(closedUrl);
          if (res.ok) {
            const data = await res.json();
            const posEntry = (data.positions || []).find(p => p.positionAddress === position_address);
            if (posEntry) {
              const nextPnlUsd = safeNum(posEntry.pnlUsd);
              const nextPnlValue = config.management.solMode ? getClosedPnlValue(posEntry, true) : nextPnlUsd;
              const nextPnlPct = getClosedPnlPct(posEntry, config.management.solMode);
              const nextFinalValueUsd = parseFloat(posEntry.allTimeWithdrawals?.total?.usd || 0);
              const nextInitialUsd = parseFloat(posEntry.allTimeDeposits?.total?.usd || 0);
              const nextFeesUsd = parseFloat(posEntry.allTimeFees?.total?.usd || 0) || feesUsd;
              dualRawPnlSol = maybeNum(posEntry.pnlSol);
              dualDepositsSol = maybeNum(posEntry.allTimeDeposits?.total?.sol);
              dualFeeIncomeSol = safeNum(posEntry.allTimeFees?.total?.sol);

              if (shouldRejectClosedPnl(nextPnlPct, reason || tracked?.close_reason)) {
                log("close_warn", `Rejected unsettled closed PnL for ${position_address.slice(0, 8)} on attempt ${attempt + 1}/6: ${nextPnlPct.toFixed(2)}%`);
              } else {
                pnlTrueUsd    = nextPnlUsd;
                pnlUsd        = nextPnlValue;
                pnlPct        = nextPnlPct;
                finalValueUsd = nextFinalValueUsd;
                initialUsd    = nextInitialUsd;
                feesUsd       = nextFeesUsd;
                log("close", `Closed PnL from API: pnl=${pnlUsd.toFixed(2)} ${config.management.solMode ? "SOL" : "USD"} (${pnlPct.toFixed(2)}%), withdrawn=${finalValueUsd.toFixed(2)} USD, deposited=${initialUsd.toFixed(2)} USD`);
                break;
              }
            } else {
              log("close_warn", `Position not found in status=closed response (attempt ${attempt + 1}/6) — may still be settling`);
            }
          }
          if (attempt < 5) await new Promise((r) => setTimeout(r, 5000));
        }
      } catch (e) {
        log("close_warn", `Closed PnL fetch failed: ${e.message}`);
      }
      // Fallback to pre-close cache snapshot if closed API had no data
      if (finalValueUsd === 0) {
        const cachedPos = _positionsCache?.positions?.find(p => p.position === position_address);
        if (cachedPos) {
          dualRawPnlSol = maybeNum(cachedPos.raw_pnl_sol);
          dualDepositsSol = maybeNum(cachedPos.deposits_sol);
          dualFeeIncomeSol = maybeNum(cachedPos.dual_fee_income_sol);
          pnlTrueUsd    = cachedPos.pnl_true_usd ?? (config.management.solMode ? 0 : cachedPos.pnl_usd) ?? 0;
          pnlUsd        = config.management.solMode ? (cachedPos.pnl_usd ?? 0) : pnlTrueUsd;
          pnlPct        = cachedPos.pnl_pct   ?? 0;
          feesUsd       = (cachedPos.collected_fees_true_usd || 0) + (cachedPos.unclaimed_fees_true_usd || 0);
          initialUsd    = tracked.initial_value_usd || 0;
          if (initialUsd > 0) {
            // Keep fallback internally consistent using USD-only cached metrics.
            finalValueUsd = Math.max(0, initialUsd + pnlTrueUsd - feesUsd);
            if (!config.management.solMode) pnlPct = (pnlTrueUsd / initialUsd) * 100;
          } else {
            finalValueUsd = cachedPos.total_value_true_usd ?? cachedPos.total_value_usd ?? 0;
            initialUsd = Math.max(0, finalValueUsd + feesUsd - pnlTrueUsd);
          }
          log("close_warn", `Using cached pnl fallback because closed API has not settled yet`);
        }
      }

      const closeBaseMint = pool.lbPair.tokenXMint.toString();
      const signalSnapshot = resolvePerformanceSignalSnapshot({
        poolAddress,
        baseMint: closeBaseMint,
        tracked,
      });

      let exitMarket = {};
      try {
        const exitDetail = await fetch(`https://pool-discovery-api.datapi.meteora.ag/pools?page_size=1&filter_by=${encodeURIComponent(`pool_address=${poolAddress}`)}&timeframe=${encodeURIComponent(config.screening?.timeframe || "5m")}`).then(r => r.json()).catch(() => null);
        const ep = exitDetail?.data?.[0];
        if (ep) {
          exitMarket = {
            exit_mcap: parseFloat(ep?.token_x?.market_cap) || null,
            exit_tvl: parseFloat(ep?.tvl ?? ep?.active_tvl) || null,
            exit_volume: parseFloat(ep?.volume) || null,
          };
        }
      } catch { /* non-blocking */ }

      await recordPerformance({
        position: position_address,
        pool: poolAddress,
        pool_name: tracked.pool_name || poolMeta.name || poolAddress.slice(0, 8),
        base_mint: closeBaseMint,
        strategy: tracked.strategy,
        bin_range: tracked.bin_range,
        bin_step: tracked.bin_step || null,
        volatility: tracked.volatility ?? null,
        fee_tvl_ratio: tracked.fee_tvl_ratio || null,
        organic_score: tracked.organic_score || null,
        amount_sol: tracked.amount_sol,
        fees_earned_usd: feesUsd,
        final_value_usd: finalValueUsd,
        initial_value_usd: initialUsd,
        minutes_in_range: minutesHeld - minutesOOR,
        minutes_held: minutesHeld,
        close_reason: reason || "agent decision",
        signal_snapshot: signalSnapshot,
        entry_mcap: tracked.entry_mcap ?? null,
        entry_tvl: tracked.entry_tvl ?? null,
        entry_volume: tracked.entry_volume ?? null,
        entry_holders: tracked.entry_holders ?? null,
        ...exitMarket,
      });

      appendDecision({
        type: "close",
        actor: "MANAGER",
        pool: poolAddress,
        pool_name: tracked.pool_name || poolMeta.name || poolAddress.slice(0, 8),
        position: position_address,
        summary: `Closed at ${pnlPct.toFixed(2)}%`,
        reason: reason || "agent decision",
        risks: [
          minutesOOR > 0 ? `out of range ${minutesOOR}m` : null,
          tracked.volatility != null ? `volatility ${tracked.volatility}` : null,
        ].filter(Boolean),
        metrics: {
          pnl_usd: pnlUsd,
          pnl_pct: pnlPct,
          fees_usd: feesUsd,
          minutes_held: minutesHeld,
        },
      });

      return await withDualCloseAssets({
        success: true,
        position: position_address,
        pool: poolAddress,
        pool_name: tracked.pool_name || poolMeta.name || null,
        claim_txs: claimTxHashes,
        close_txs: closeTxHashes,
        txs: txHashes,
        pnl_usd: pnlUsd,
        pnl_pct: pnlPct,
        base_mint: closeBaseMint,
        dual_raw_pnl_sol: dualRawPnlSol,
        dual_deposits_sol: dualDepositsSol,
        dual_fee_income_sol: dualFeeIncomeSol,
      });
    }

    appendDecision({
      type: "close",
      actor: "MANAGER",
      pool: poolAddress,
      pool_name: poolMeta.name || poolAddress.slice(0, 8),
      position: position_address,
      summary: "Closed position",
      reason: reason || "agent decision",
      metrics: {},
    });

    return await withDualCloseAssets({
      success: true,
      position: position_address,
      pool: poolAddress,
      pool_name: poolMeta.name || null,
      claim_txs: claimTxHashes,
      close_txs: closeTxHashes,
      txs: txHashes,
      base_mint: pool.lbPair.tokenXMint.toString(),
    });
  } catch (error) {
    log("close_error", error.message);
    return { success: false, error: error.message };
  }
}

// ─── Helpers ──────────────────────────────────────────────────
async function lookupPoolForPosition(position_address, walletAddress) {
  // Check state registry first (fast path)
  const tracked = getTrackedPosition(position_address);
  if (tracked?.pool) return tracked.pool;

  // Check in-memory positions cache
  const cached = _positionsCache?.positions?.find((p) => p.position === position_address);
  if (cached?.pool) return cached.pool;

  // SDK scan (last resort)
  const { DLMM } = await getDLMM();
  const allPositions = await DLMM.getAllLbPairPositionsByUser(
    getConnection(),
    new PublicKey(walletAddress)
  );

  for (const [lbPairKey, positionData] of Object.entries(allPositions)) {
    for (const pos of positionData.lbPairPositionsData || []) {
      if (pos.publicKey.toString() === position_address) return lbPairKey;
    }
  }

  throw new Error(`Position ${position_address} not found in open positions`);
}

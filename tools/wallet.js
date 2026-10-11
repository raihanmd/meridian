import {
  Connection,
  PublicKey,
  LAMPORTS_PER_SOL,
  VersionedTransaction,
  Keypair,
} from "@solana/web3.js";
import bs58 from "bs58";
import { log } from "../logger.js";
import { config } from "../config.js";

let _connection = null;
let _wallet = null;

function getConnection() {
  if (!_connection) _connection = new Connection(process.env.RPC_URL, "confirmed");
  return _connection;
}

function getWallet() {
  if (!_wallet) {
    if (!process.env.WALLET_PRIVATE_KEY) throw new Error("WALLET_PRIVATE_KEY not set");
    _wallet = Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY));
  }
  return _wallet;
}

const JUPITER_PRICE_API = "https://api.jup.ag/price/v3";
const JUPITER_SWAP_V2_API = "https://api.jup.ag/swap/v2";
const DEFAULT_JUPITER_API_KEY = "b15d42e9-e0e4-4f90-a424-ae41ceeaa382";

function getJupiterApiKey() {
  return config.jupiter.apiKey || process.env.JUPITER_API_KEY || DEFAULT_JUPITER_API_KEY;
}

function getJupiterReferralParams() {
  const referralAccount = String(config.jupiter.referralAccount || "").trim();
  const referralFee = Number(config.jupiter.referralFeeBps || 0);
  if (!referralAccount || !Number.isFinite(referralFee) || referralFee <= 0) {
    return null;
  }
  if (referralFee < 50 || referralFee > 255) {
    log("swap_warn", `Ignoring Jupiter referral fee ${referralFee}; Ultra requires 50-255 bps`);
    return null;
  }
  try {
    new PublicKey(referralAccount);
  } catch {
    log("swap_warn", "Ignoring invalid Jupiter referral account");
    return null;
  }
  return { referralAccount, referralFee: Math.round(referralFee) };
}

export async function quoteSolSwap({ output_mint, amount_sol }) {
  output_mint = normalizeMint(output_mint);
  const amount = Number(amount_sol);
  if (!output_mint || output_mint === config.tokens.SOL || !Number.isFinite(amount) || amount <= 0) {
    throw new Error("SOL swap quote needs a non-SOL output mint and positive SOL amount");
  }
  const wallet = getWallet();
  const search = new URLSearchParams({
    inputMint: config.tokens.SOL,
    outputMint: output_mint,
    amount: String(Math.floor(amount * 1e9)),
    taker: wallet.publicKey.toString(),
  });
  if (config.strategy.dualToken.enabled) search.set("slippageBps", String(config.strategy.dualToken.maxSlippageBps));
  const referral = getJupiterReferralParams();
  if (referral) {
    search.set("referralAccount", referral.referralAccount);
    search.set("referralFee", String(referral.referralFee));
  }
  const key = getJupiterApiKey();
  const response = await fetch(`${JUPITER_SWAP_V2_API}/order?${search}`, {
    headers: key ? { "x-api-key": key } : {},
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Jupiter route quote failed: ${response.status}`);
  const order = await response.json();
  if (order.errorCode || order.errorMessage || !order.transaction || !order.requestId) {
    throw new Error(`No executable SOL route for ${output_mint}: ${order.errorMessage || order.errorCode || "missing transaction"}`);
  }
  if (!/^\d+$/.test(String(order.outAmount || "")) || BigInt(order.outAmount) <= 0n) {
    throw new Error(`Jupiter returned an invalid output quote for ${output_mint}`);
  }
  return {
    input_mint: config.tokens.SOL,
    output_mint,
    in_amount: String(order.inAmount),
    out_amount: String(order.outAmount),
    min_out_amount: String(order.otherAmountThreshold ?? order.outAmount),
    fee_bps: order.feeBps ?? null,
    fee_mint: order.feeMint ?? null,
    price_impact_pct: Number(order.priceImpactPct ?? 0) * 100,
    request_id: order.requestId,
  };
}

export async function resumeJupiterSwap({ signedTransaction, requestId, onExecutionReported }) {
  if (!signedTransaction || !requestId) throw new Error("Cannot resume Jupiter swap without the exact signed transaction and request ID");
  const key = getJupiterApiKey();
  const response = await fetch(`${JUPITER_SWAP_V2_API}/execute`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(key ? { "x-api-key": key } : {}) },
    body: JSON.stringify({ signedTransaction, requestId }),
    signal: AbortSignal.timeout(20_000),
  });
  const result = await response.json().catch(() => ({}));
  await onExecutionReported?.({
    signature: result.signature ?? null,
    status: result.status ?? null,
    code: result.code ?? null,
    inputAmountResult: result.inputAmountResult ?? null,
    outputAmountResult: result.outputAmountResult ?? null,
    requestId,
  });
  if (!response.ok || result.status === "Failed") {
    throw new Error(`Jupiter resumed swap failed: ${result.error || result.code || response.status}`);
  }
  if (!result.signature) throw new Error("Jupiter resumed swap returned no transaction signature");
  return {
    success: true,
    tx: result.signature,
    amount_in: result.inputAmountResult,
    amount_out: result.outputAmountResult,
    status: result.status,
  };
}

/**
 * Get current wallet balances: SOL, USDC, and all SPL tokens using Helius Wallet API.
 * Returns USD-denominated values provided by Helius.
 */
export async function getWalletBalances() {
  let walletAddress;
  try {
    walletAddress = getWallet().publicKey.toString();
  } catch {
    return { wallet: null, sol: 0, sol_price: 0, sol_usd: 0, usdc: 0, tokens: [], total_usd: 0, error: "Wallet not configured" };
  }

  const HELIUS_KEY = process.env.HELIUS_API_KEY;
  if (!HELIUS_KEY) {
    log("wallet_error", "HELIUS_API_KEY not set in .env");
    return { wallet: walletAddress, sol: 0, sol_price: 0, sol_usd: 0, usdc: 0, tokens: [], total_usd: 0, error: "Helius API key missing" };
  }

  try {
    const url = `https://api.helius.xyz/v1/wallet/${walletAddress}/balances?api-key=${HELIUS_KEY}`;
    const res = await fetch(url);
    
    if (!res.ok) {
      throw new Error(`Helius API error: ${res.status} ${res.statusText}`);
    }

    const data = await res.json();
    const balances = data.balances || [];

    // ─── Find SOL and USDC ────────────────────────────────────
    const solEntry = balances.find(b => b.mint === config.tokens.SOL || b.symbol === "SOL");
    const usdcEntry = balances.find(b => b.mint === config.tokens.USDC || b.symbol === "USDC");

    const solBalance = solEntry?.balance || 0;
    const solPrice = solEntry?.pricePerToken || 0;
    const solUsd = solEntry?.usdValue || 0;
    const usdcBalance = usdcEntry?.balance || 0;

    // ─── Map all tokens ───────────────────────────────────────
    const enrichedTokens = balances.map(b => ({
      mint: b.mint,
      symbol: b.symbol || b.mint.slice(0, 8),
      balance: b.balance,
      usd: b.usdValue ? Math.round(b.usdValue * 100) / 100 : null,
    }));

    return {
      wallet: walletAddress,
      sol: Math.round(solBalance * 1e6) / 1e6,
      sol_price: Math.round(solPrice * 100) / 100,
      sol_usd: Math.round(solUsd * 100) / 100,
      usdc: Math.round(usdcBalance * 100) / 100,
      tokens: enrichedTokens,
      total_usd: Math.round((data.totalUsdValue || 0) * 100) / 100,
    };
  } catch (error) {
    log("wallet_error", error.message);
    return {
      wallet: walletAddress,
      sol: 0,
      sol_price: 0,
      sol_usd: 0,
      usdc: 0,
      tokens: [],
      total_usd: 0,
      error: error.message,
    };
  }
}

/**
 * Swap tokens via Jupiter Swap API V2 (order → sign → execute).
 */
const SOL_MINT = "So11111111111111111111111111111111111111112";

// Normalize any SOL-like address to the correct wrapped SOL mint
export function normalizeMint(mint) {
  if (!mint) return mint;
  const SOL_MINT = "So11111111111111111111111111111111111111112";
  if (
    mint === "SOL" || 
    mint === "native" || 
    /^So1+$/.test(mint) || 
    (mint.length >= 32 && mint.length <= 44 && mint.startsWith("So1") && mint !== SOL_MINT)
  ) {
    return SOL_MINT;
  }
  return mint;
}

export async function swapToken({
  input_mint,
  output_mint,
  amount,
  amount_raw,
  input_decimals,
  slippage_bps,
  onPrepared,
  onSubmitted,
  onExecutionReported,
  onConfirmed,
}) {
  input_mint  = normalizeMint(input_mint);
  output_mint = normalizeMint(output_mint);

  if (process.env.DRY_RUN === "true") {
    return {
      dry_run: true,
      would_swap: { input_mint, output_mint, amount, amount_raw },
      message: "DRY RUN — no transaction sent",
    };
  }

  try {
    log("swap", `${amount} of ${input_mint} → ${output_mint}`);
    const wallet = getWallet();
    const connection = getConnection();

    // ─── Convert to smallest unit ──────────────────────────────
    let decimals = Number.isInteger(input_decimals) ? input_decimals : 9; // SOL default
    if (amount_raw == null && input_mint !== config.tokens.SOL) {
      const mintInfo = await connection.getParsedAccountInfo(new PublicKey(input_mint));
      decimals = mintInfo.value?.data?.parsed?.info?.decimals ?? 9;
    }
    const amountStr = amount_raw == null
      ? String(Math.floor(Number(amount) * Math.pow(10, decimals)))
      : String(amount_raw);
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18 || !/^\d+$/.test(amountStr) || BigInt(amountStr) <= 0n) {
      throw new Error("Swap input amount or token decimals are invalid");
    }

    // ─── Get Swap V2 order (unsigned tx + requestId) ───────────
    const search = new URLSearchParams({
      inputMint: input_mint,
      outputMint: output_mint,
      amount: amountStr,
      taker: wallet.publicKey.toString(),
    });
    const requestedSlippageBps = Number.isInteger(slippage_bps)
      ? slippage_bps
      : config.strategy.dualToken.enabled ? config.strategy.dualToken.maxSlippageBps : null;
    if (requestedSlippageBps != null) search.set("slippageBps", String(requestedSlippageBps));
    const referralParams = getJupiterReferralParams();
    if (referralParams) {
      search.set("referralAccount", referralParams.referralAccount);
      search.set("referralFee", String(referralParams.referralFee));
    }
    const orderUrl = `${JUPITER_SWAP_V2_API}/order?${search.toString()}`;
    const jupiterApiKey = getJupiterApiKey();

    const orderRes = await fetch(orderUrl, {
      headers: jupiterApiKey ? { "x-api-key": jupiterApiKey } : {},
    });
    if (!orderRes.ok) {
      const body = await orderRes.text();
      throw new Error(`Swap V2 order failed: ${orderRes.status} ${body}`);
    }

    const order = await orderRes.json();
    if (order.errorCode || order.errorMessage) {
      throw new Error(`Swap V2 order error: ${order.errorMessage || order.errorCode}`);
    }

    const { transaction: unsignedTx, requestId } = order;

    // ─── Deserialize and sign ─────────────────────────────────
    const tx = VersionedTransaction.deserialize(Buffer.from(unsignedTx, "base64"));
    tx.sign([wallet]);
    const signedTx = Buffer.from(tx.serialize()).toString("base64");
    const signature = bs58.encode(tx.signatures[0]);
    await onPrepared?.({
      signature,
      signedTransaction: signedTx,
      requestId,
      lastValidBlockHeight: order.lastValidBlockHeight ?? null,
      input_mint,
      output_mint,
      amount_in: order.inAmount ?? amountStr,
      amount_out: order.outAmount ?? null,
      min_amount_out: order.otherAmountThreshold ?? order.outAmount ?? null,
      price_impact_pct: Number(order.priceImpactPct ?? 0),
      fee_bps: order.feeBps ?? null,
      fee_mint: order.feeMint ?? null,
    });
    await onSubmitted?.({ signature, requestId });

    // ─── Execute ───────────────────────────────────────────────
    const execRes = await fetch(`${JUPITER_SWAP_V2_API}/execute`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(jupiterApiKey ? { "x-api-key": jupiterApiKey } : {}),
      },
      body: JSON.stringify({ signedTransaction: signedTx, requestId }),
    });
    if (!execRes.ok) {
      throw new Error(`Swap V2 execute failed: ${execRes.status} ${await execRes.text()}`);
    }

    const result = await execRes.json();
    await onExecutionReported?.({
      signature: result.signature ?? null,
      status: result.status ?? null,
      code: result.code ?? null,
      inputAmountResult: result.inputAmountResult ?? null,
      outputAmountResult: result.outputAmountResult ?? null,
      requestId,
    });
    if (result.status === "Failed") {
      throw new Error(`Swap failed on-chain: code=${result.code}`);
    }

    log("swap", `SUCCESS tx: ${result.signature}`);
    if (referralParams && order.feeBps !== referralParams.referralFee) {
      log(
        "swap_warn",
        `Jupiter referral fee requested ${referralParams.referralFee} bps but order applied ${order.feeBps ?? "unknown"} bps`,
      );
    }

    const confirmed = {
      success: true,
      tx: result.signature,
      input_mint,
      output_mint,
      amount_in: result.inputAmountResult,
      amount_out: result.outputAmountResult,
      referral_account: referralParams?.referralAccount || null,
      referral_fee_bps_requested: referralParams?.referralFee || 0,
      fee_bps_applied: order.feeBps ?? null,
      fee_mint: order.feeMint ?? null,
    };
    await onConfirmed?.({ ...confirmed, signature: result.signature });
    return confirmed;
  } catch (error) {
    log("swap_error", error.message);
    return { success: false, error: error.message };
  }
}

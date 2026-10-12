import { Connection, PublicKey } from "@solana/web3.js";
import { config } from "../config.js";
import { log } from "../logger.js";
import { computeDualPnl } from "./dual-deploy.js";
import {
  getTrackedPosition,
  markOutOfRange,
  markInRange,
  minutesOutOfRange,
} from "../state.js";

// ─── Public-infra PnL engine ───────────────────────────────────
// Live position value (current liquidity + claimable fees) is read ON-CHAIN
// via the Meteora DLMM SDK on a public RPC (pump.helius). Deposit history
// (cost basis, withdrawals, claimed fees) comes ONLY from the Meteora /pnl
// API — its precomputed live pnl/balances are intentionally ignored. Token
// USD prices come from Jupiter. No LPAgent / agentmeridian dependency, so the
// poller can run aggressively on fully public resources.

const JUP_SEARCH = "https://datapi.jup.ag/v1/assets/search";
const METEORA_PNL = "https://dlmm.datapi.meteora.ag/positions";

// Lazy SDK load — mirrors tools/dlmm.js (CJS dir-imports break in ESM at import time).
let _DLMM = null;
async function loadDlmmSdk() {
  if (!_DLMM) {
    const mod = await import("@meteora-ag/dlmm");
    _DLMM = mod.default;
  }
  return _DLMM;
}

let _pnlConnection = null;
export function getPnlConnection() {
  if (!_pnlConnection) {
    _pnlConnection = new Connection(config.pnl.rpcUrl, "confirmed");
  }
  return _pnlConnection;
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
function round(value, decimals = 4) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}
function unique(arr) {
  return [...new Set(arr.filter(Boolean))];
}

// ─── Meteora /pnl per pool (deposit history) ────────────────────
// Exported because tools/dlmm.js (getPositionPnl + the Meteora fallback path)
// also reads it.
export async function fetchDlmmPnlForPool(poolAddress, walletAddress) {
  const url = `${METEORA_PNL}/${poolAddress}/pnl?user=${walletAddress}&status=open&pageSize=100&page=1`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      log("pnl_api", `HTTP ${res.status} for pool ${poolAddress.slice(0, 8)}: ${body.slice(0, 120)}`);
      return {};
    }
    const data = await res.json();
    const positions = data.positions || data.data || [];
    const byAddress = {};
    for (const p of positions) {
      const addr = p.positionAddress || p.address || p.position;
      if (addr) byAddress[addr] = p;
    }
    return byAddress;
  } catch (e) {
    log("pnl_api", `Fetch error for pool ${poolAddress.slice(0, 8)}: ${e.message}`);
    return {};
  }
}

// ─── Jupiter prices (never cached) ──────────────────────────────
async function getJupiterPrices(mints) {
  const list = unique(mints.map((m) => String(m).trim()));
  if (!list.length) return {};
  try {
    const res = await fetch(`${JUP_SEARCH}?query=${list.join(",")}`, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`Jupiter ${res.status}`);
    const assets = await res.json();
    const out = {};
    for (const a of assets) out[a.id] = maybeNum(a.usdPrice);
    return out;
  } catch (e) {
    log("pnl_price", `Jupiter price fetch failed: ${e.message}`);
    return {};
  }
}

export async function getSolUsdPrice() {
  const prices = await getJupiterPrices([config.tokens.SOL]);
  return prices[config.tokens.SOL] ?? null;
}

// ─── Deposit-history cache (sig-invalidated + TTL) ──────────────
// Deposits/withdrawals/claimed fees change only on a position tx; feePerTvl24h
// is a slow 24h pool stat. Cache per pool, refetch when any position's latest
// signature changes or the TTL lapses.
const _meteoraCache = new Map(); // pool -> { at, byPosition, sigByPosition }
let _pollCount = 0;

async function getLatestSig(conn, addr) {
  try {
    const sigs = await conn.getSignaturesForAddress(new PublicKey(addr), { limit: 1 });
    return sigs?.[0]?.signature ?? null;
  } catch {
    return null;
  }
}

async function getMeteoraData(conn, walletAddress, flat) {
  const ttlMs = Math.max(0, Number(config.pnl.depositCacheTtlSec ?? 300)) * 1000;
  const positionsByPool = new Map();
  for (const f of flat) {
    if (!positionsByPool.has(f.pool)) positionsByPool.set(f.pool, []);
    positionsByPool.get(f.pool).push(f.position);
  }

  const byPosition = {};
  await Promise.all([...positionsByPool.entries()].map(async ([pool, positionAddrs]) => {
    const cached = _meteoraCache.get(pool);
    const sigByPosition = {};
    await Promise.all(positionAddrs.map(async (addr) => { sigByPosition[addr] = await getLatestSig(conn, addr); }));

    const ageOk = cached && Date.now() - cached.at < ttlMs;
    const sigsMatch = cached && positionAddrs.every((a) => cached.sigByPosition?.[a] === sigByPosition[a]);

    let data;
    if (ageOk && sigsMatch) {
      data = cached.byPosition;
    } else {
      data = await fetchDlmmPnlForPool(pool, walletAddress);
      _meteoraCache.set(pool, { at: Date.now(), byPosition: data, sigByPosition });
    }
    for (const addr of positionAddrs) byPosition[addr] = data[addr] || null;
  }));

  return byPosition;
}

function mapEntries(map) {
  return map instanceof Map ? [...map.entries()] : Object.entries(map || {});
}

export function valuePoolTokens({ xRaw, yRaw, decX, decY, priceX, priceY, solUsd }) {
  const xHuman = safeNum(xRaw) / 10 ** decX;
  const yHuman = safeNum(yRaw) / 10 ** decY;
  if ((xHuman > 0 && !(priceX > 0)) || (yHuman > 0 && !(priceY > 0))) {
    return { usd: null, sol: null, xHuman, yHuman };
  }
  const usd = (xHuman > 0 ? xHuman * priceX : 0) + (yHuman > 0 ? yHuman * priceY : 0);
  return { usd, sol: solUsd > 0 ? usd / solUsd : null, xHuman, yHuman };
}

// ─── Build the shaped position object (matches getMyPositions output) ──
function buildPosition(f, prices, solUsd, meteora, solMode, positionRentSol) {
  const tracked = getTrackedPosition(f.position);
  const priceX = f.baseMint ? prices[f.baseMint] : null;
  const priceY = f.quoteMint ? prices[f.quoteMint] : null;

  const balances = valuePoolTokens({ xRaw: f.xRaw, yRaw: f.yRaw, decX: f.decX, decY: f.decY, priceX, priceY, solUsd });
  const { xHuman, yHuman } = balances;
  const balancesUsd = balances.usd;
  const balancesSol = balances.sol;

  const fees = valuePoolTokens({ xRaw: f.feeXRaw, yRaw: f.feeYRaw, decX: f.decX, decY: f.decY, priceX, priceY, solUsd });
  const { xHuman: feeXHuman, yHuman: feeYHuman } = fees;
  const claimableUsd = fees.usd;
  const claimableSol = fees.sol;
  const priceMissing = !(solUsd > 0) || balancesUsd == null || claimableUsd == null;

  const depositsUsd = safeNum(meteora?.allTimeDeposits?.total?.usd);
  const depositsSol = safeNum(meteora?.allTimeDeposits?.total?.sol);
  const withdrawUsd = safeNum(meteora?.allTimeWithdrawals?.total?.usd);
  const withdrawSol = safeNum(meteora?.allTimeWithdrawals?.total?.sol);
  const claimedUsd = safeNum(meteora?.allTimeFees?.total?.usd);
  const claimedSol = safeNum(meteora?.allTimeFees?.total?.sol);

  const pnlUsd = balancesUsd + withdrawUsd + claimableUsd + claimedUsd - depositsUsd;
  const pnlSol = balancesSol + withdrawSol + claimableSol + claimedSol - depositsSol;
  const capitalPnlUsd = balancesUsd + withdrawUsd - depositsUsd;
  const capitalPnlSol = balancesSol + withdrawSol - depositsSol;
  const feeIncomeUsd = claimableUsd + claimedUsd;
  const feeIncomeSol = claimableSol + claimedSol;
  const pctUsd = depositsUsd > 0 ? (pnlUsd / depositsUsd) * 100 : 0;
  const pctSol = depositsSol > 0 ? (pnlSol / depositsSol) * 100 : 0;

  let dualPnl = null;
  const dualFeeAccountingAvailable = tracked?.dual_deploy?.transaction_fees_sol != null
    && tracked?.dual_deploy?.fee_accounting_complete !== false;
  const rentPaidSol = tracked?.dual_deploy?.position_rent_paid_sol ?? positionRentSol;
  if (!priceMissing && tracked?.dual_token && tracked.dual_deploy?.amount_sol > 0 && depositsSol > 0
    && dualFeeAccountingAvailable && positionRentSol != null && rentPaidSol != null) {
    try {
      dualPnl = computeDualPnl({
        rawPnlSol: pnlSol,
        depositsSol,
        budgetSol: tracked.dual_deploy.amount_sol,
        feeIncomeSol,
        transactionFeesSol: tracked.dual_deploy.transaction_fees_sol ?? 0,
        rentPaidSol,
        rentRecoveredSol: positionRentSol,
      });
    } catch (error) {
      log("pnl_warn", `Dual-token cost accounting unavailable for ${f.position.slice(0, 8)}: ${error.message}`);
    }
  }
  const ourPct = tracked?.dual_token ? dualPnl?.netPnlPct ?? null : priceMissing ? null : solMode ? pctSol : pctUsd;
  const netPnlUsd = dualPnl && solUsd > 0 ? dualPnl.netPnlSol * solUsd : null;

  // pnl_pct_diff is the gap vs Meteora's precomputed pct — kept ONLY as a logged
  // diagnostic. It is NOT used to gate exits: Meteora's pct comes from the
  // deposit cache (stale up to depositCacheTtlSec) while ourPct is fresh every
  // poll, so on a fast move the gap inflates and would falsely suppress
  // STOP_LOSS / TRAILING_TP exactly when they matter.
  const reportedPct = solMode ? maybeNum(meteora?.pnlSolPctChange) : maybeNum(meteora?.pnlPctChange);
  const pnlPctDiff = !tracked?.dual_token && ourPct != null && reportedPct != null ? Math.abs(ourPct - reportedPct) : null;

  // On-chain amounts are authoritative; a tick is "suspicious" (don't act on it)
  // only when we couldn't price it. Guards against:
  //  - Jupiter outage → solUsd/priceX missing → balances collapse → false STOP_LOSS
  //  - missing Meteora deposits → 0 cost basis → garbage pnl / inflated value
  const depositsMissing = tracked?.dual_token ? !dualPnl : (solMode ? depositsSol : depositsUsd) <= 0;
  const pnlPctSuspicious = priceMissing || depositsMissing;
  if (pnlPctSuspicious) {
    log("pnl_warn", `${f.position.slice(0, 8)} suspicious tick — priceMissing=${priceMissing} depositsMissing=${depositsMissing} (solUsd=${solUsd}, priceX=${priceX})`);
  }

  const inRange = f.active != null && f.lower != null && f.upper != null
    ? f.active >= f.lower && f.active <= f.upper
    : (meteora ? !meteora.isOutOfRange : true);

  if (inRange) markInRange(f.position);
  else markOutOfRange(f.position);

  const ageFromState = tracked?.deployed_at
    ? Math.floor((Date.now() - new Date(tracked.deployed_at).getTime()) / 60000)
    : null;
  const ageMinutes = meteora?.createdAt ? Math.floor((Date.now() - meteora.createdAt * 1000) / 60000) : ageFromState;

  return {
    position:           f.position,
    pool:               f.pool,
    pair:               tracked?.pool_name || (meteora ? `${meteora.tokenX ?? "?"}/${meteora.tokenY ?? "SOL"}` : "?/SOL"),
    base_mint:          f.baseMint,
    quote_mint:         f.quoteMint,
    lower_bin:          f.lower ?? tracked?.bin_range?.min ?? null,
    upper_bin:          f.upper ?? tracked?.bin_range?.max ?? null,
    active_bin:         f.active ?? tracked?.bin_range?.active ?? null,
    in_range:           inRange,
    unclaimed_fees_usd: round(solMode ? claimableSol : claimableUsd),
    unclaimed_fees_true_usd: round(claimableUsd),
    unclaimed_fee_x_raw: String(f.feeXRaw ?? "0"),
    unclaimed_fee_y_raw: String(f.feeYRaw ?? "0"),
    total_value_usd:    round(solMode ? balancesSol : balancesUsd),
    total_value_true_usd: round(balancesUsd),
    collected_fees_usd: round(solMode ? claimedSol : claimedUsd),
    collected_fees_true_usd: round(claimedUsd),
    pnl_usd:            tracked?.dual_token ? (solMode ? dualPnl?.netPnlSol ?? null : netPnlUsd == null ? null : round(netPnlUsd)) : round(solMode ? pnlSol : pnlUsd),
    pnl_true_usd:       tracked?.dual_token ? (netPnlUsd == null ? null : round(netPnlUsd)) : round(pnlUsd),
    pnl_sol_net:        dualPnl ? round(dualPnl.netPnlSol) : null,
    raw_pnl_sol:        round(pnlSol),
    deposits_sol:       round(depositsSol),
    dual_fee_income_sol: round(feeIncomeSol),
    capital_pnl_sol_net: dualPnl ? round(dualPnl.capitalPnlSol) : null,
    dual_transaction_fees_sol: dualPnl ? round(dualPnl.executionFeesSol) : null,
    dual_rent_paid_sol: dualPnl ? round(dualPnl.rentPaidSol) : null,
    dual_rent_recovered_sol: dualPnl ? round(dualPnl.rentRecoveredSol) : null,
    fee_income_sol:     round(feeIncomeSol),
    fee_income_usd:     round(feeIncomeUsd),
    pnl_includes_capital_gain: true,
    capital_pnl_sol:    round(capitalPnlSol),
    capital_pnl_usd:    round(capitalPnlUsd),
    pnl_pct:            ourPct == null ? null : round(ourPct, 2),
    pnl_pct_derived:    ourPct == null ? null : round(ourPct, 2),
    pnl_pct_diff:       pnlPctDiff != null ? round(pnlPctDiff, 2) : null,
    pnl_pct_suspicious: !!pnlPctSuspicious,
    fee_per_tvl_24h:    meteora ? Math.round(safeNum(meteora.feePerTvl24h) * 100) / 100 : null,
    age_minutes:        ageMinutes,
    minutes_out_of_range: minutesOutOfRange(f.position),
    instruction:        tracked?.instruction ?? null,
  };
}

// ─── Main entry: compute positions from public infra ────────────
// Returns the same shape as getMyPositions, or throws so the caller can
// fall back to the Meteora-API path.
export async function computePositions(walletAddress) {
  const solMode = !!config.management?.solMode;
  const SOL_MINT = config.tokens.SOL;
  const conn = getPnlConnection();
  const DLMM = await loadDlmmSdk();

  const map = await DLMM.getAllLbPairPositionsByUser(conn, new PublicKey(walletAddress));
  _pollCount++;
  if (_pollCount % 20 === 1) {
    const n = [...mapEntries(map)].reduce((s, [, i]) => s + (i?.lbPairPositionsData?.length ?? 0), 0);
    log("pnl_tick", `poller alive — ${n} position(s) tracked (tick #${_pollCount})`);
  }

  const flat = [];
  for (const [lbPairKey, info] of mapEntries(map)) {
    const decX = info?.tokenX?.mint?.decimals ?? 9;
    const decY = info?.tokenY?.mint?.decimals ?? 9;
    const baseMint = info?.tokenX?.mint?.address?.toString?.() ?? null;
    const quoteMint = info?.tokenY?.mint?.address?.toString?.() ?? null;
    const active = info?.lbPair?.activeId ?? null;
    for (const p of info?.lbPairPositionsData || []) {
      const d = p.positionData || {};
      flat.push({
        position: p.publicKey.toString(),
        pool: lbPairKey,
        baseMint,
        quoteMint,
        decX,
        decY,
        active,
        lower: d.lowerBinId ?? null,
        upper: d.upperBinId ?? null,
        xRaw: d.totalXAmount,
        yRaw: d.totalYAmount,
        feeXRaw: d.feeX?.toString?.() ?? d.feeX ?? 0,
        feeYRaw: d.feeY?.toString?.() ?? d.feeY ?? 0,
      });
    }
  }

  if (flat.length === 0) {
    return { wallet: walletAddress, total_positions: 0, positions: [], source: "rpc" };
  }

  const [prices, meteoraByPosition, rentByPosition] = await Promise.all([
    getJupiterPrices([SOL_MINT, ...flat.flatMap((f) => [f.baseMint, f.quoteMint])]),
    getMeteoraData(conn, walletAddress, flat),
    Promise.all(flat.map(async (f) => {
      const account = await conn.getAccountInfo(new PublicKey(f.position), "confirmed").catch(() => null);
      return [f.position, account?.lamports != null ? account.lamports / 1e9 : null];
    })).then((entries) => new Map(entries)),
  ]);
  const solUsd = prices[SOL_MINT] ?? null;

  const positions = flat.map((f) => buildPosition(f, prices, solUsd, meteoraByPosition[f.position], solMode, rentByPosition.get(f.position)));

  return { wallet: walletAddress, total_positions: positions.length, positions, source: "rpc" };
}

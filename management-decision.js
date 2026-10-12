import { log } from "./logger.js";

export function isLowYieldEligible(position, managementConfig) {
  const minAge = managementConfig.minAgeBeforeYieldCheck ?? 60;
  return position.fee_per_tvl_24h != null
    && managementConfig.minFeePerTvl24h != null
    && position.age_minutes != null
    && position.age_minutes >= minAge
    && position.fee_per_tvl_24h < managementConfig.minFeePerTvl24h;
}

export function canHoldAboveTakeProfit(position, managementConfig, tracked = null) {
  if (managementConfig.holdAtTakeProfitWithFees === false || !managementConfig.trailingTakeProfit
    || tracked?.trailing_active !== true || position.in_range !== true
    || position.pnl_pct_suspicious || !Number.isFinite(position.pnl_pct)
    || !Number.isFinite(position.fee_per_tvl_24h)
    || !Number.isFinite(managementConfig.minFeePerTvl24h)
    || position.fee_per_tvl_24h < managementConfig.minFeePerTvl24h) return false;
  const feeX = position.unclaimed_fee_x_raw;
  const feeY = position.unclaimed_fee_y_raw;
  if (!/^\d+$/.test(String(feeX ?? "")) || !/^\d+$/.test(String(feeY ?? ""))) return false;
  return BigInt(feeX) > 0n || BigInt(feeY) > 0n;
}

function validPnl(position, tracked) {
  if (position.pnl_pct_suspicious || position.pnl_pct == null) return null;
  if (position.pnl_pct <= -90 && tracked?.amount_sol && (position.total_value_usd ?? 0) > 0.01) {
    log("cron_warn", `Suspect PnL for ${position.pair}: ${position.pnl_pct}% but position still has value — skipping PnL rules`);
    return null;
  }
  return position.pnl_pct;
}

export function getDeterministicCloseRule(position, managementConfig, tracked = null) {
  const pnl = validPnl(position, tracked);
  if (pnl != null && pnl <= managementConfig.stopLossPct) {
    return { action: "CLOSE", rule: 1, reason: "stop loss" };
  }
  if (pnl != null && pnl >= managementConfig.takeProfitPct
    && !canHoldAboveTakeProfit(position, managementConfig, tracked)) {
    return { action: "CLOSE", rule: 2, reason: "take profit" };
  }
  if (position.active_bin != null && position.upper_bin != null
    && position.active_bin > position.upper_bin + managementConfig.outOfRangeBinsToClose) {
    return { action: "CLOSE", rule: 3, reason: "pumped far above range" };
  }
  if (position.active_bin != null && position.upper_bin != null
    && position.active_bin > position.upper_bin
    && (position.minutes_out_of_range ?? 0) >= managementConfig.outOfRangeWaitMinutes) {
    return { action: "CLOSE", rule: 4, reason: "OOR" };
  }
  if (isLowYieldEligible(position, managementConfig)) {
    return { action: "CLOSE", rule: 5, reason: "low yield" };
  }
  return null;
}

export function formatStayReason(position, managementConfig, tracked = null) {
  if (getDeterministicCloseRule(position, managementConfig, tracked)) {
    throw new Error("Cannot explain HOLD when a deterministic close rule applies");
  }
  const pnl = validPnl(position, tracked);
  const minAge = managementConfig.minAgeBeforeYieldCheck ?? 60;
  const reasons = [pnl == null
    ? "PnL unavailable/suspect; TP and SL paused"
    : pnl >= managementConfig.takeProfitPct
      ? `PnL ${pnl}% >= TP ${managementConfig.takeProfitPct}%; HOLD while in range with verified unclaimed LP fees and rolling fee/TVL ${position.fee_per_tvl_24h}% >= ${managementConfig.minFeePerTvl24h}%`
      : `PnL ${pnl}% between SL ${managementConfig.stopLossPct}% and TP ${managementConfig.takeProfitPct}%`];
  if (managementConfig.trailingTakeProfit) {
    reasons.push(tracked?.trailing_active
      ? `trailing active (confirmed peak ${tracked.peak_pnl_pct ?? "?"}%, drop trigger ${managementConfig.trailingDropPct} points)`
      : `trailing awaits confirmed peak ${managementConfig.trailingTriggerPct}%`);
  }
  reasons.push(position.in_range === true
    ? "in range"
    : position.in_range === false
      ? `OOR ${position.minutes_out_of_range ?? "?"}/${managementConfig.outOfRangeWaitMinutes}m`
      : "range status unavailable");
  if (position.age_minutes == null) {
    reasons.push("age unknown; low-yield check paused");
  } else if (position.age_minutes < minAge) {
    reasons.push(`low-yield check starts at ${minAge}m (age ${position.age_minutes}m)`);
  } else if (position.fee_per_tvl_24h == null) {
    reasons.push("yield unavailable; low-yield check paused");
  } else {
    reasons.push(`rolling 24h fee/TVL ${position.fee_per_tvl_24h}% >= ${managementConfig.minFeePerTvl24h}%`);
  }
  return reasons.join("; ");
}

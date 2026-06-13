import { log } from "./logger.js";
import { config } from "./config.js";

const _pending = new Map();
let _timeoutTimers = new Map();

function cleanupStale() {
  const now = Date.now();
  const timeoutMs = (config.screening.shariaManualApprovalTimeoutMinutes || 30) * 60 * 1000;
  for (const [id, pending] of _pending) {
    if (now - pending.staged_at > timeoutMs) {
      _pending.delete(id);
      const timer = _timeoutTimers.get(id);
      if (timer) { clearTimeout(timer); _timeoutTimers.delete(id); }
      log("approval", `Pending approval expired: ${pending.pool_name} (${id.slice(0, 8)})`);
    }
  }
}

function normalizeKey(id) {
  if (!id) return null;
  return String(id).trim();
}

export function stagePendingApproval(id, poolData) {
  cleanupStale();
  const key = normalizeKey(id);
  if (!key) return false;

  _pending.set(key, {
    id: key,
    pool_name: poolData.pool_name || poolData.name || "unknown",
    pool_address: poolData.pool_address || poolData.pool || "",
    deploy_amount: poolData.deploy_amount || config.management.deployAmountSol || 0.5,
    bins_below: poolData.bins_below || config.strategy.defaultBinsBelow || 69,
    volatility: poolData.volatility || null,
    reason: poolData.reason || "manual approval required",
    staged_at: Date.now(),
    expires_at: Date.now() + (config.screening.shariaManualApprovalTimeoutMinutes || 30) * 60 * 1000,
    status: "pending",
  });

  log("approval", `Staged pending approval: ${poolData.pool_name || key} (${key.slice(0, 8)})`);
  return true;
}

export function getPendingApproval(id) {
  cleanupStale();
  const key = normalizeKey(id);
  if (!key) return null;
  return _pending.get(key) || null;
}

export function getPendingApprovals() {
  cleanupStale();
  return Array.from(_pending.values());
}

export function hasPendingApproval() {
  cleanupStale();
  return _pending.size > 0;
}

export function resolvePendingApproval(id, decision) {
  const key = normalizeKey(id);
  if (!key) return null;
  const pending = _pending.get(key);
  if (!pending) return null;

  _pending.delete(key);
  const timer = _timeoutTimers.get(key);
  if (timer) { clearTimeout(timer); _timeoutTimers.delete(key); }

  if (decision === "approved") {
    pending.status = "approved";
    log("approval", `Approved: ${pending.pool_name} (${key.slice(0, 8)})`);
  } else {
    pending.status = "declined";
    pending.declined_at = Date.now();
    log("approval", `Declined: ${pending.pool_name} (${key.slice(0, 8)})`);
  }
  return pending;
}

export function getPendingApprovalSummary() {
  const pending = getPendingApprovals();
  if (pending.length === 0) return null;
  return pending[pending.length - 1];
}

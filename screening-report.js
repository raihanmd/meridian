export function formatDryRunDeploy(result, candidates = []) {
  const plan = result?.would_deploy;
  if (!result?.dry_run || !plan) throw new Error("Expected a simulated deploy result");
  const pool = candidates.find((candidate) => candidate.pool === plan.pool_address);
  return [
    "🧪 DRY RUN · WOULD DEPLOY",
    `Pool: ${pool?.name || plan.pool_address}`,
    `Address: ${plan.pool_address}`,
    `Simulated amount: ${plan.amount_y} SOL`,
    `Strategy: ${plan.strategy} | bins below: ${plan.bins_below} | bins above: ${plan.bins_above}`,
    "Agent selected this pool for a simulated entry. No transaction was sent and no position was created.",
  ].join("\n");
}

export function formatAllowlistedPoolDiagnostics(pools, allowlist, filtered, shortlisted, maxChars = 3000) {
  const approved = new Set((allowlist || []).map((entry) => entry.mint));
  const matching = (pools || []).filter((pool) => approved.has(pool.base?.mint));
  if (matching.length === 0) return "Allowlisted base tokens on this discovery page: 0.";

  const reasons = new Map((filtered || []).filter((item) => item.pool).map((item) => [item.pool, item.reason]));
  const top = new Set((shortlisted || []).map((pool) => pool.pool));
  const firstByMint = new Map();
  const extra = [];
  for (const pool of matching) {
    if (firstByMint.has(pool.base.mint)) extra.push(pool);
    else firstByMint.set(pool.base.mint, pool);
  }

  const lines = [`Allowlisted base tokens on this discovery page: ${firstByMint.size} token(s), ${matching.length} pool(s).`];
  let omitted = 0;
  for (const pool of [...firstByMint.values(), ...extra]) {
    const reason = reasons.get(pool.pool) || (top.has(pool.pool)
      ? "passed early filters; see later screening steps"
      : "passed early filters, but outside the top 10 by score");
    const line = `- ${pool.name || pool.base?.symbol || "?"} [${String(pool.pool || "?").slice(0, 8)}]: ${reason}`;
    if (lines.join("\n").length + line.length + 1 <= maxChars) lines.push(line);
    else omitted++;
  }
  if (omitted) lines.push(`... ${omitted} more pool(s) omitted from this Telegram summary.`);
  return lines.join("\n");
}

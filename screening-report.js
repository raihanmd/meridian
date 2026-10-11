export function formatDryRunDeploy(result, candidates = []) {
  const plan = result?.would_deploy;
  if (!result?.dry_run || !plan) throw new Error("Expected a simulated deploy result");
  const pool = candidates.find((candidate) => candidate.pool === plan.pool_address);
  return [
    plan.dual_token ? "🧪 DRY RUN · DUAL-TOKEN DEPLOY" : "🧪 DRY RUN · WOULD DEPLOY",
    `Pool: ${pool?.name || plan.pool_address}`,
    `Address: ${plan.pool_address}`,
    plan.dual_token
      ? `Budget: ${plan.amount_sol} SOL | X share: ${(plan.x_value_share * 100).toFixed(1)}% | Y share: ${(plan.y_value_share * 100).toFixed(1)}%`
      : `Simulated amount: ${plan.amount_y} SOL`,
    plan.dual_token
      ? `Strategy: ${plan.strategy} | range: ${plan.min_bin_id}–${plan.max_bin_id} | active bin: ${plan.active_bin}`
      : `Strategy: ${plan.strategy} | bins below: ${plan.bins_below} | bins above: ${plan.bins_above}`,
    ...(plan.dual_token ? [
      `Tokens: ${plan.token_x_mint} / ${plan.token_y_mint}`,
      `SOL reserve: ${plan.reserve_sol} SOL (position rent estimate ${plan.position_rent_estimate_sol} SOL; temporary-account budget ${plan.ata_rent_budget_sol} SOL)`,
      ...plan.swaps.map((swap) => `Swap ${swap.side.toUpperCase()}: ${swap.inputSol} SOL → ${swap.outputMint} | quoted min output ${swap.quote.min_out_amount} | impact ${swap.quote.price_impact_pct}%`),
      `TA: ${plan.ta.rationale}`,
    ] : []),
    "Agent selected this pool for a simulated entry. No transaction was sent and no position was created.",
  ].join("\n");
}

export function formatAllowlistedPoolDiagnostics(pools, allowlist, filtered, shortlisted, maxChars = 3000, { dualToken = false } = {}) {
  const approved = new Set((allowlist || []).map((entry) => entry.mint));
  const matching = (pools || []).filter((pool) => dualToken
    ? [pool.base?.mint, pool.quote?.mint].some((mint) => mint && approved.has(mint))
    : approved.has(pool.base?.mint));
  if (matching.length === 0) return dualToken
    ? "Pools containing an allowlisted dual-mode token on this discovery page: 0."
    : "Allowlisted base tokens on this discovery page: 0.";

  const reasons = new Map((filtered || []).filter((item) => item.pool).map((item) => [item.pool, item.reason]));
  const top = new Set((shortlisted || []).map((pool) => pool.pool));
  const firstByMint = new Map();
  const extra = [];
  for (const pool of matching) {
    const mint = dualToken
      ? [pool.base?.mint, pool.quote?.mint].find((value) => approved.has(value))
      : pool.base?.mint;
    if (firstByMint.has(mint)) extra.push(pool);
    else firstByMint.set(mint, pool);
  }

  const lines = [dualToken
    ? `Pools containing allowlisted dual-mode tokens on this discovery page: ${firstByMint.size} token(s), ${matching.length} pool(s).`
    : `Allowlisted base tokens on this discovery page: ${firstByMint.size} token(s), ${matching.length} pool(s).`];
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

function decimal(value, digits = 2) {
  const number = Number(value);
  return value == null || !Number.isFinite(number) ? "?" : number.toFixed(digits);
}

function price(value) {
  const number = Number(value);
  return value == null || !Number.isFinite(number) ? "?" : number.toPrecision(7);
}

export function formatDeployRecoveryNotice(recovery) {
  if (recovery.externallySettled) {
    return "⚠️ Operasi ditutup setelah posisi tidak ada dan saldo token hasil operasi nol. Penyelesaian dilakukan di luar bot; jumlah SOL yang diterima dan PnL belum terverifikasi.";
  }
  if (recovery.recovered) {
    return "✅ Operasi dihentikan tanpa deploy. Tidak ada token hasil operasi tertinggal di luar SOL; saldo token sebelum operasi tidak ikut dipakai dalam pemulihan. Screening akan dimulai ulang pada siklus berikutnya.";
  }
  return `⏳ Pemulihan masih berjalan${recovery.operationId ? ` (${recovery.operationId})` : ""}. Bot tidak deploy dan tidak akan memakai saldo token wallet sebagai bukti hasil swap. Hindari transaksi manual sampai rekonsiliasi selesai.`;
}

export function formatDeployFailureNotice(failure) {
  const detail = String(failure?.error || "Deploy tool returned no confirmed position")
    .replace(/\s+/g, " ").trim().slice(0, 600);
  return `DEPLOY ERROR (tool)\n${detail}\nPenyebab belum terverifikasi sampai transaksi dan saldo wallet direkonsiliasi.`;
}

export function formatEntryEvidence(ta, indicator) {
  const lines = [];
  if (ta?.eligible) {
    lines.push(`TA: ${ta.strategy} | 1h ${decimal(ta.metrics?.oneHour?.netChangePct)}% | 6h ${decimal(ta.metrics?.sixHour?.netChangePct)}%`);
    lines.push(`Distance from completed-candle high: 1h ${decimal(ta.distanceToOneHourHighPct)}% | 6h ${decimal(ta.distanceToSixHourHighPct)}%`);
    lines.push(`Last complete 15m candle ended: ${ta.latestCandleEndAt || "?"} | age ${decimal(ta.candleAgeSeconds, 0)}s`);
  }
  if (indicator?.enabled) {
    const status = indicator.skipped ? "SKIPPED" : indicator.confirmed ? "CONFIRMED" : "REJECTED";
    lines.push(`Indicator: ${status} · ${indicator.preset || "?"} · ${indicator.reason || "no reason"}`);
    if (indicator.intervals?.length) {
      lines.push(`Intervals: ${indicator.intervals.map((entry) => `${entry.interval} ${entry.ok ? entry.confirmed ? "pass" : "reject" : "unavailable"}`).join(", ")}`);
    }
  } else if (indicator == null) {
    lines.push("Indicator: no screening confirmation recorded");
  } else {
    lines.push("Indicator: disabled");
  }
  return lines;
}

export function formatConfirmedDeploy(result, { candidate = null, agentNarrative = "" } = {}) {
  if (!result?.success || !result.position) throw new Error("Expected a confirmed position result");
  const coverage = result.range_coverage;
  const ta = result.ta_evidence || candidate?.dual_ta;
  const indicator = candidate?.indicator_confirmation;
  const narrative = String(agentNarrative || "").replace(/\s+/g, " ").trim().slice(0, 420);
  return [
    "🚀 DEPLOYED",
    "",
    result.pool_name || candidate?.name || result.pool || "unknown pool",
    result.pool || candidate?.pool || "unknown address",
    `Position: ${result.position}`,
    result.txs?.length ? `Liquidity tx: ${result.txs.at(-1)}` : null,
    "",
    `◎ ${decimal(result.amount_sol ?? result.amount_y, 4)} SOL | ${result.strategy || "?"} | bin ${result.bin_range?.active ?? "?"}`,
    `Range: ${price(result.price_range?.min)} → ${price(result.price_range?.max)}`,
    coverage
      ? `Range cover: ${decimal(coverage.downside_pct)}% downside | ${decimal(coverage.upside_pct)}% upside | ${decimal(coverage.width_pct)}% total`
      : "Range cover: unavailable in confirmed tool result",
    result.dual_token ? `Deposited tokens: X ${decimal(result.amount_x, 6)} | Y ${decimal(result.amount_y, 6)}` : null,
    `Execution fees: ${decimal(result.transaction_fees_sol, 6)} SOL | position rent estimate: ${decimal(result.rent_estimate_sol, 6)} SOL`,
    "",
    "ENTRY EVIDENCE",
    ...formatEntryEvidence(ta, indicator),
    candidate ? `Screening snapshot: fee/active TVL ${decimal(candidate.fee_active_tvl_ratio, 4)}% | volume $${decimal(candidate.volume_window, 0)} | TVL $${decimal(candidate.tvl, 0)} | organic ${decimal(candidate.organic_score, 0)}` : null,
    narrative ? `Agent assessment (unverified): ${narrative}` : null,
  ].filter((line) => line != null).join("\n");
}

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
    plan.range_coverage
      ? `Range cover: ${decimal(plan.range_coverage.downside_pct)}% downside | ${decimal(plan.range_coverage.upside_pct)}% upside | ${decimal(plan.range_coverage.width_pct)}% total`
      : null,
    ...(plan.dual_token ? [
      `Tokens: ${plan.token_x_mint} / ${plan.token_y_mint}`,
      `SOL reserve: ${plan.reserve_sol} SOL (position rent estimate ${plan.position_rent_estimate_sol} SOL; temporary-account budget ${plan.ata_rent_budget_sol} SOL)`,
      ...plan.swaps.map((swap) => `Swap ${swap.side.toUpperCase()}: ${swap.inputSol} SOL → ${swap.outputMint} | quoted min output ${swap.quote.min_out_amount} | impact ${swap.quote.price_impact_pct}%`),
      `TA: ${plan.ta.rationale}`,
      ...formatEntryEvidence(plan.ta, pool?.indicator_confirmation),
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

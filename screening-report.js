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

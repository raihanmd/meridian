export async function verifyMissingPositions(activeAddresses, trackedPositions, lookup) {
  const active = new Set(activeAddresses);
  const missing = trackedPositions.filter((position) => !active.has(position.position));
  const checked = await Promise.all(missing.map(async ({ position }) => {
    try {
      const account = await lookup(position);
      return { position, status: account === null ? "absent" : "present" };
    } catch {
      return { position, status: "unknown" };
    }
  }));
  return {
    confirmedMissing: checked.filter((entry) => entry.status === "absent").map((entry) => entry.position),
    unresolved: checked.filter((entry) => entry.status !== "absent").map((entry) => entry.position),
  };
}

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

export function findPoolForPositionInSdkMap(positionsByPool, positionAddress) {
  if (!(positionsByPool instanceof Map)) throw new Error("DLMM position scan returned an unknown response shape");
  for (const [poolAddress, entry] of positionsByPool) {
    if (!Array.isArray(entry?.lbPairPositionsData)) throw new Error("DLMM position scan has an unknown pool entry");
    if (entry.lbPairPositionsData.some((position) => position?.publicKey?.toString() === positionAddress)) {
      return poolAddress.toString();
    }
  }
  return null;
}

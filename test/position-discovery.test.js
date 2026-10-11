import assert from "node:assert/strict";
import test from "node:test";
import { verifyMissingPositions } from "../tools/position-discovery.js";

test("empty portfolio cannot close a position whose on-chain account still exists", async () => {
  const result = await verifyMissingPositions([], [{ position: "live" }], async () => ({ lamports: 41_899_840 }));
  assert.deepEqual(result, { confirmedMissing: [], unresolved: ["live"] });
});

test("failed account lookup keeps the position unresolved", async () => {
  const result = await verifyMissingPositions([], [{ position: "uncertain" }], async () => { throw new Error("RPC timeout"); });
  assert.deepEqual(result, { confirmedMissing: [], unresolved: ["uncertain"] });
});

test("only a confirmed absent account may be synced as closed", async () => {
  const checked = [];
  const result = await verifyMissingPositions(
    ["listed"],
    [{ position: "listed" }, { position: "closed" }],
    async (address) => { checked.push(address); return null; },
  );
  assert.deepEqual(checked, ["closed"]);
  assert.deepEqual(result, { confirmedMissing: ["closed"], unresolved: [] });
});

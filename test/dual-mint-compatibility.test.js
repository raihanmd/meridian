import assert from "node:assert/strict";
import test from "node:test";
import { PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { checkDualMintPrograms } from "../tools/dual-mint-compatibility.js";

const SOL = "So11111111111111111111111111111111111111112";
const LEGACY = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const EXTENDED = "7KEPApdbXj3JYQyHVMtUgkxJeGQ4fsEHmSfu84igFp5U";

test("dual mint preflight accepts SOL and standard SPL mints without duplicate reads", async () => {
  let reads = 0;
  const reasons = await checkDualMintPrograms({
    connection: { getMultipleAccountsInfo: async (addresses) => {
      reads++;
      assert.deepEqual(addresses.map(String), [LEGACY]);
      return [{ owner: TOKEN_PROGRAM_ID }];
    } },
    mints: [SOL, LEGACY, LEGACY],
    solMint: SOL,
  });
  assert.equal(reads, 1);
  assert.equal(reasons.size, 0);
});

test("dual mint preflight identifies Token-2022 and unavailable mints before selection", async () => {
  const reasons = await checkDualMintPrograms({
    connection: { getMultipleAccountsInfo: async () => [
      { owner: TOKEN_2022_PROGRAM_ID },
      null,
      { owner: new PublicKey("11111111111111111111111111111111") },
    ] },
    mints: [EXTENDED, LEGACY, "11111111111111111111111111111111", "invalid"],
    solMint: SOL,
  });
  assert.match(reasons.get(EXTENDED), /Token-2022/);
  assert.match(reasons.get(LEGACY), /not found/);
  assert.match(reasons.get("11111111111111111111111111111111"), /mint owner/);
  assert.match(reasons.get("invalid"), /invalid/);
});

test("dual mint preflight fails closed when RPC cannot verify mint ownership", async () => {
  const reasons = await checkDualMintPrograms({
    connection: { getMultipleAccountsInfo: async () => { throw new Error("RPC timeout"); } },
    mints: [SOL, LEGACY],
    solMint: SOL,
  });
  assert.equal(reasons.has(SOL), false);
  assert.match(reasons.get(LEGACY), /RPC timeout/);
});

import assert from "node:assert/strict";
import test from "node:test";
import { reconcileExternallySettledDualDeploy, walletDlmmPositionAddresses } from "../tools/dual-deploy-reconciliation.js";

const SOL = "So11111111111111111111111111111111111111112";
const X = "BORDR";

function fixture(overrides = {}) {
  const operation = {
    id: "operation",
    stage: "recovery_pending",
    walletAddress: "wallet",
    positionAddress: "journaled-position",
    positionSignature: "journaled-add-liquidity",
    lastValidBlockHeight: 100,
    plan: { token_x_mint: X, token_y_mint: SOL },
    transactions: [
      { kind: "swap_x", signature: "acquire", status: "confirmed", metadata: { outputDeltaRaw: "4330950727", side: "x" } },
      { kind: "add_liquidity", signature: "journaled-add-liquidity", status: "expired" },
    ],
    ...overrides,
  };
  const transitions = [];
  const journal = {
    async transition(id, stage, patch) {
      transitions.push({ id, stage, patch });
      return { ...operation, ...patch, stage };
    },
  };
  const dependencies = {
    journal,
    operation,
    solMint: SOL,
    readPositionAccount: async () => null,
    readMintInventory: async () => ({ totalRaw: "0", associatedRaw: "0" }),
    readSignatureStatus: async () => ({ confirmationStatus: "finalized", err: null }),
    readBlockHeight: async () => 101,
    listWalletPositions: async () => [],
  };
  return { dependencies, transitions };
}

test("finalized zero token balance and wallet-wide absence record external settlement without inventing SOL proceeds", async () => {
  const { dependencies, transitions } = fixture();
  const result = await reconcileExternallySettledDualDeploy(dependencies);
  assert.equal(result.stage, "cancelled");
  assert.equal(transitions.length, 1);
  assert.equal(transitions[0].patch.externalSettlement.walletTokenBalancesRaw[X], "0");
  assert.equal(transitions[0].patch.externalSettlement.solProceedsVerified, false);
  assert.equal(transitions[0].patch.externalSettlement.pnlVerified, false);
  assert.equal(transitions[0].patch.acquiredRaw, undefined);
});

test("zero wallet balance never clears a deploy while a different wallet LP exists", async () => {
  const { dependencies, transitions } = fixture();
  dependencies.listWalletPositions = async () => ["different-position-created-after-swap"];
  assert.equal(await reconcileExternallySettledDualDeploy(dependencies), null);
  assert.equal(transitions.length, 0);
});

test("unfinalized acquisition, live journaled position, or positive wallet balance keep recovery pending", async () => {
  for (const change of [
    (args) => { args.readSignatureStatus = async (signature) => ({ confirmationStatus: signature === "acquire" ? "confirmed" : "finalized", err: null }); },
    (args) => { args.readPositionAccount = async () => ({ lamports: 1 }); },
    (args) => { args.readMintInventory = async () => ({ totalRaw: "7", associatedRaw: "7" }); },
    (args) => { args.readBlockHeight = async () => 100; },
  ]) {
    const { dependencies, transitions } = fixture();
    change(dependencies);
    assert.equal(await reconcileExternallySettledDualDeploy(dependencies), null);
    assert.equal(transitions.length, 0);
  }
});

test("unresolved submitted swap, missing transaction delta, or failed wallet scan cannot clear the journal", async () => {
  for (const change of [
    (operation) => { operation.transactions[0].status = "submitted"; },
    (operation) => { delete operation.transactions[0].metadata.outputDeltaRaw; },
  ]) {
    const { dependencies, transitions } = fixture();
    change(dependencies.operation);
    assert.equal(await reconcileExternallySettledDualDeploy(dependencies), null);
    assert.equal(transitions.length, 0);
  }
  const { dependencies } = fixture();
  dependencies.listWalletPositions = async () => null;
  await assert.rejects(() => reconcileExternallySettledDualDeploy(dependencies), /did not return a list/);
});

test("SDK wallet position scan accepts its Map shape and rejects empty plain objects", () => {
  assert.deepEqual(walletDlmmPositionAddresses(new Map()), []);
  assert.deepEqual(walletDlmmPositionAddresses(new Map([
    ["pool", { lbPairPositionsData: [{ publicKey: { toString: () => "other-lp" } }] }],
  ])), ["other-lp"]);
  assert.throws(() => walletDlmmPositionAddresses({}), /unknown response shape/);
  assert.throws(() => walletDlmmPositionAddresses(new Map([["pool", {}]])), /unknown response shape/);
});

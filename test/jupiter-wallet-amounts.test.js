import assert from "node:assert/strict";
import test from "node:test";
import { assertSelfPaidJupiterOrder, jupiterPriceImpactPercent, jupiterWalletSettlementAmounts } from "../tools/wallet.js";

test("dual-token orders require the wallet to own the transaction signature", () => {
  const taker = "wallet";
  assert.doesNotThrow(() => assertSelfPaidJupiterOrder({ order: { signatureFeePayer: taker, gasless: false }, taker, firstSigner: taker }));
  assert.throws(() => assertSelfPaidJupiterOrder({ order: { signatureFeePayer: "sponsor", gasless: true }, taker, firstSigner: "sponsor" }), /external fee payer/);
  assert.throws(() => assertSelfPaidJupiterOrder({ order: { signatureFeePayer: taker, gasless: false }, taker, firstSigner: "sponsor" }), /external fee payer/);
  assert.throws(() => assertSelfPaidJupiterOrder({ order: { signatureFeePayer: null }, taker, firstSigner: taker }), /external fee payer/);
});

test("Jupiter fractional price impact is converted to percent for both quote checks", () => {
  assert.equal(jupiterPriceImpactPercent({ priceImpactPct: "0.004" }), 0.4);
  assert.equal(jupiterPriceImpactPercent({ priceImpactPct: "-0.01" }), 1);
  assert.equal(jupiterPriceImpactPercent({ priceImpact: -0.5, priceImpactPct: "0.2" }), 0.5);
  assert.ok(Number.isNaN(jupiterPriceImpactPercent({})));
  assert.ok(Number.isNaN(jupiterPriceImpactPercent({ priceImpact: "invalid" })));
});

test("Jupiter accounting uses wallet settlement amounts when a fee changes route amounts", () => {
  assert.deepEqual(jupiterWalletSettlementAmounts({
    inputAmountResult: "995", totalInputAmount: "1000",
    outputAmountResult: "500", totalOutputAmount: "497",
  }), {
    amount_in: "1000", amount_out: "497",
    route_amount_in: "995", route_amount_out: "500",
  });
});

test("Jupiter accounting supports historical responses without total amounts", () => {
  assert.deepEqual(jupiterWalletSettlementAmounts({ inputAmountResult: "1000", outputAmountResult: "500" }), {
    amount_in: "1000", amount_out: "500",
    route_amount_in: "1000", route_amount_out: "500",
  });
});

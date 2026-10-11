import assert from "node:assert/strict";
import test from "node:test";
import { valuePoolTokens } from "../tools/pnl.js";

test("STRK-USDC position values USDC at its own price", () => {
  const value = valuePoolTokens({
    xRaw: "148467838285", yRaw: "15456168", decX: 9, decY: 6,
    priceX: 0.118, priceY: 1, solUsd: 110,
  });
  assert.ok(Math.abs(value.usd - (148.467838285 * 0.118 + 15.456168)) < 1e-9);
  assert.ok(Math.abs(value.sol - value.usd / 110) < 1e-12);
  assert.ok(value.usd < 40);
});

test("STRK-SOL position still values SOL as token Y", () => {
  const value = valuePoolTokens({
    xRaw: "1000000000", yRaw: "100000000", decX: 9, decY: 9,
    priceX: 0.12, priceY: 110, solUsd: 110,
  });
  assert.equal(value.usd, 11.12);
  assert.equal(value.sol, 11.12 / 110);
});

test("a held token with no price cannot produce actionable position value", () => {
  const missingQuote = valuePoolTokens({
    xRaw: "1000000000", yRaw: "15000000", decX: 9, decY: 6,
    priceX: 0.12, priceY: null, solUsd: 110,
  });
  assert.equal(missingQuote.usd, null);
  assert.equal(missingQuote.sol, null);

  const emptyQuote = valuePoolTokens({
    xRaw: "1000000000", yRaw: "0", decX: 9, decY: 6,
    priceX: 0.12, priceY: null, solUsd: 110,
  });
  assert.equal(emptyQuote.usd, 0.12);
});

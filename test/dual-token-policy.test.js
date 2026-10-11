import assert from "node:assert/strict";
import test from "node:test";
import { getDualPoolRestrictionReason, SOL_MINT } from "../token-allowlist.js";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const TOKEN = "TokenMint111111111111111111111111111111111";
const OTHER = "OtherMint111111111111111111111111111111111";
const allowlist = [{ name: "TOKEN", mint: TOKEN }];

test("dual policy accepts allowed token against configured base assets", () => {
  assert.equal(getDualPoolRestrictionReason(TOKEN, SOL_MINT, allowlist, [SOL_MINT, USDC]), null);
  assert.equal(getDualPoolRestrictionReason(USDC, TOKEN, allowlist, [SOL_MINT, USDC]), null);
});

test("dual policy rejects missing, duplicate, unapproved, and base-only pairs", () => {
  assert.match(getDualPoolRestrictionReason(null, SOL_MINT, allowlist), /missing/);
  assert.match(getDualPoolRestrictionReason(TOKEN, TOKEN, allowlist), /different/);
  assert.match(getDualPoolRestrictionReason(TOKEN, OTHER, allowlist), /every non-base/);
  assert.match(getDualPoolRestrictionReason(SOL_MINT, USDC, allowlist, [SOL_MINT, USDC]), /at least one/);
  assert.match(getDualPoolRestrictionReason(TOKEN, SOL_MINT, [], [SOL_MINT]), /empty/);
});

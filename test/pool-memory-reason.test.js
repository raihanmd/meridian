import assert from "node:assert/strict";
import test from "node:test";
import { isLowYieldCloseReason } from "../pool-memory.js";

test("recognizes low-yield close reasons emitted by both manager paths", () => {
  assert.equal(isLowYieldCloseReason("low yield"), true);
  assert.equal(isLowYieldCloseReason("Rule 5: low yield"), true);
  assert.equal(isLowYieldCloseReason("Low yield: fee/TVL 1% < min 3%"), true);
  assert.equal(isLowYieldCloseReason("User command /close"), false);
  assert.equal(isLowYieldCloseReason("Rule 2: take profit"), false);
});

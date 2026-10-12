import assert from "node:assert/strict";
import test from "node:test";
import { config } from "../config.js";
import { confirmIndicatorPreset } from "../tools/chart-indicators.js";

test("indicator results distinguish confirmation, rejection and unavailable fallback", async () => {
  const original = config.indicators.enabled;
  config.indicators.enabled = true;
  try {
    const options = { mint: "STRK", side: "entry", preset: "supertrend_break", intervals: ["5_MINUTE"] };
    const confirmed = await confirmIndicatorPreset({ ...options, fetchIndicators: async () => ({ latest: { candle: { close: 1.1 }, supertrend: { direction: "bullish", value: 1 } } }) });
    assert.equal(confirmed.confirmed, true);
    assert.equal(confirmed.skipped, false);
    const rejected = await confirmIndicatorPreset({ ...options, fetchIndicators: async () => ({ latest: { candle: { close: 0.9 }, supertrend: { direction: "bearish", value: 1 } } }) });
    assert.equal(rejected.confirmed, false);
    const unavailable = await confirmIndicatorPreset({ ...options, fetchIndicators: async () => { throw new Error("API timeout"); } });
    assert.equal(unavailable.confirmed, true);
    assert.equal(unavailable.skipped, true);
    assert.match(unavailable.intervals[0].reason, /API timeout/);
  } finally {
    config.indicators.enabled = original;
  }
});

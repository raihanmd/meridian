import assert from "node:assert/strict";
import test from "node:test";
import { aggregateOhlcvCandles, analyzeDualTokenRange, computeDualValueSplit, normalizeOhlcvCandles } from "../tools/dual-ta.js";

const now = 1_800_000_000;

function candles({ count = 32, start = 1, step = 0, noise = 0, gapAt = -1 } = {}) {
  return Array.from({ length: count }, (_, index) => {
    const timestamp = now - (count - index) * 900 + (index >= gapAt && gapAt >= 0 ? 1800 : 0);
    const close = start + step * index + (index % 2 === 0 ? noise : -noise);
    const open = index === 0 ? close : start + step * (index - 1) + (index % 2 === 1 ? noise : -noise);
    return { timestamp, open, high: Math.max(open, close) * 1.002, low: Math.min(open, close) * 0.998, close, volume: 100 + index };
  });
}

function analyze(input = {}) {
  return analyzeDualTokenRange({
    candles: candles(), activeBin: 100, binStep: 100, nowSeconds: now,
    minTotalBins: 20, maxTotalBins: 60, minBinsPerSide: 5,
    ...input,
  });
}

test("normalizes unordered OHLCV and millisecond timestamps", () => {
  const source = candles({ count: 3 });
  const result = normalizeOhlcvCandles([source[2], { ...source[1], timestamp: source[1].timestamp * 1000 }, source[0]]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.candles.map((candle) => candle.timestamp), source.map((candle) => candle.timestamp));
});

test("aggregates only complete aligned 5-minute candles into 15-minute bars", () => {
  const fiveMinute = Array.from({ length: 4 }, (_, index) => ({
    timestamp: now - 1800 + index * 300,
    open: 10 + index,
    high: 12 + index,
    low: 9 + index,
    close: 11 + index,
    volume: 2,
  }));
  const result = aggregateOhlcvCandles(fiveMinute, { nowSeconds: now });
  assert.equal(result.ok, true);
  assert.equal(result.candles.length, 1);
  assert.equal(result.candles[0].timestamp, now - 1800);
  assert.equal(result.candles[0].open, 10);
  assert.equal(result.candles[0].close, 13);
  assert.equal(result.candles[0].high, 14);
  assert.equal(result.candles[0].low, 9);
  assert.equal(result.candles[0].volume, 6);
  const misaligned = fiveMinute.map((bar, index) => index === 1 ? { ...bar, timestamp: bar.timestamp + 30 } : bar);
  assert.equal(aggregateOhlcvCandles(misaligned, { nowSeconds: now }).candles.length, 0);
});

test("rejects insufficient, malformed, duplicate, future, stale, and gapped series", () => {
  assert.equal(analyze({ candles: candles({ count: 23 }) }).eligible, false);
  assert.match(analyze({ candles: [{ timestamp: now, open: 1, high: 0.9, low: 1, close: 1, volume: 1 }] }).reason, /invalid price/);
  const duplicate = candles();
  duplicate[2] = { ...duplicate[2], timestamp: duplicate[1].timestamp };
  assert.match(analyze({ candles: duplicate }).reason, /Duplicate/);
  assert.match(analyze({ candles: candles().map((candle, index) => index === 31 ? { ...candle, timestamp: now + 120 } : candle) }).reason, /future/);
  assert.match(analyze({ candles: candles().map((candle) => ({ ...candle, timestamp: candle.timestamp - 2_000 })) }).reason, /stale/);
  assert.match(analyze({ candles: candles({ gapAt: 10 }), nowSeconds: now + 900 }).reason, /gap/);
  const oneMissing = candles().filter((_, index) => index !== 10);
  assert.match(analyze({ candles: oneMissing, nowSeconds: now + 900 }).reason, /gap/);
  const misaligned = candles().map((candle, index) => index === 10 ? { ...candle, timestamp: candle.timestamp + 30 } : candle);
  assert.match(analyze({ candles: misaligned }).reason, /aligned/);
});

test("rejects invalid bin inputs and unsafe dual range bounds", () => {
  assert.match(analyze({ activeBin: 1.5 }).reason, /Active bin/);
  assert.match(analyze({ binStep: 0 }).reason, /Bin step/);
  assert.match(analyze({ maxTotalBins: 70 }).reason, /bin limits/);
  assert.match(analyze({ minBinsPerSide: 12, minTotalBins: 20 }).reason, /bin limits/);
});

test("selects bounded active-bin-centered ranges and produces deterministic Spot/Curve choices", () => {
  const meanReverting = analyze({ candles: candles({ start: 1, noise: 0.015 }) });
  const trending = analyze({ candles: candles({ start: 1, step: 0.01 }) });
  assert.equal(meanReverting.eligible, true);
  assert.equal(meanReverting.strategy, "curve");
  assert.equal(trending.strategy, "spot");
  assert.equal(meanReverting.maxBinId - meanReverting.minBinId, meanReverting.binsBelow + meanReverting.binsAbove);
  assert.ok(meanReverting.minBinId < meanReverting.activeBin && meanReverting.maxBinId > meanReverting.activeBin);
  assert.ok(meanReverting.binsBelow >= 5 && meanReverting.binsAbove >= 5);
  assert.deepEqual(analyze({ candles: candles({ start: 1, noise: 0.015 }) }), meanReverting);
});

test("widens with observed volatility and biases bins toward a sustained trend", () => {
  const calm = analyze({ candles: candles({ start: 1, noise: 0.001 }) });
  const volatile = analyze({ candles: candles({ start: 1, noise: 0.08 }) });
  const upward = analyze({ candles: candles({ start: 1, step: 0.01 }) });
  const downward = analyze({ candles: candles({ start: 1.32, step: -0.01 }) });
  assert.ok(volatile.binsBelow + volatile.binsAbove >= calm.binsBelow + calm.binsAbove);
  assert.ok(upward.binsAbove > upward.binsBelow);
  assert.ok(downward.binsBelow > downward.binsAbove);
});

test("computes an equal value split for a symmetric distribution and adapts to bin prices", () => {
  const symmetric = [
    { binId: 99, xAmountBpsOfTotal: 0, yAmountBpsOfTotal: 5000 },
    { binId: 100, xAmountBpsOfTotal: 5000, yAmountBpsOfTotal: 5000 },
    { binId: 101, xAmountBpsOfTotal: 5000, yAmountBpsOfTotal: 0 },
  ];
  const equal = computeDualValueSplit({ distribution: symmetric, activeBin: 100, binStep: 100 });
  assert.ok(Math.abs(equal.xValueShare - 0.5) < 0.002);
  assert.ok(Math.abs(equal.yValueShare - 0.5) < 0.002);
  const aboveHeavy = computeDualValueSplit({
    distribution: [
      { binId: 99, xAmountBpsOfTotal: 0, yAmountBpsOfTotal: 2500 },
      { binId: 100, xAmountBpsOfTotal: 2500, yAmountBpsOfTotal: 2500 },
      { binId: 101, xAmountBpsOfTotal: 7500, yAmountBpsOfTotal: 0 },
    ], activeBin: 100, binStep: 100,
  });
  assert.ok(aboveHeavy.xValueShare > equal.xValueShare);
  assert.throws(() => computeDualValueSplit({ distribution: [], activeBin: 100, binStep: 100 }), /empty/);
  assert.throws(() => computeDualValueSplit({ distribution: [{ binId: 99, xAmountBpsOfTotal: 0, yAmountBpsOfTotal: 10000 }], activeBin: 100, binStep: 100 }), /both token sides/);
});

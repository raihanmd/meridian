const FIFTEEN_MINUTES_SECONDS = 15 * 60;
const FIVE_MINUTES_SECONDS = 5 * 60;

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeTimestamp(value) {
  const timestamp = finiteNumber(value);
  if (timestamp == null || timestamp <= 0) return null;
  return timestamp > 1e12 ? Math.floor(timestamp / 1000) : Math.floor(timestamp);
}

export function normalizeOhlcvCandles(candles) {
  if (!Array.isArray(candles)) return { ok: false, reason: "OHLCV response is not an array", candles: [] };
  const normalized = [];
  const timestamps = new Set();

  for (const [index, candle] of candles.entries()) {
    const timestamp = normalizeTimestamp(candle?.timestamp ?? candle?.time ?? candle?.ts);
    const open = finiteNumber(candle?.open ?? candle?.o);
    const high = finiteNumber(candle?.high ?? candle?.h);
    const low = finiteNumber(candle?.low ?? candle?.l);
    const close = finiteNumber(candle?.close ?? candle?.c);
    const volume = finiteNumber(candle?.volume ?? candle?.v ?? 0);
    if (timestamp == null || open == null || high == null || low == null || close == null || volume == null) {
      return { ok: false, reason: `OHLCV candle ${index + 1} has a missing or non-finite field`, candles: [] };
    }
    if (open <= 0 || high <= 0 || low <= 0 || close <= 0 || volume < 0 || high < low || high < open || high < close || low > open || low > close) {
      return { ok: false, reason: `OHLCV candle ${index + 1} has invalid price or volume bounds`, candles: [] };
    }
    if (timestamps.has(timestamp)) return { ok: false, reason: `Duplicate OHLCV timestamp ${timestamp}`, candles: [] };
    timestamps.add(timestamp);
    normalized.push({ timestamp, open, high, low, close, volume });
  }

  normalized.sort((a, b) => a.timestamp - b.timestamp);
  return { ok: true, reason: null, candles: normalized };
}

// Meteora's OHLCV endpoint serves 5m bars. Keep only complete, aligned
// 15m buckets so a partial current bucket cannot look like a full sample.
export function aggregateOhlcvCandles(candles, { intervalSeconds = FIFTEEN_MINUTES_SECONDS, nowSeconds = Date.now() / 1000 } = {}) {
  const normalized = normalizeOhlcvCandles(candles);
  if (!normalized.ok) return normalized;
  if (!Number.isInteger(intervalSeconds) || intervalSeconds <= 0) {
    return { ok: false, reason: "OHLCV aggregate interval is invalid", candles: [] };
  }
  const buckets = new Map();
  for (const candle of normalized.candles) {
    const bucketStart = Math.floor(candle.timestamp / intervalSeconds) * intervalSeconds;
    const bucket = buckets.get(bucketStart) ?? { timestamp: bucketStart, open: candle.open, high: candle.high, low: candle.low, close: candle.close, volume: 0, samples: 0, lastTimestamp: null, aligned: true };
    if (candle.timestamp !== bucketStart + bucket.samples * FIVE_MINUTES_SECONDS || (bucket.lastTimestamp != null && candle.timestamp <= bucket.lastTimestamp)) bucket.aligned = false;
    bucket.high = Math.max(bucket.high, candle.high);
    bucket.low = Math.min(bucket.low, candle.low);
    if (bucket.samples === 0) bucket.open = candle.open;
    bucket.close = candle.close;
    bucket.volume += candle.volume;
    bucket.samples += 1;
    bucket.lastTimestamp = candle.timestamp;
    buckets.set(bucketStart, bucket);
  }
  const expectedSamples = intervalSeconds / FIVE_MINUTES_SECONDS;
  const aggregated = [...buckets.values()]
    .filter((bucket) => bucket.aligned && bucket.samples === expectedSamples && bucket.timestamp + intervalSeconds <= nowSeconds)
    .sort((a, b) => a.timestamp - b.timestamp)
    .map(({ timestamp, open, high, low, close, volume }) => ({ timestamp, open, high, low, close, volume }));
  return { ok: true, reason: null, candles: aggregated };
}

export async function fetchDualTokenOhlcv(poolAddress, {
  fetchImpl = fetch,
  nowSeconds = Date.now() / 1000,
  lookbackSeconds = 6 * 60 * 60 + FIFTEEN_MINUTES_SECONDS,
  timeoutMs = 10_000,
} = {}) {
  if (typeof poolAddress !== "string" || !poolAddress.trim()) throw new Error("Pool address is required for dual-token OHLCV");
  const start = Math.floor(nowSeconds - lookbackSeconds);
  const end = Math.floor(nowSeconds);
  const url = new URL(`https://dlmm.datapi.meteora.ag/pools/${encodeURIComponent(poolAddress)}/ohlcv`);
  url.searchParams.set("timeframe", "5m");
  url.searchParams.set("start_time", String(start));
  url.searchParams.set("end_time", String(end));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`Meteora OHLCV API returned ${response.status}`);
    const payload = await response.json();
    const bars = Array.isArray(payload) ? payload : payload?.data;
    if (!Array.isArray(bars)) throw new Error("Meteora OHLCV API response has no candle array");
    return aggregateOhlcvCandles(bars, { intervalSeconds: FIFTEEN_MINUTES_SECONDS, nowSeconds });
  } finally {
    clearTimeout(timer);
  }
}

function candleWindowMetrics(candles) {
  const first = candles[0];
  const last = candles[candles.length - 1];
  const high = Math.max(...candles.map((candle) => candle.high));
  const low = Math.min(...candles.map((candle) => candle.low));
  const absoluteReturns = [];
  let squaredLogReturns = 0;
  for (let index = 1; index < candles.length; index++) {
    const change = Math.log(candles[index].close / candles[index - 1].close);
    absoluteReturns.push(Math.abs(change));
    squaredLogReturns += change * change;
  }
  const pathLength = absoluteReturns.reduce((sum, value) => sum + value, 0);
  const netChange = Math.log(last.close / first.open);
  return {
    open: first.open,
    close: last.close,
    high,
    low,
    rangePct: ((high - low) / last.close) * 100,
    netChangePct: (Math.exp(netChange) - 1) * 100,
    realizedVolatilityPct: Math.sqrt(squaredLogReturns) * 100,
    directionalEfficiency: pathLength > 0 ? Math.abs(netChange) / pathLength : 0,
    volume: candles.reduce((sum, candle) => sum + candle.volume, 0),
    samples: candles.length,
  };
}

export function analyzeDualTokenRange({
  candles,
  activeBin,
  binStep,
  nowSeconds = Date.now() / 1000,
  minSamples = 24,
  maxCandleAgeSeconds = 30 * 60,
  maxGapSeconds = FIFTEEN_MINUTES_SECONDS,
  minBinsPerSide = 5,
  minTotalBins = 35,
  maxTotalBins = 69,
  volatilityMultiplier = 1.25,
  maxDirectionalBias = 0.2,
  curveEfficiencyMax = 0.35,
}) {
  const normalized = normalizeOhlcvCandles(candles);
  if (!normalized.ok) return { eligible: false, reason: normalized.reason };
  if (!Number.isInteger(activeBin)) return { eligible: false, reason: "Active bin is missing or invalid" };
  if (!Number.isFinite(binStep) || binStep <= 0) return { eligible: false, reason: "Bin step is missing or invalid" };
  if (minSamples < 24 || normalized.candles.length < minSamples) {
    return { eligible: false, reason: `Need ${minSamples} valid 15-minute candles; received ${normalized.candles.length}` };
  }
  if (minBinsPerSide < 1 || minTotalBins < minBinsPerSide * 2 || maxTotalBins < minTotalBins || maxTotalBins > 69) {
    return { eligible: false, reason: "Dual-token bin limits are inconsistent or exceed the atomic range limit" };
  }
  if (!Number.isFinite(volatilityMultiplier) || volatilityMultiplier <= 0 || !Number.isFinite(maxDirectionalBias) || maxDirectionalBias < 0 || maxDirectionalBias > 0.4) {
    return { eligible: false, reason: "Dual-token TA configuration is invalid" };
  }

  const series = normalized.candles;
  const latest = series.at(-1);
  if (nowSeconds - latest.timestamp > maxCandleAgeSeconds || latest.timestamp > nowSeconds + 60) {
    return { eligible: false, reason: "Latest OHLCV candle is stale or from the future" };
  }
  if (series.some((candle) => candle.timestamp % FIFTEEN_MINUTES_SECONDS !== 0)) {
    return { eligible: false, reason: "15-minute OHLCV candles are not aligned to interval boundaries" };
  }
  for (let index = 1; index < series.length; index++) {
    const gap = series[index].timestamp - series[index - 1].timestamp;
    if (gap > maxGapSeconds || gap < FIFTEEN_MINUTES_SECONDS - 60) {
      return { eligible: false, reason: "15-minute OHLCV series contains a gap or overlapping candles" };
    }
  }

  const sixHour = series.slice(-24);
  const oneHour = series.slice(-4);
  const metrics = {
    fifteenMinute: candleWindowMetrics(series.slice(-1)),
    oneHour: candleWindowMetrics(oneHour),
    sixHour: candleWindowMetrics(sixHour),
  };
  const latestCandleEndSeconds = latest.timestamp + FIFTEEN_MINUTES_SECONDS;
  const distanceToOneHourHighPct = ((metrics.oneHour.high - latest.close) / metrics.oneHour.high) * 100;
  const distanceToSixHourHighPct = ((metrics.sixHour.high - latest.close) / metrics.sixHour.high) * 100;
  const trend = metrics.sixHour.netChangePct / 100;
  const trendBias = Math.tanh(trend * 8) * maxDirectionalBias;
  const targetWidthPct = metrics.sixHour.rangePct * volatilityMultiplier;
  const binWidthPct = binStep / 100;
  const volatilityBins = Math.ceil(Math.log1p(targetWidthPct / 100) / Math.log1p(binWidthPct / 100));
  const totalBins = Math.max(minTotalBins, Math.min(maxTotalBins, volatilityBins));
  let binsBelow = Math.round((totalBins * (0.5 - trendBias)));
  binsBelow = Math.max(minBinsPerSide, Math.min(totalBins - minBinsPerSide, binsBelow));
  const binsAbove = totalBins - binsBelow;
  const strategy = metrics.sixHour.directionalEfficiency <= curveEfficiencyMax ? "curve" : "spot";

  return {
    eligible: true,
    strategy,
    activeBin,
    binsBelow,
    binsAbove,
    minBinId: activeBin - binsBelow,
    maxBinId: activeBin + binsAbove,
    metrics,
    latestCandleEndAt: new Date(latestCandleEndSeconds * 1000).toISOString(),
    candleAgeSeconds: Math.max(0, nowSeconds - latestCandleEndSeconds),
    distanceToOneHourHighPct,
    distanceToSixHourHighPct,
    rationale: `TA: ${metrics.sixHour.samples} fresh 15m candles; 6h range ${metrics.sixHour.rangePct.toFixed(2)}%, trend ${metrics.sixHour.netChangePct.toFixed(2)}%, directional efficiency ${metrics.sixHour.directionalEfficiency.toFixed(2)}; ${strategy} distribution over ${totalBins} bins.`,
  };
}

export function computeDualValueSplit({ distribution, activeBin, binStep }) {
  if (!Array.isArray(distribution) || distribution.length === 0) throw new Error("DLMM distribution is empty");
  if (!Number.isInteger(activeBin) || !Number.isFinite(binStep) || binStep <= 0) throw new Error("Active bin or bin step is invalid");
  let xValueWeight = 0;
  let yValueWeight = 0;
  for (const entry of distribution) {
    const binId = Number(entry?.binId);
    const xBps = Number(entry?.xAmountBpsOfTotal?.toString?.() ?? entry?.xAmountBpsOfTotal);
    const yBps = Number(entry?.yAmountBpsOfTotal?.toString?.() ?? entry?.yAmountBpsOfTotal);
    if (!Number.isInteger(binId) || !Number.isFinite(xBps) || !Number.isFinite(yBps) || xBps < 0 || yBps < 0) {
      throw new Error("DLMM distribution contains invalid token weights");
    }
    const relativePrice = Math.pow(1 + binStep / 10_000, binId - activeBin);
    xValueWeight += (xBps / 10_000) * relativePrice;
    yValueWeight += yBps / 10_000;
  }
  const total = xValueWeight + yValueWeight;
  if (!Number.isFinite(total) || total <= 0 || xValueWeight <= 0 || yValueWeight <= 0) {
    throw new Error("DLMM distribution must allocate positive value to both token sides");
  }
  return {
    xValueShare: xValueWeight / total,
    yValueShare: yValueWeight / total,
    xValueWeight,
    yValueWeight,
  };
}

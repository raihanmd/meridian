export function computePriceRangeCoverage({ min, max, active }) {
  if (![min, max, active].every((value) => Number.isFinite(value) && value > 0)
    || min > active || active > max) {
    throw new Error("Position prices do not form a valid range around the active bin");
  }
  return {
    downside_pct: ((active - min) / active) * 100,
    upside_pct: ((max - active) / active) * 100,
    width_pct: ((max - min) / min) * 100,
    active_price: active,
  };
}

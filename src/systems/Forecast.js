// Forecast — project supply/demand and expected price for a producible in a
// country at a future date. Used by AI to decide what to plant (or build)
// considering the long lead time of crops/mines, NOT just today's spot price.
//
// SRP: pure read. No mutation. Composes priceMA + tile pipeline counting.

import { PRODUCIBLES } from '../data/producibles.js';
import { priceMA } from './Market.js';

// Pipeline supply: how many units/day of `pid` are "in flight" — tiles in
// 'planted' state whose harvest is yet to come, normalised by their remaining
// growth time. A field 50% grown contributes yieldUnits / (growthDays × 0.5).
export function pipelineSupplyFor(state, cid, pid) {
  const def = PRODUCIBLES[pid];
  if (!def || !def.growthDays) return 0;
  const map = state.maps?.[cid];
  if (!map) return 0;
  let dailySupply = 0;
  for (const tile of map.tiles) {
    if (tile.crop !== pid) continue;
    if (tile.state !== 'planted') continue;
    const remainingFraction = Math.max(0.01, 1 - (tile.growth || 0));
    dailySupply += (def.yieldUnits || 0) / (def.growthDays * remainingFraction);
  }
  return dailySupply;
}

// Expected price `daysAhead` in the future. Combines a long-window MA with a
// pipeline-supply discount: if many fields are coming online soon, expect
// price to fall. Cold-start fallback — if there's not enough history, fall
// back to whatever MA we can compute, or the producible's basePrice.
export function expectedPriceAt(state, cid, pid, daysAhead) {
  const def = PRODUCIBLES[pid];
  if (!def) return 0;
  const history = state.market.history?.[cid]?.[pid] || [];
  const base = def.market?.basePrice ?? 0;
  if (history.length < 30) {
    // Cold start: use whatever MA is available, or fall back to basePrice.
    const ma = priceMA(state, pid, cid, Math.min(history.length, 30));
    return ma > 0 ? ma : base;
  }
  const lookback = Math.max(30, Math.min(180, daysAhead));
  const ma = priceMA(state, pid, cid, lookback);
  if (ma <= 0) return base;
  // Supply-pressure discount: if pipeline + current production > consumption,
  // expect prices to drop. Ratio clamped via division so output is bounded
  // smoothly (no hard cap on the result).
  const consumption = state.countries[cid]?.consumption?.[pid] ?? 0;
  if (consumption <= 0) return ma;
  const pipeline = pipelineSupplyFor(state, cid, pid);
  const supplyRatio = (pipeline + consumption) / consumption;       // ≥ 1
  const discount = 1 / supplyRatio;
  // Smoothed (so a 10x pipeline doesn't tank the expected price to 0):
  const smoothed = Math.pow(discount, 0.5);
  return ma * smoothed;
}

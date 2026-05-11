// Inflation — pure facade for inflation-adjusted "effective" cost helpers.
// State mutation lives in PriceIndex.js (priceIndex EMA). This module only
// composes price-index and (post Sprint A) wage-rate getters into the cost
// functions other systems consume.

import { COUNTRY_IDS } from '../data/countries.js';
import { LAND_ACTIONS, MINERALS } from '../data/tunables.js';
import { priceIndexFor } from './PriceIndex.js';
import { wageRateFor } from './Labor.js';

// Re-export for convenience so callers don't have to import from two places.
export { priceIndexFor, wageRateFor };

// Build a factory — capital with commodity components (steel, cement). Scales
// with priceIndex (it reflects the commodity basket the factory consumes).
export function effectiveBuildCost(state, cid, recipe) {
  return Math.round((recipe?.buildCost || 0) * priceIndexFor(state, cid));
}

// Plow — pure labor.
export function effectivePlowCost(state, cid) {
  return Math.round((LAND_ACTIONS.plow.labor || 0) * wageRateFor(state, cid));
}

// Survey — pure labor.
export function effectiveSurveyCost(state, cid) {
  return Math.round((MINERALS.surveyLabor || 0) * wageRateFor(state, cid));
}

// Setup cost for opening a venture on a tile (plant a crop, open a mine).
// CROPS: labor × wageRate  +  0.1 units of the producible at its current
//        market price (the seed itself — a commodity buy).
// MINERALS: labor only (no "seed"; you can't plant a mineral).
// Used by AI for ROI decisions and by plantTile for actual cash flow — same
// formula on both sides keeps player and AI capabilities identical.
export function effectiveSetupCost(state, cid, def) {
  const labor = Math.round((def?.setupLabor || 0) * wageRateFor(state, cid));
  const isCrop = def?.category === 'annual_crop' || def?.category === 'perennial_crop';
  if (!isCrop) return labor;
  const SEED_FRACTION = 0.1;
  const price = state.market.prices?.[cid]?.[def.id] ?? def.market?.basePrice ?? 0;
  return labor + Math.round(SEED_FRACTION * price);
}

// Splits the setup cost into labor (paid to wageFund) and commodity (paid to
// marketPool). plantTile/plowTile etc. route the cash accordingly.
export function setupCostSplit(state, cid, def) {
  const labor = Math.round((def?.setupLabor || 0) * wageRateFor(state, cid));
  const total = effectiveSetupCost(state, cid, def);
  return { labor, commodity: Math.max(0, total - labor), total };
}

// Labor costs — Sprint A. Driven by the market wageRate (which itself is
// affected by priceIndex via cost-of-living), NOT directly by priceIndex.
// Recipes/defs declare LABOR UNITS (workforce, harvestLabor, monthlyLabor)
// and these helpers compose them with the country's market wage.
export function effectiveSalary(state, cid, recipe) {
  return Math.round((recipe?.workforce || 0) * wageRateFor(state, cid));
}
export function effectiveHarvestCost(state, cid, def) {
  return Math.round((def?.harvestLabor || 0) * wageRateFor(state, cid));
}
export function effectiveMonthlyOpCost(state, cid, def) {
  return Math.round((def?.monthlyLabor || 0) * wageRateFor(state, cid));
}

// Country money-pool accessor (not strictly inflation, but adjacent and used
// by UI/audit code). Keep here for backwards compat.
export function marketPoolFor(state, countryId) {
  return state.countries?.[countryId]?.marketPool ?? 0;
}

// Diagnostic — sum of all wallets + per-country pools. Should drift only from
// the transport sink and net loan flow with the closed-loop economy.
export function totalMoneySupply(state) {
  let total = 0;
  if (state.player) total += state.player.cash || 0;
  if (state.aiFarmers) for (const a of state.aiFarmers) total += a.cash || 0;
  for (const cid of COUNTRY_IDS) {
    const c = state.countries[cid];
    if (!c) continue;
    total += (c.wageFund || 0) + (c.treasury || 0) + (c.marketPool || 0);
  }
  return total;
}

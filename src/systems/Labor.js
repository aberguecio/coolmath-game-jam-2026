// Labor — per-country wage market. wageRate emerges from labor demand (sum of
// workforce across operational ventures) vs labor supply (population × PEA),
// smoothed by a 60-day EMA and amplified by priceIndex (cost-of-living).
//
// SRP: this module ONLY computes wage market dynamics. It does NOT charge
// salaries (that's `tickIndustrySalaries` in Industries.js) and does NOT
// touch costs (the `effective*` helpers in Inflation.js compose wageRateFor
// into the per-recipe costs).

import { COUNTRY_IDS } from '../data/countries.js';
import { PRODUCIBLES } from '../data/producibles.js';
import { WAGES, FARMING } from '../data/tunables.js';

// tickLaborMarket runs MONTHLY (every ~30 days), so alpha must be computed
// against the tick interval, not per-day. With emaHalfLifeDays=60 (= 2 months
// to reach half-life), alpha per monthly tick ≈ 0.293. Without this scaling
// the EMA only moves ~1% per tick and takes 5 years to converge.
const LABOR_TICK_DAYS = 30;
const EMA_ALPHA = 1 - Math.pow(0.5, LABOR_TICK_DAYS / WAGES.emaHalfLifeDays);

// Labor SUPPLY: each `population` unit in countries.js is an abstract
// market-size scalar — we multiply by `workersPerPopUnit` to scale into the
// same unit as industry `workforce` fields. Pure read.
export function laborSupplyFor(state, cid) {
  const c = state.countries?.[cid];
  if (!c) return 0;
  return (c.population || 0) * WAGES.workersPerPopUnit;
}

// Labor DEMAND: tileTendingLabor for every crop tile in cultivation.
// Crops are uniform (FARMING.tileTendingLabor) — harvestLabor is a cash spike
// paid at harvest time, NOT recurring demand.
export function laborDemandFor(state, cid) {
  let total = 0;

  // Crops on the country's map
  const map = state.maps?.[cid];
  if (map) {
    const tendingLabor = FARMING.tileTendingLabor ?? 1;
    for (const tile of map.tiles) {
      if (!tile.crop) continue;
      if (tile.owner === 'wild' || tile.owner === 'developer' || tile.owner === 'city') continue;
      const def = PRODUCIBLES[tile.crop];
      if (!def) continue;
      // crops (annual + perennial): only count while in cultivation
      if (tile.state === 'fallow' || tile.state === 'plowed') continue;
      total += tendingLabor;
    }
  }

  return total;
}

// Demand/supply ratio, smoothed via sqrt. Sqrt is a damping function — output
// is unbounded but extreme inputs compress (a 100× excess gives only ~10×
// wage premium). This is the labor-market analog of price elasticity: wages
// respond to scarcity sub-linearly. Not a cap — it's elasticity.
//
// Why this is needed: country populations vary 280× (home=5 vs china=1400)
// while seeded industries are uniform across countries. A linear ratio gives
export function wageRateFor(state, cid) {
  return state.countries?.[cid]?.wageRate ?? WAGES.baseWage;
}

// Monthly tick — updates wageRate via EMA toward target = baseWage × tightness.
// Wages depend ONLY on labour supply/demand. priceIndex deliberately NOT
// included — that's the cost-of-living adjustment that creates wage-price
// spirals. Keeping wages divorced from priceIndex breaks the feedback loop:
// when food prices spike for any reason, wages don't chase them, so industries
// stay viable and the spiral can't run away. priceIndex still affects capital
// costs (build/seed/plow) which are separately indexed in Inflation.js.
export function tickLaborMarket(state) {
  for (const cid of COUNTRY_IDS) {
    const c = state.countries[cid];
    if (!c) continue;
    const supply = (c.population || 0) * WAGES.workersPerPopUnit;
    const demand = laborDemandFor(state, cid);
    const raw = supply > 0 ? demand / supply : 1;
    const tightness = Math.sqrt(Math.max(0, raw));
    const target = WAGES.baseWage * tightness;
    c.wageRate = (1 - EMA_ALPHA) * (c.wageRate ?? WAGES.baseWage) + EMA_ALPHA * target;
    c.laborSupply = supply;
    c.laborDemand = demand;
    c.wageRateHistory.push(c.wageRate);
    // Unbounded — same reasoning as Market.js / PriceIndex.js.
  }
}

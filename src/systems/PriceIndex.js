// PriceIndex — per-country 60-day EMA of a food + materials price basket.
// Owns the EMA state mutation (tickPriceIndex) and the read-only getter
// (priceIndexFor). Inflation.js and Labor.js compose on top of this.
//
// Loans and tax rates are NOT indexed — they stay nominal so the bank "eats"
// inflation (per design). Only nominal world-costs scale through here.

import { PRODUCIBLES, PRODUCIBLE_IDS } from '../data/producibles.js';
import { COUNTRY_IDS, PLAYER_COUNTRY_ID } from '../data/countries.js';
import { ECONOMY_DEFAULTS } from '../data/tunables.js';

// Weighting between food (cost-of-living) and materials (industrial inputs).
// Setting material=0 reverts to a food-only index.
export const INDEX_WEIGHTS = { food: 0.70, material: 0.30 };
const PRICE_INDEX_HALFLIFE_DAYS = 60;
const PRICE_INDEX_ALPHA = 1 - Math.pow(0.5, 1 / PRICE_INDEX_HALFLIFE_DAYS); // ~0.0115

function basePriceOf(def) {
  return def?.market?.basePrice ?? ECONOMY_DEFAULTS.basePrice ?? 1;
}

export function tickPriceIndex(state) {
  for (const cid of COUNTRY_IDS) {
    const c = state.countries[cid];
    if (!c) continue;

    let foodNum = 0, foodDen = 0;
    let matNum = 0, matDen = 0;
    for (const pid of PRODUCIBLE_IDS) {
      const def = PRODUCIBLES[pid];
      if (!def) continue;
      const base = basePriceOf(def) || 1;
      const localPrice = state.market.prices[cid][pid] || base;
      const ratio = localPrice / base;
      const cons = c.consumption[pid] || 0;
      if (def.commodityType === 'food') {
        const w = cons * (def.nutritionUnits || 1);
        foodNum += ratio * w;
        foodDen += w;
      } else {
        const w = Math.max(cons, 0.1);
        matNum += ratio * w;
        matDen += w;
      }
    }
    const foodComp = foodDen > 0 ? foodNum / foodDen : 1;
    const matComp = matDen > 0 ? matNum / matDen : 1;
    const basket = INDEX_WEIGHTS.food * foodComp + INDEX_WEIGHTS.material * matComp;
    c.priceIndex = (1 - PRICE_INDEX_ALPHA) * c.priceIndex + PRICE_INDEX_ALPHA * basket;
    c.priceIndexHistory.push(c.priceIndex);
    // Unbounded — see note in Market.js. Memory cost is tiny.
  }
}

export function priceIndexFor(state, countryId = PLAYER_COUNTRY_ID) {
  return state.countries?.[countryId]?.priceIndex ?? 1.0;
}

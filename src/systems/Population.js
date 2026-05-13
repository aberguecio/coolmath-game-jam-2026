// Population — daily affordability-driven food spending. Population is a buyer
// only; it consumes from a country's marketPool via wageFund. Premium foods
// (low nutritionUnits) get crushed when fiscalCrisis.preferenceCrush is high.
// Welfare top-up: if wageFund falls below `wageFundFloorDays` worth of food,
// treasury fills the gap.

import { PRODUCIBLES, PRODUCIBLE_IDS, isFood } from '../data/producibles.js';
import { COUNTRIES, COUNTRY_IDS } from '../data/countries.js';
import { effectiveTaxRates } from '../data/taxRates.js';
import { WAGES } from '../data/tunables.js';
import { executeTransaction } from './Transactions.js';

export function populationSpend(state) {
  for (const cid of COUNTRY_IDS) {
    const c = state.countries[cid];
    const reg = COUNTRIES[cid];
    const m = state.market;
    if (!reg || !c) continue;

    c.dailyNutritionConsumed = 0;

    const candidates = [];
    for (const pid of PRODUCIBLE_IDS) {
      if (!isFood(pid)) continue;
      const prefBase = reg.preferences?.[pid] ?? 0;
      // Crisis: premium foods fade, basic foods get a small lift.
      const crush = c.fiscalCrisis?.preferenceCrush ?? 0;
      const nutrition = PRODUCIBLES[pid].nutritionUnits ?? 0.5;
      const isPremium = nutrition < 0.7;
      const prefMod = c.preferenceModifiers?.[pid] ?? 1;
      const pref = prefBase * prefMod * (isPremium ? Math.max(0.2, 1 - crush) : 1 + crush * 0.5);
      if (pref <= 0) continue;
      const price = m.prices[cid][pid];
      const score = pref * nutrition / Math.max(0.5, price);
      candidates.push({ pid, pref, price, nutrition, score });
    }
    candidates.sort((a, b) => b.score - a.score);

    let budget = c.wageFund;
    const totalPref = candidates.reduce((s, x) => s + x.pref, 0) || 1;

    for (const cand of candidates) {
      if (budget <= 0) break;
      const inv = m.inventory[cid][cand.pid] || 0;
      if (inv <= 0) continue;
      const allocate = budget * (cand.pref / totalPref);
      const rates = effectiveTaxRates(state, cid);
      const unitTotal = cand.price * (1 + rates.sale);
      const wantUnits = allocate / unitTotal;
      const buyUnits = Math.min(wantUnits, inv);
      if (buyUnits <= 0) continue;
      const r = executeTransaction(state, {
        sellerId: 'foreign',
        buyerId: 'population',
        productId: cand.pid,
        units: buyUnits,
        unitPrice: cand.price,
        countryOfTransaction: cid,
        sellerCountryId: cid,
        type: 'sale',
      });
      if (!r.ok) continue;
      m.inventory[cid][cand.pid] -= buyUnits;
      c.dailyNutritionConsumed += buyUnits * cand.nutrition;
      // Per-country daily consumption counter for the market snapshot CSV.
      // Parallel to the global m.dailyConsumption; both stay in sync.
      if (!c.consumptionDay) c.consumptionDay = {};
      c.consumptionDay[cand.pid] = (c.consumptionDay[cand.pid] || 0) + buyUnits;
      budget -= (r.grossRevenue + r.taxPaid);
    }

    // Welfare top-up
    const floor = reg.population * WAGES.dailyFoodCostPerCapita * WAGES.wageFundFloorDays;
    if (c.wageFund < floor) {
      const gap = floor - c.wageFund;
      c.wageFund += gap;
      c.treasury -= gap;
    }
  }
}

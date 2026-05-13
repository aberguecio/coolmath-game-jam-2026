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
import { recordConsumption } from './Market.js';

export function populationSpend(state) {
  for (const cid of COUNTRY_IDS) {
    const c = state.countries[cid];
    const reg = COUNTRIES[cid];
    const m = state.market;
    if (!reg || !c) continue;

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
    // Score-share: reparto del budget proporcional al `score`, no a la
    // preferencia cruda. Items caros o escasos pierden share automáticamente
    // (precio alto → score bajo) → la población migra a sustitutos sin
    // necesidad de un cap explícito de diversidad.
    const totalScore = candidates.reduce((s, x) => s + x.score, 0) || 1;
    // Tope blando: nutrición = supervivencia × well-being. Cuando se alcanza,
    // la población deja de comprar (no se atraganta; el budget sobrante queda
    // en wageFund para mañana).
    const nutritionTarget = c.population * WAGES.nutritionPerCapita * WAGES.wellBeingFactor;
    let nutritionAcquired = 0;

    for (const cand of candidates) {
      if (budget <= 0 || nutritionAcquired >= nutritionTarget) break;
      const inv = m.inventory[cid][cand.pid] || 0;
      if (inv <= 0) continue;
      const allocate = budget * (cand.score / totalScore);
      const rates = effectiveTaxRates(state, cid);
      const unitTotal = cand.price * (1 + rates.sale);
      const wantUnits = allocate / unitTotal;
      // Cap por nutrición remanente — no compra más de lo que falta para
      // alcanzar el target nutricional.
      const remainingNutrition = Math.max(0, nutritionTarget - nutritionAcquired);
      const maxByNutrition = cand.nutrition > 0 ? remainingNutrition / cand.nutrition : wantUnits;
      const buyUnits = Math.min(wantUnits, inv, maxByNutrition);
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
      // Registrar como consumo local — la población siempre es local por design.
      // Pasa por recordConsumption (mismo helper que buyFromGlobal) → mantiene
      // el invariante consumptionHistory === consumptionLocalHistory + consumptionExportHistory.
      recordConsumption(c, cand.pid, buyUnits, /* isExport */ false);
      nutritionAcquired += buyUnits * cand.nutrition;
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

// FiscalCrisis — monthly state machine. When a country's treasury goes
// negative for `triggerNegativeMonths`, crisis activates: tax bump escalates,
// premium-food preference crushes, salary contributions get haircut (used by
// tickIndustrySalaries). Anneals back when treasury holds positive for
// `recoveryPositiveMonths`.

import { FISCAL_CRISIS } from '../data/tunables.js';
import { COUNTRY_IDS } from '../data/countries.js';
import { pushLog } from '../state/GameState.js';

export function tickFiscalCrisis(state) {
  for (const cid of COUNTRY_IDS) {
    const c = state.countries[cid];
    if (!c) continue;
    const fc = c.fiscalCrisis;
    if (c.treasury < 0) {
      fc.monthsNegative += 1;
      fc.monthsPositive = 0;
      if (!fc.active && fc.monthsNegative >= FISCAL_CRISIS.triggerNegativeMonths) {
        fc.active = true;
        fc.taxBump = 0;
        fc.preferenceCrush = 0;
        if (cid === 'home') pushLog(state, `🚨 FISCAL CRISIS in Home — taxes rising.`);
      }
      if (fc.active) {
        fc.taxBump += FISCAL_CRISIS.taxBumpPerMonth;
        fc.preferenceCrush = Math.min(1, fc.preferenceCrush + FISCAL_CRISIS.preferenceCrushPerMonth);
      }
    } else {
      fc.monthsPositive += 1;
      fc.monthsNegative = 0;
      if (fc.active && fc.monthsPositive >= FISCAL_CRISIS.recoveryPositiveMonths) {
        fc.taxBump = Math.max(0, fc.taxBump - FISCAL_CRISIS.taxBumpPerMonth);
        fc.preferenceCrush = Math.max(0, fc.preferenceCrush - FISCAL_CRISIS.preferenceCrushPerMonth);
        if (fc.taxBump <= 0 && fc.preferenceCrush <= 0) {
          fc.active = false;
          if (cid === 'home') pushLog(state, `Fiscal crisis ended in Home.`);
        }
      }
    }
  }
}

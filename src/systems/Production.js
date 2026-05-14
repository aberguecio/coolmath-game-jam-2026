// Production elasticity — per-country, per-producible delay line. When a local
// price runs hot vs basePrice, farmers in that country plant more; the change
// shows up in supply only after `growthDays` because of the FIFO delay log.
// This is what creates the cobweb dynamics in market sparklines.

import { PRODUCIBLES, PRODUCIBLE_IDS } from '../data/producibles.js';
import { COUNTRIES, COUNTRY_IDS } from '../data/countries.js';
import { MARKET, ECONOMY_DEFAULTS } from '../data/tunables.js';

function basePriceOf(def) {
  return def?.market?.basePrice ?? ECONOMY_DEFAULTS.basePrice ?? 1;
}

function plantingDecision(state, country, producibleId) {
  const def = PRODUCIBLES[producibleId];
  if (!def) return 1;
  const basePrice = basePriceOf(def) || 1;
  const localPrice = state.market.prices[country.id]?.[producibleId] || basePrice;
  const ratio = localPrice / basePrice;
  const reg = COUNTRIES[country.id];
  const responsiveness = reg?.supplyResponsiveness ?? 1.0;
  const factor = 1 + (ratio - 1) * responsiveness;
  return Math.max(MARKET.elasticityMin, Math.min(MARKET.elasticityMax, factor));
}

export function tickProductionDecisions(state) {
  for (const cid of COUNTRY_IDS) {
    const c = state.countries[cid];
    for (const pid of PRODUCIBLE_IDS) {
      const def = PRODUCIBLES[pid];
      if (!c.decisionLog[pid]) c.decisionLog[pid] = [1.0];
      const log = c.decisionLog[pid];
      log.push(plantingDecision(state, c, pid));
      const maxLen = (def?.growthDays || 90) + 1;
      while (log.length > maxLen) log.shift();
    }
  }
}

// Elasticity helpers — leen el decisionLog (cobweb delay) que produce
// tickProductionDecisions. Quien materializa la oferta son los agentes
// reales (AI farmers en aiTryHarvestAndPlant); estos getters son sólo
// para UI y diagnóstico.
export function elasticityFor(state, countryId, producibleId) {
  const c = state.countries[countryId];
  if (!c) return 1;
  const log = c.decisionLog?.[producibleId];
  if (!log || log.length === 0) return 1;
  return log[0];
}

export function elasticityTargetFor(state, countryId, producibleId) {
  const c = state.countries[countryId];
  if (!c) return 1;
  return plantingDecision(state, c, producibleId);
}

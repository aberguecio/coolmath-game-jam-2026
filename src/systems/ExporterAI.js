// ExporterAI — decision logic for AI-owned exporters. Parallel split of
// `Industries.js` / `IndustryAI.js`: lifecycle is in Exporters.js, the
// decision of WHAT to ship lives here.
//
// Heuristic per cooldown tick:
//   For every (src, dst, pid) triple, estimate margin per unit as
//     dstExpectedPrice − srcCurrentPrice − transportPerUnit
//   Pick the triple with the highest margin/dstPrice ratio, sized by what the
//   exporter can afford and what src inventory permits. Skip if the ratio
//   is below `EXPORTERS.minMarginPct`.

import { EXPORTERS } from '../data/tunables.js';
import { COUNTRY_IDS } from '../data/countries.js';
import { PRODUCIBLE_LIST } from '../data/producibles.js';
import { transportCost, distanceBetween } from '../data/distances.js';
import { priceMA } from './Market.js';
import { expectedPriceAt } from './Forecast.js';
import { exporterStartShipment } from './Exporters.js';

export function aiExporterTryShipment(state, exporter) {
  if (exporter.bankrupt) return;
  if (exporter.cash <= 0) return;
  const budget = exporter.cash * EXPORTERS.maxCapitalPerTripFraction;
  if (budget <= 0) return;

  // Each exporter is anchored to ITS OWN town. An Oakdale exporter only
  // handles Oakdale↔X routes; a Riverside exporter only Riverside↔X.
  const anchor = exporter.homeCountryId;
  // Soft anti-overlap: skip pids currently in flight from another same-town
  // exporter. Once their cargo settles, the pid is free again — no permanent
  // ownership of products.
  const inFlightByPeers = new Set();
  for (const e of state.exporters || []) {
    if (e.id === exporter.id) continue;
    if (e.homeCountryId !== anchor) continue;
    for (const c of e.inFlight) inFlightByPeers.add(c.pid);
  }

  let bestMarginRatio = -Infinity;
  let bestPlan = null;
  for (const src of COUNTRY_IDS) {
    const srcInv = state.market.inventory?.[src];
    if (!srcInv) continue;
    for (const dst of COUNTRY_IDS) {
      if (src === dst) continue;
      // Route must touch the anchor town as either origin OR destination.
      if (src !== anchor && dst !== anchor) continue;
      const dist = distanceBetween(src, dst);
      const etaDays = Math.max(1, Math.round(EXPORTERS.etaDaysPerDistance * dist));
      for (const def of PRODUCIBLE_LIST) {
        const pid = def.id;
        if (inFlightByPeers.has(pid)) continue;
        const srcStock = srcInv[pid] || 0;
        if (srcStock <= 0) continue;
        const srcPrice = priceMA(state, pid, src, 30);
        if (srcPrice <= 0) continue;
        const dstPrice = expectedPriceAt(state, dst, pid, etaDays);
        if (dstPrice <= 0) continue;
        const transportPerUnit = transportCost(src, dst, 1);
        const margin = dstPrice - srcPrice - transportPerUnit;
        if (margin <= 0) continue;
        const marginRatio = margin / dstPrice;
        if (marginRatio < EXPORTERS.minMarginPct) continue;

        // How many units can the exporter actually float?
        const unitCostAtSrc = srcPrice * 1.10;     // rough markup for tax slack
        const maxByCash = Math.floor(budget / Math.max(1, unitCostAtSrc + transportPerUnit));
        const units = Math.min(maxByCash, Math.floor(srcStock * 0.5));    // never more than half src stock
        if (units < 1) continue;

        // Score = total expected profit (ratio × volume) — favours bigger trips.
        const score = margin * units;
        if (score > bestMarginRatio) {
          bestMarginRatio = score;
          bestPlan = { srcCid: src, dstCid: dst, pid, units, marginRatio };
        }
      }
    }
  }
  if (!bestPlan) return;
  exporterStartShipment(state, exporter, bestPlan);
}

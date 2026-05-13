// MarketHistory — records a per-day snapshot of (country, product) market
// state so the debug CSV export can hand a complete picture to the user (or
// to me) for AI tuning. Captures the signals you can't reconstruct after the
// fact: instantaneous inventory, daily supply pulse, daily consumption,
// current wage and priceIndex.
//
// SRP: this module only records snapshots. It doesn't know about CSV
// formatting, downloads, or which UI surface will eventually display them.
//
// Embeds price + priceMA30 directly in each record (rather than joining
// against m.history by array index at export time). That keeps each row
// self-contained — no risk of array misalignment if tick ordering changes
// down the line — and avoids re-running priceMA across thousands of points
// every time the user clicks the export button.

import { COUNTRY_IDS } from '../data/countries.js';
import { PRODUCIBLE_IDS } from '../data/producibles.js';
import { offMarketInventoryFor, priceMA } from './Market.js';

export function initMarketSnapshot(state) {
  if (!state.market.snapshot) state.market.snapshot = {};
  for (const cid of COUNTRY_IDS) {
    if (!state.market.snapshot[cid]) state.market.snapshot[cid] = {};
    for (const pid of PRODUCIBLE_IDS) {
      if (!state.market.snapshot[cid][pid]) state.market.snapshot[cid][pid] = [];
    }
  }
}

export function recordMarketSnapshot(state) {
  if (!state.market.snapshot) initMarketSnapshot(state);
  const day = state.time.totalDays;
  for (const cid of COUNTRY_IDS) {
    const c = state.countries[cid];
    if (!c) continue;
    const series = state.market.snapshot[cid];
    for (const pid of PRODUCIBLE_IDS) {
      const price = state.market.prices?.[cid]?.[pid] ?? 0;
      series[pid].push({
        day,
        price: Math.round(price * 100) / 100,
        priceMA30: Math.round(priceMA(state, pid, cid, 30) * 100) / 100,
        marketStock: Math.round(state.market.inventory?.[cid]?.[pid] ?? 0),
        offMarketStock: Math.round(offMarketInventoryFor(state, cid, pid)),
        supplyDay: Math.round(c.supplyToday?.[pid] ?? 0),
        consumptionDay: Math.round(c.consumptionDay?.[pid] ?? 0),
        priceIndex: Math.round((c.priceIndex ?? 1) * 1000) / 1000,
        wageRate: Math.round(c.wageRate ?? 0),
      });
    }
  }
}

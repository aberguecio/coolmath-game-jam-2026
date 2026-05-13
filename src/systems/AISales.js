// AISales — gradual inventory dump-prevention strategy for AI farmers.
// Replaces the old "sell every harvest immediately" behaviour that caused
// price crashes (cobweb cycle). AIs now hold output in inventory and sell
// only when the spot price is reasonable vs the 60-day MA, drip-feeding
// supply at `AI.sellRate` per tick. Hard cap: if inventory exceeds N days
// of local consumption, dump the excess regardless of price — prevents
// permanent hoarding.
//
// SRP: only decides WHEN/HOW MUCH to sell. The selling rail (executeTransaction
// + supplyToday push) is `sellFromInventory` in Market.js — the same one the
// player uses, so AI and player share one code path.

import { AI } from '../data/tunables.js';
import { priceMA, sellFromInventory, inventoryFor } from './Market.js';

export function aiTrySellInventory(state, ai) {
  const cid = ai.countryId;
  const inv = inventoryFor(ai, cid);
  for (const [pid, qty] of Object.entries(inv)) {
    if (qty <= 0) continue;
    const price = state.market.prices?.[cid]?.[pid] || 0;
    if (price <= 0) continue;
    const ma60 = priceMA(state, pid, cid, 60);
    if (ma60 <= 0) continue;

    // Hard cap: if stock exceeds AI.inventoryCapDays × local consumption,
    // dump the excess regardless of price (otherwise stale inventory racks
    // up storage cost forever).
    const consumption = state.countries[cid]?.consumption?.[pid] ?? 0;
    const cap = consumption * AI.inventoryCapDays;
    const forceSale = consumption > 0 && qty > cap;

    if (!forceSale && price < ma60 * AI.sellThreshold) continue;

    const sellQty = forceSale
      ? Math.ceil(qty - cap)
      : Math.max(1, Math.floor(qty * AI.sellRate));

    sellFromInventory(state, ai.id, pid, sellQty, cid);
  }
}

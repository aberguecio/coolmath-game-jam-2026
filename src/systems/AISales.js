// AISales — gradual inventory dump-prevention strategy for AI farmers.
// Replaces the old "sell every harvest immediately" behaviour that caused
// price crashes (cobweb cycle). AIs now hold output in inventory and sell
// only when the spot price is reasonable vs the 60-day MA, drip-feeding
// supply at `AI.sellRate` per tick. Hard cap: if inventory exceeds N days
// of local consumption, dump the excess regardless of price — prevents
// permanent hoarding.

import { AI } from '../data/tunables.js';
import { priceMA } from './Market.js';
import { executeTransaction } from './Transactions.js';

export function aiTrySellInventory(state, ai) {
  if (!ai.inventory) return;
  const cid = ai.countryId;
  for (const [pid, qty] of Object.entries(ai.inventory)) {
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

    const r = executeTransaction(state, {
      sellerId: ai.id, buyerId: 'foreign',
      productId: pid, units: sellQty, unitPrice: price,
      countryOfTransaction: cid, sellerCountryId: cid,
      type: 'b2b',
    });
    if (r.ok) {
      ai.inventory[pid] = qty - sellQty;
      const country = state.countries[cid];
      if (country) {
        country.supplyToday[pid] = (country.supplyToday[pid] || 0) + sellQty;
      }
    }
  }
}

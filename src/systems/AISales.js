// AISales — drip-sell dinámico de inventario para AI farmers. Combina dos
// señales para modular el rate de venta:
//   1) priceRatio = price / MA60 — vende más cuando el precio está alto vs
//      su media móvil (capitalizar oportunidad), menos cuando está bajo.
//   2) stockPressure = qty / inventoryCap — vende más rápido cuanto más
//      acumulado tiene (storage cost incentiva no acumular para siempre).
//
// Si stock > cap, override: fire-sale del exceso regardless of price.
//
// SRP: only decides WHEN/HOW MUCH to sell. The selling rail (executeTransaction
// + supplyToday push) is `sellFromInventory` in Market.js — the same one the
// player uses, so AI and player share one code path.

import { AI } from '../data/tunables.js';
import { priceMA, sellFromInventory, inventoryFor, recordSupplyIntent } from './Market.js';

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

export function aiTrySellInventory(state, ai) {
  const cid = ai.countryId;
  const inv = inventoryFor(ai, cid);
  for (const [pid, qty] of Object.entries(inv)) {
    if (qty <= 0) continue;
    const price = state.market.prices?.[cid]?.[pid] || 0;
    if (price <= 0) continue;
    const ma60 = priceMA(state, pid, cid, 60);
    if (ma60 <= 0) continue;

    const consumption = state.countries[cid]?.consumption?.[pid] ?? 0;
    const cap = consumption * AI.inventoryCapDays;

    // Hard cap (force-sale del exceso): si el stock supera el cap por mucho,
    // se descarga el exceso sin importar el precio. Storage cost ya estaría
    // comiendo la rentabilidad.
    if (consumption > 0 && qty > cap) {
      const sellQty = Math.ceil(qty - cap);
      recordSupplyIntent(state.countries[cid], pid, sellQty);
      sellFromInventory(state, ai.id, pid, sellQty, cid);
      continue;
    }

    // Drip-sell dinámico (Opción B):
    //   priceMult     ∈ [0.2, 2.5] — clampea price/MA60. Precio bajo → vendo
    //                              poco (cash flow básico). Precio alto → vendo más.
    //   stockPressure ≥ 1.0     — empieza a acelerar cuando stock supera 50%
    //                              del cap. Sin tope: más stock = más urgencia.
    //   sellRate = AI.sellRate × priceMult × stockPressure
    // Cuando consumption=0 (item sin consumer real), cap=0 → stockRatio
    // siempre 1 (tratamos como "full cap") para que la presión sea neutral
    // y la fórmula no divida por cero.
    const priceRatio = price / ma60;
    const priceMult = clamp(priceRatio, 0.2, 2.5);
    const stockRatio = cap > 0 ? (qty / cap) : 1;
    const stockPressure = 1 + Math.max(0, stockRatio - 0.5);
    const dynamicRate = AI.sellRate * priceMult * stockPressure;

    const sellQty = Math.max(1, Math.floor(qty * dynamicRate));
    recordSupplyIntent(state.countries[cid], pid, sellQty);
    sellFromInventory(state, ai.id, pid, sellQty, cid);
  }
}

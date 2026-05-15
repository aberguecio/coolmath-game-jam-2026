// AISales — drip-list de inventario para AI farmers bajo modelo de consignación.
//
// Modelo: el AI no "vende" al market — LISTA stock en la góndola (sin recibir
// cash aún). La plata llega cuando un buyer real compra del listing. Esto
// elimina el cuello de botella del marketPool y hace que el hoarding sea
// económicamente irracional (storage sigue charged sobre stock no-listado).
//
// La función decide CUÁNTO listar por semana usando:
//   priceMult     = price / MA60 (sin clamp) — listar más cuando el precio está alto.
//   stockPressure ≥ 1 — acelera el listing si hay mucho stock acumulado.
//
// Si el stock supera el cap consume × inventoryCapDays, force-list del exceso.

import { AI } from '../data/tunables.js';
import { priceMA, listOnMarket, inventoryFor, recordSupplyIntent } from './Market.js';

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

    // Force-list del excedente — sin guard `consumption > 0`. Si hay stock
    // sobre el cap, dumpealo: storage cost lo hace irracional mantenerlo.
    // Cuando cap=0 (item sin consumer baseline), cualquier qty > 0 es excedente.
    if (qty > cap) {
      const listQty = Math.ceil(qty - cap);
      recordSupplyIntent(state.countries[cid], pid, listQty);
      listOnMarket(state, ai.id, pid, listQty, cid);
      continue;
    }

    // Drip-list dinámico — sin clamp arbitrario en priceMult. A precios muy
    // bajos, AI lista menos (priceMult chico). A precios altos, lista más.
    // Comportamiento orgánico sin números mágicos.
    const priceRatio = price / ma60;
    const stockRatio = cap > 0 ? (qty / cap) : 1;
    const stockPressure = 1 + Math.max(0, stockRatio - 0.5);
    const dynamicRate = AI.sellRate * priceRatio * stockPressure;

    const listQty = Math.max(1, Math.floor(qty * dynamicRate));
    recordSupplyIntent(state.countries[cid], pid, listQty);
    listOnMarket(state, ai.id, pid, listQty, cid);
  }
}

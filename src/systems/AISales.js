// AISales — bajo consignación, listar tiene costo cero: el stock sigue siendo
// del owner hasta que alguien lo compra. La regla por default es "lista todo".
//
// Hook de personalidad: cada AI farmer tiene `keepFraction` ∈ [0, 1]. La cantidad
// listada es `qty × (1 − keepFraction)`. Default keepFraction = 0 → lista todo.
// Futuras personalidades pueden setear distintos valores (hoarder = 0.5, trader = 0,
// small-scale = 0.2, etc.) sin cambiar esta función.

import { listOnMarket, inventoryFor, recordSupplyIntent } from './Market.js';

export function aiTrySellInventory(state, ai) {
  const cid = ai.countryId;
  const inv = inventoryFor(ai, cid);
  const keep = Math.max(0, Math.min(1, ai.keepFraction ?? 0));
  for (const [pid, qty] of Object.entries(inv)) {
    if (qty <= 0) continue;
    const listQty = Math.floor(qty * (1 - keep));
    if (listQty <= 0) continue;
    recordSupplyIntent(state.countries[cid], pid, listQty);
    listOnMarket(state, ai.id, pid, listQty, cid);
  }
}

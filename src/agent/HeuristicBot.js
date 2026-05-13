// HeuristicBot — v1 con reglas simples para el primer barrido de exploits.
//
// Filosofía: hacer lo "obvio" que un humano racional haría con el panel a la
// vista. Si esto acumula plata infinita sin riesgo o reproduce un patrón
// trivial dominante, hay un bug económico — exactamente lo que queremos
// encontrar.
//
// Reglas (en orden de prioridad por día):
//  1. Si tengo inventario de comida > 30 días de consumo del país en mi país →
//     vender el excedente.
//  2. Si tengo un loan disponible y cash < $5000 → pedir un working-capital.
//  3. Si tengo cash > $X y un tile mío sin uso → plantar el crop de mejor
//     priceMA30 entre los que el tile tolera (heurística: priceMA30/cycleDays).
//  4. Si tengo un tile farm maduro → cosechar.
//  5. Si tengo industria con inputs faltantes Y cash → comprarlos al mercado.

import { COUNTRY_IDS, PLAYER_COUNTRY_ID } from '../data/countries.js';
import { PRODUCIBLE_IDS, PRODUCIBLES, isFood } from '../data/producibles.js';

const MIN_CASH_TO_PLANT = 200;

export class HeuristicBot {
  constructor(opts = {}) {
    this.maxActionsPerDay = opts.maxActionsPerDay ?? 4;
  }

  decide(obs, _actions) {
    const out = [];
    const home = obs.countries[PLAYER_COUNTRY_ID];
    if (!home) return out;

    // Rule 1 — dump food inventory above threshold.
    const invHome = obs.player.inventoryByCountry?.[PLAYER_COUNTRY_ID] ?? {};
    for (const [pid, qty] of Object.entries(invHome)) {
      if (qty <= 0) continue;
      if (!isFood(pid)) continue;
      const dayConsumption = home.consumeDay?.[pid] ?? 0;
      const cap = Math.max(30, dayConsumption * 30);
      if (qty > cap) {
        out.push({
          action: 'sellInventory',
          producibleId: pid,
          units: qty - cap,
          countryId: PLAYER_COUNTRY_ID,
        });
        if (out.length >= this.maxActionsPerDay) return out;
      }
    }

    // Rule 4 — harvest mature crops.
    for (const t of obs.player.tilesOwned) {
      if (t.countryId !== PLAYER_COUNTRY_ID) continue;
      if (t.state === 'mature') {
        out.push({ action: 'harvestTile', tileId: t.id, countryId: PLAYER_COUNTRY_ID });
        if (out.length >= this.maxActionsPerDay) return out;
      }
    }

    // Rule 3 — plant on idle owned farm tiles when cash allows.
    if (obs.player.cash > MIN_CASH_TO_PLANT) {
      for (const t of obs.player.tilesOwned) {
        if (t.countryId !== PLAYER_COUNTRY_ID) continue;
        if (t.lockType === 'industry' || t.lockType === 'mining') continue;
        if (t.state !== 'fallow' && t.state !== 'cosechado' && t.state !== 'plowed') continue;
        // pick the food producible with best 30d MA per cycle-day proxy
        let best = null, bestScore = -Infinity;
        for (const pid of PRODUCIBLE_IDS) {
          if (!isFood(pid)) continue;
          const def = PRODUCIBLES[pid];
          if (!def) continue;
          const ma = home.priceMA30?.[pid] ?? 0;
          const cycle = def.cycleDays ?? def.growDays ?? 60;
          const score = ma / Math.max(1, cycle);
          if (score > bestScore) { bestScore = score; best = pid; }
        }
        if (best) {
          if (t.state === 'fallow') {
            out.push({ action: 'plowTile', tileId: t.id, countryId: PLAYER_COUNTRY_ID });
          } else {
            out.push({ action: 'plantTile', tileId: t.id, countryId: PLAYER_COUNTRY_ID, producibleId: best });
          }
          if (out.length >= this.maxActionsPerDay) return out;
        }
      }
    }

    if (out.length === 0) out.push({ action: 'noop' });
    return out;
  }
}

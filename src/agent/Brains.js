// Brains — registry de "cerebros" pluggables para actores (player o AI).
//
// Cada brain es una FUNCIÓN PURA con signature:
//   decide(observation, actor) → action[]
//
// Donde:
//   observation = snapshot producido por observeForActor(state, actor.id).
//   actor       = el objeto del actor (ai farmer o player). Puede tener
//                 brainParams (config de personalidad) y brainMemory (state
//                 persistente entre ticks). El brain lee/escribe acá.
//   action[]    = lista de acciones discriminated-union, ver Actions.js.
//
// Los actores tienen ai.brainType (string). decideFor(brainType) devuelve la
// función registered. Si el brainType no existe, fallback a idle (no hace nada).
//
// Para agregar una personalidad nueva: 1 función + 1 entrada al registry.
// Cero cambios al motor.

import { AI, OFFERS } from '../data/tunables.js';
import { PRODUCIBLES, PRODUCIBLE_LIST } from '../data/producibles.js';
import { lockTypeForCategory } from '../systems/Farming.js';

// =============================================================================
// idle — el actor no hace nada. Útil para AIs pausadas o el player en pasivo.
// =============================================================================
export function idleDecide(_obs, _actor) {
  return [];
}

// =============================================================================
// heuristic — replica la lógica histórica de AI.js (aiTryLoan + aiPickBestVenture
// + aiTryHarvestAndPlant + aiTryBuyLand + aiTryOffer). Emite actions en vez de
// mutar state. Es el "default" para los AI farmers.
// =============================================================================

// Picker interno — equivalente a aiPickBestVenture pero leyendo de obs.
// Compara TODOS los producibles tile-growables y retorna el de mayor monthlyMargin.
function pickBestVentureForTile(obs, actor, tile) {
  let best = null;
  let bestMargin = -Infinity;
  const cash = obs.actor.cash;

  for (const def of PRODUCIBLE_LIST) {
    const wantLock = lockTypeForCategory(def.category);
    if (tile.lockType && wantLock && tile.lockType !== wantLock) continue;

    const setupCost = obs.forecast.setupCost(def.id)
      + (def.requiresPlow ? obs.forecast.plowCost() : 0);
    if (cash < setupCost) continue;

    // Look-ahead pricing: el precio relevante es el ESPERADO a la madurez,
    // no el spot. expectedPriceAt descuenta por pipeline glut.
    const horizon = def.growthDays || 30;
    const priceFuture = obs.forecast.expectedPriceAt(def.id, horizon);
    if (priceFuture <= 0) continue;
    const revPerCycle = priceFuture * def.yieldUnits;
    const harvestCost = obs.forecast.harvestCost(def.id);

    const cyclesPerMonth = def.perennial
      ? 30 / def.perennial.regrowDays
      : 30 / def.growthDays;
    const monthlyMargin = (revPerCycle - harvestCost) * cyclesPerMonth;

    if (monthlyMargin > bestMargin) {
      bestMargin = monthlyMargin;
      best = { def, setupCost, monthlyMargin };
    }
  }
  return best;
}

export function heuristicDecide(obs, actor) {
  const actions = [];
  const cid = obs.actor.countryId;

  // Rule 1 — Tomar loan si cash bajo y hay tiles como colateral implícito.
  if (obs.actor.cash < AI.loanThreshold && obs.actor.ownedTileIds && obs.actor.ownedTileIds.length > 0) {
    actions.push({ action: 'takeLoan', productId: 'workingCapital', amount: AI.loanAmount });
  } else if (obs.actor.cash < AI.loanThreshold && obs.actor.tilesOwned?.length > 0) {
    actions.push({ action: 'takeLoan', productId: 'workingCapital', amount: AI.loanAmount });
  }

  // Rule 2 — Para cada tile fallow propio, pickear la mejor venture y plantar.
  for (const tile of obs.actor.tilesOwned || []) {
    if (tile.state !== 'fallow') continue;
    const choice = pickBestVentureForTile(obs, actor, tile);
    if (!choice || choice.monthlyMargin <= 0) continue;
    if (choice.def.requiresPlow) {
      actions.push({ action: 'plowTile', tileId: tile.id, countryId: tile.countryId });
    }
    actions.push({
      action: 'plantTile',
      tileId: tile.id,
      producibleId: choice.def.id,
      countryId: tile.countryId,
    });
  }

  // Rule 3 — Comprar tierra (con probabilidad AI.buyTileChance). Score
  // simple: quality × 1000 − price × 0.0005, igual que el código histórico.
  if (Math.random() < AI.buyTileChance) {
    const wild = obs.forecast.wildTiles ? obs.forecast.wildTiles() : [];
    let best = null;
    let bestVal = -Infinity;
    for (const t of wild) {
      if (obs.actor.cash < t.price) continue;
      const val = t.quality * 1000 - t.price * 0.0005;
      if (val > bestVal) { bestVal = val; best = t; }
    }
    if (best) {
      actions.push({ action: 'buyTile', tileId: best.id, countryId: cid, mode: 'cash' });
    }
  }

  return actions;
}

// =============================================================================
// Registry
// =============================================================================
export const BRAIN_REGISTRY = {
  idle: idleDecide,
  heuristic: heuristicDecide,
  // Futuras: 'hoarder', 'trader', 'arbitrageur', 'llm', etc.
};

export function decideFor(brainType) {
  return BRAIN_REGISTRY[brainType] || BRAIN_REGISTRY.idle;
}

export function listBrains() {
  return Object.keys(BRAIN_REGISTRY);
}

// PlayerActions — fachada de acciones que un player puede realizar.
//
// Cada export es un wrapper delgado sobre los sistemas existentes. Tanto la UI
// (handlers de botones en Game.js) como cualquier bot (HeuristicBot, LLMBot)
// llaman exclusivamente por esta capa — así un exploit detectado por la IA
// también lo puede reproducir un humano y viceversa (LSP).
//
// Schema de acción serializable (discriminated union, JSON-friendly):
//   { action: 'buyTile',        tileId: 42, countryId: 'home' }
//   { action: 'sellInventory',  producibleId: 'wheat', units: 50, countryId: 'home' }
//   { action: 'buildIndustry',  tileId: 17, recipeId: 'flourMill', countryId: 'home' }
//   { action: 'noop' }
//
// Dispatcher: apply(state, action) → { ok, reason?, ...details }.
// Toda accion retorna SIEMPRE un objeto resultado — nunca lanza. Esto deja
// al bot lidiar con fallas (mercado seco, no hay cash, tile ya tomado, etc.)
// vía control de flujo normal.

import { tileById } from '../state/GameState.js';
import {
  buyTile, plowTile, plantTile, harvestTile, uprootTile, toggleAutoReplant, loteTile,
} from '../systems/Farming.js';
import { applyForLoan } from '../systems/Bank.js';
import { sellFromInventory, buyFromGlobal } from '../systems/Market.js';

// =============================================================================
// Tile lifecycle
// =============================================================================
export function actBuyTile(state, { tileId, countryId, mode = 'cash' }) {
  const tile = tileById(state, countryId, tileId);
  if (!tile) return { ok: false, reason: 'tile not found' };
  return buyTile(state, tile, { mode });
}

export function actPlowTile(state, { tileId, countryId }) {
  const tile = tileById(state, countryId, tileId);
  if (!tile) return { ok: false, reason: 'tile not found' };
  return plowTile(state, tile, 'player');
}

export function actPlantTile(state, { tileId, countryId, producibleId }) {
  const tile = tileById(state, countryId, tileId);
  if (!tile) return { ok: false, reason: 'tile not found' };
  return plantTile(state, tile, producibleId, 'player');
}

export function actHarvestTile(state, { tileId, countryId }) {
  const tile = tileById(state, countryId, tileId);
  if (!tile) return { ok: false, reason: 'tile not found' };
  return harvestTile(state, tile);
}

export function actUprootTile(state, { tileId, countryId }) {
  const tile = tileById(state, countryId, tileId);
  if (!tile) return { ok: false, reason: 'tile not found' };
  return uprootTile(state, tile);
}

export function actToggleAutoReplant(state, { tileId, countryId }) {
  const tile = tileById(state, countryId, tileId);
  if (!tile) return { ok: false, reason: 'tile not found' };
  return toggleAutoReplant(state, tile);
}

export function actLoteTile(state, { tileId, countryId }) {
  const tile = tileById(state, countryId, tileId);
  if (!tile) return { ok: false, reason: 'tile not found' };
  return loteTile(state, tile);
}

// =============================================================================
// Market trading (player wallet only — bots use this same path)
// =============================================================================
export function actSellInventory(state, { producibleId, units, countryId }) {
  return sellFromInventory(state, 'player', producibleId, units, countryId);
}

export function actBuyFromMarket(state, { producibleId, units, countryId }) {
  return buyFromGlobal(state, 'player', producibleId, units, countryId);
}

// =============================================================================
// Banking
// =============================================================================
export function actTakeLoan(state, { productId, amount }) {
  return applyForLoan(state, productId, amount, { borrowerId: 'player' });
}

// =============================================================================
// No-op (bot decides not to act this tick)
// =============================================================================
export function actNoop() {
  return { ok: true, reason: 'noop' };
}

// =============================================================================
// Dispatcher
// =============================================================================
// Discriminated-union dispatch. Adding a new action = new entry in the
// registry; cero cambios al motor o a los drivers (OCP).
export const ACTION_REGISTRY = {
  noop: actNoop,
  buyTile: actBuyTile,
  plowTile: actPlowTile,
  plantTile: actPlantTile,
  harvestTile: actHarvestTile,
  uprootTile: actUprootTile,
  toggleAutoReplant: actToggleAutoReplant,
  loteTile: actLoteTile,
  sellInventory: actSellInventory,
  buyFromMarket: actBuyFromMarket,
  takeLoan: actTakeLoan,
};

export function apply(state, action) {
  if (!action || typeof action !== 'object') {
    return { ok: false, reason: 'action must be an object' };
  }
  const fn = ACTION_REGISTRY[action.action];
  if (!fn) return { ok: false, reason: `unknown action: ${action.action}` };
  try {
    return fn(state, action) ?? { ok: true };
  } catch (err) {
    // Bots never break the loop. We surface the error to the trace so the
    // user can spot which action shape is wrong, but the simulation marches on.
    return { ok: false, reason: `threw: ${err?.message ?? err}` };
  }
}

// List of valid action names — useful when prompting an LLM.
export function listActions() {
  return Object.keys(ACTION_REGISTRY);
}

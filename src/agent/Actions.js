// Actions — fachada de acciones que CUALQUIER actor puede tomar (player o AI).
//
// Cada export es un wrapper delgado sobre los sistemas existentes. Todas las
// acciones aceptan un `ownerId` opcional (default 'player') — el rail es
// agnóstico al ejecutor. Tanto la UI (handlers de botones en Game.js), bots
// (HeuristicBot, LLMBot), como brains de AI farmers llaman exclusivamente por
// esta capa — así un exploit detectado por la IA también lo puede reproducir
// un humano y viceversa (LSP).
//
// Schema de acción serializable (discriminated union, JSON-friendly):
//   { action: 'buyTile',       tileId: 42, countryId: 'home', ownerId: 'home_ai0' }
//   { action: 'sellInventory', producibleId: 'wheat', units: 50, countryId: 'home' }
//   { action: 'plantTile',     tileId: 17, producibleId: 'wheat', countryId: 'home' }
//   { action: 'noop' }
//
// Dispatcher: apply(state, action) → { ok, reason?, ...details }.
// Toda acción retorna SIEMPRE un objeto resultado — nunca lanza.

import { tileById } from '../state/GameState.js';
import {
  buyTile, plowTile, plantTile, harvestTile, uprootTile, toggleAutoReplant,
} from '../systems/Farming.js';
import { applyForLoan } from '../systems/Bank.js';
import { listOnMarket, buyFromMarket } from '../systems/Market.js';

// =============================================================================
// Tile lifecycle
// =============================================================================
export function actBuyTile(state, { tileId, countryId, mode = 'cash', ownerId = 'player' }) {
  const tile = tileById(state, countryId, tileId);
  if (!tile) return { ok: false, reason: 'tile not found' };
  return buyTile(state, tile, { mode, buyerId: ownerId });
}

export function actPlowTile(state, { tileId, countryId, ownerId = 'player' }) {
  const tile = tileById(state, countryId, tileId);
  if (!tile) return { ok: false, reason: 'tile not found' };
  return plowTile(state, tile, ownerId);
}

export function actPlantTile(state, { tileId, countryId, producibleId, ownerId = 'player' }) {
  const tile = tileById(state, countryId, tileId);
  if (!tile) return { ok: false, reason: 'tile not found' };
  return plantTile(state, tile, producibleId, ownerId);
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

// =============================================================================
// Market trading — listing (consignación) y compra
// =============================================================================
export function actSellInventory(state, { producibleId, units, countryId, ownerId = 'player' }) {
  return listOnMarket(state, ownerId, producibleId, units, countryId);
}

export function actBuyFromMarket(state, { producibleId, units, countryId, ownerId = 'player' }) {
  return buyFromMarket(state, ownerId, producibleId, units, countryId);
}

// =============================================================================
// Banking
// =============================================================================
export function actTakeLoan(state, { productId, amount, ownerId = 'player' }) {
  return applyForLoan(state, productId, amount, { borrowerId: ownerId });
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
// Discriminated-union dispatch. Adding a new action = new entry en el registry;
// cero cambios al motor o a los drivers (OCP).
export const ACTION_REGISTRY = {
  noop: actNoop,
  buyTile: actBuyTile,
  plowTile: actPlowTile,
  plantTile: actPlantTile,
  harvestTile: actHarvestTile,
  uprootTile: actUprootTile,
  toggleAutoReplant: actToggleAutoReplant,
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
    return { ok: false, reason: `threw: ${err?.message ?? err}` };
  }
}

// Lista de acciones válidas — útil para prompts a LLM y validators.
export function listActions() {
  return Object.keys(ACTION_REGISTRY);
}

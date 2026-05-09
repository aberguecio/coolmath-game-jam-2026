import { PRODUCIBLES } from '../data/producibles.js';
import { LAND_ACTIONS } from '../data/tunables.js';
import { sellToMarket, harvestToInventory } from './Market.js';
import { PRODUCIBLES as _ } from '../data/producibles.js';
import { applyForLoan, quoteLoan } from './Bank.js';
import { tilePrice, pushLog, pushFx } from '../state/GameState.js';
import { lotePrice, isInsideHalo } from './City.js';
import { growthMultiplier } from './Events.js';
import { canMineHere, mineralRichness } from './Mining.js';

function applyCurve(curve, quality) {
  return (curve?.base ?? 1) + quality * (curve?.qualitySlope ?? 0);
}

export function expectedYield(producible, quality) {
  return Math.round(producible.yieldUnits * applyCurve(producible.yieldCurve, quality));
}

// For minerals, the "quality" feeding yield is the deposit richness, not soil quality.
export function effectiveQualityFor(def, tile) {
  if (def.category === 'mining') return mineralRichness(tile, def.id);
  return tile.quality;
}

// Auto-harvest a mature tile.
//   Player: deposits to player.inventory — no cash yet (sell at the Market modal).
//   AI: sells immediately to keep their decision-making simple.
function autoHarvest(state, tile, def) {
  const units = expectedYield(def, effectiveQualityFor(def, tile));
  tile.lastHarvestDay = state.time.totalDays;

  if (tile.owner === 'player') {
    harvestToInventory(state, 'player', tile.crop, units);
    pushLog(state, `Harvested ${units}u of ${def.name} → inventory`);
    const colorHex = '#' + def.color.toString(16).padStart(6, '0');
    pushFx(state, {
      type: 'popText',
      atTile: tile.id,
      text: `+${units} ${def.name}`,
      color: colorHex,
      duration: 2000,
      rise: 32,
      fontSize: 13,
    });
    pushFx(state, { type: 'bounceTile', tileId: tile.id, scale: 1.15 });
    pushFx(state, { type: 'sfx', kind: 'chime' });
  } else {
    // AI auto-sell. Revenue goes to AI cash; supply hits the AI's COUNTRY pool —
    // not always 'home'. AIs in usa/china/etc. supply their own countries.
    const ai = state.aiFarmers?.find(a => a.id === tile.owner);
    const countryId = ai?.countryId ?? tile.countryId ?? 'home';
    const revenue = sellToMarket(state, tile.crop, units, countryId);
    if (ai) ai.cash += revenue;
  }

  if (def.perennial) {
    // Perennials regrow by themselves — loop flag has no effect here.
    tile.state = 'cosechado';
    tile.growth = 0;
  } else {
    // Annual — clear the tile, then optionally re-plow + re-plant if loop is on.
    const lastCrop = tile.crop;
    tile.state = 'fallow';
    tile.crop = null;
    tile.growth = 0;
    if (tile.autoReplant) {
      const replanted = tryAutoReplant(state, tile, lastCrop);
      if (!replanted && tile.owner === 'player') {
        pushLog(state, `Loop paused on (${tile.x},${tile.y}) — couldn't replant ${def.name}.`);
      }
    }
  }
}

function tryAutoReplant(state, tile, producibleId) {
  const def = PRODUCIBLES[producibleId];
  if (!def) return false;
  const wallet = tile.owner === 'player'
    ? state.player
    : state.aiFarmers?.find(a => a.id === tile.owner);
  if (!wallet) return false;
  const setupCost = (def.requiresPlow ? LAND_ACTIONS.plow.cost : 0) + def.seedCost;
  if (wallet.cash < setupCost) return false;
  wallet.cash -= setupCost;
  tile.state = 'planted';
  tile.crop = producibleId;
  tile.growth = 0;
  tile.plantedDay = state.time.totalDays;
  tile.ageDays = 0;
  if (tile.owner === 'player') {
    pushLog(state, `Looped: replanted ${def.name} at (${tile.x},${tile.y})`);
    pushFx(state, { type: 'sfx', kind: 'plant' });
  }
  return true;
}

export function tickFarming(state) {
  // Iterate every country's map — AI farmers in foreign maps grow & harvest too.
  const countryIds = Object.keys(state.maps || {});
  for (const cid of countryIds) {
    for (const tile of state.maps[cid].tiles) {
      tickFarmingTile(state, tile);
    }
  }
}

function tickFarmingTile(state, tile) {
    if (!tile.crop) return;
    if (tile.industryId) return;          // industry tiles aren't farmed
    if (tile.owner === 'wild' || tile.owner === 'developer' || tile.owner === 'city') return;
    const def = PRODUCIBLES[tile.crop];
    if (!def) return;
    tile.ageDays += 1;

    if (tile.state === 'planted') {
      const envMult = growthMultiplier(state);
      const dailyGrowth = (1 / def.growthDays) * applyCurve(def.growthCurve, tile.quality) * envMult;
      tile.growth = Math.min(1, tile.growth + dailyGrowth);
      if (tile.growth >= 1) {
        tile.state = 'mature';
        autoHarvest(state, tile, def);
      }
    } else if (def.perennial && tile.state === 'cosechado') {
      const since = state.time.totalDays - tile.lastHarvestDay;
      if (since >= def.perennial.regrowDays) {
        tile.state = 'mature';
        tile.growth = 1;
        autoHarvest(state, tile, def);
      }
      if (tile.ageDays > def.perennial.lifespanDays) {
        tile.state = 'fallow';
        tile.crop = null;
        tile.growth = 0;
        if (tile.owner === 'player') {
          pushLog(state, `${def.name} at (${tile.x},${tile.y}) reached end of life.`);
        }
      }
    }
}

// opts = { mode: 'cash' | 'finance' }
export function buyTile(state, tile, opts = {}) {
  const mode = opts.mode || 'cash';
  if (tile.owner !== 'wild') return { ok: false, reason: 'Not available' };
  const cost = tilePrice(tile, state);

  if (mode === 'cash') {
    if (state.player.cash < cost) return { ok: false, reason: 'Not enough cash' };
    state.player.cash -= cost;
    tile.owner = 'player';
    pushLog(state, `Bought tile (${tile.x},${tile.y}) for $${cost} cash`);
    pushFx(state, { type: 'sfx', kind: 'thump' });
    pushFx(state, { type: 'bounceTile', tileId: tile.id, scale: 1.2 });
    return { ok: true, cost, mode };
  }

  if (mode === 'finance') {
    const r = applyForLoan(state, 'landFinance', cost, { collateralTileId: tile.id });
    if (!r.ok) return { ok: false, reason: r.reason };
    state.player.cash -= r.loan.balance;
    tile.owner = 'player';
    pushLog(state,
      `Financed tile (${tile.x},${tile.y}) — $${r.loan.principal} ` +
      `($${Math.round(r.loan.principal - r.loan.balance)} down, ` +
      `$${Math.round(r.loan.monthlyPayment)}/mo × ${r.loan.termMonths}mo)`,
    );
    pushFx(state, { type: 'sfx', kind: 'thump' });
    pushFx(state, { type: 'bounceTile', tileId: tile.id, scale: 1.2 });
    return { ok: true, cost, mode, loanId: r.loan.id };
  }

  return { ok: false, reason: 'Unknown mode' };
}

// Quote what financing would look like for this tile (used by UI).
export function tileFinanceQuote(state, tile) {
  return quoteLoan(state, 'landFinance', tilePrice(tile, state), { collateralTileId: tile.id });
}

export function plowTile(state, tile) {
  if (tile.owner !== 'player') return { ok: false };
  const action = LAND_ACTIONS.plow;
  if (tile.state !== action.fromState) return { ok: false, reason: 'Can only plow fallow land' };
  if (state.player.cash < action.cost) return { ok: false, reason: 'Not enough cash' };
  state.player.cash -= action.cost;
  tile.state = action.toState;
  pushFx(state, { type: 'sfx', kind: 'plow' });
  return { ok: true };
}

export function plantTile(state, tile, producibleId) {
  if (tile.owner !== 'player') return { ok: false };
  const def = PRODUCIBLES[producibleId];
  if (!def) return { ok: false, reason: 'Unknown producible' };
  const requiredState = def.requiresPlow ? 'plowed' : 'fallow';
  if (tile.state !== requiredState) {
    return { ok: false, reason: def.requiresPlow ? 'Plow first' : 'Tile not ready' };
  }
  if (def.category === 'mining' && !canMineHere(tile, def)) {
    return { ok: false, reason: tile.surveyed ? 'No deposit here' : 'Survey the tile first' };
  }
  if (state.player.cash < def.seedCost) return { ok: false, reason: 'Not enough cash' };
  state.player.cash -= def.seedCost;
  tile.state = 'planted';
  tile.crop = producibleId;
  tile.growth = 0;
  tile.plantedDay = state.time.totalDays;
  tile.ageDays = 0;
  pushLog(state, `Planted ${def.name} at (${tile.x},${tile.y})`);
  pushFx(state, { type: 'sfx', kind: 'plant' });
  return { ok: true };
}

// Toggle the auto-replant loop on a tile. Only applies to annual crops; perennials
// auto-regrow by definition so loop is moot for them.
export function toggleAutoReplant(state, tile) {
  if (tile.owner !== 'player') return { ok: false };
  if (!tile.crop) return { ok: false, reason: 'No crop to loop' };
  const def = PRODUCIBLES[tile.crop];
  if (!def || def.perennial) return { ok: false, reason: 'Not an annual crop' };
  tile.autoReplant = !tile.autoReplant;
  pushLog(state, `Loop ${tile.autoReplant ? 'ON' : 'OFF'} on (${tile.x},${tile.y}) — ${def.name}`);
  return { ok: true };
}

export function harvestTile(state, tile) {
  if (tile.owner !== 'player') return { ok: false };
  if (tile.state !== 'mature') return { ok: false, reason: 'Not yet mature' };
  const def = PRODUCIBLES[tile.crop];
  const units = expectedYield(def, effectiveQualityFor(def, tile));
  const revenue = sellToMarket(state, tile.crop, units);
  state.player.cash += revenue;
  tile.lastHarvestDay = state.time.totalDays;

  if (def.perennial) {
    tile.state = 'cosechado';
    tile.growth = 0;
  } else {
    tile.state = 'fallow';
    tile.crop = null;
    tile.growth = 0;
  }
  pushLog(state, `Harvested ${units}u of ${def.name} → $${revenue}`);
  return { ok: true, units, revenue };
}

export function loteTile(state, tile) {
  if (tile.owner !== 'player') return { ok: false, reason: 'Not yours' };
  if (tile.state === 'planted' || tile.state === 'mature') {
    return { ok: false, reason: 'Active crop on tile' };
  }
  const city = state.cities?.[tile.countryId] ?? state.city;
  if (!isInsideHalo(tile, city)) return { ok: false, reason: 'Too far from city' };
  const price = lotePrice(tile, city);
  if (price <= 0) return { ok: false, reason: 'No demand' };
  state.player.cash += price;
  tile.owner = 'developer';
  tile.state = 'lot';
  tile.crop = null;
  pushLog(state, `Developed (${tile.x},${tile.y}) → $${price}`);
  pushFx(state, { type: 'sfx', kind: 'chime' });
  pushFx(state, {
    type: 'coins', from: { tileId: tile.id }, to: 'cash',
    count: 6, value: price, color: 0xffd166,
  });
  return { ok: true, revenue: price };
}

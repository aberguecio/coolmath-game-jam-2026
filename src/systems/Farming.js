import { PRODUCIBLES } from '../data/producibles.js';
import { LAND_ACTIONS, FISCAL_CRISIS, FARMING } from '../data/tunables.js';
import { harvestToInventory, listOnMarket } from './Market.js';
import { applyForLoan, quoteLoan, walletFor } from './Bank.js';
import { tilePrice, pushLog, pushFx } from '../state/GameState.js';
import { growthMultiplier } from './Events.js';
import {
  effectiveHarvestCost, effectivePlowCost,
  effectiveSetupCost, setupCostSplit,
} from './Inflation.js';

function applyCurve(curve, quality) {
  return (curve?.base ?? 1) + quality * (curve?.qualitySlope ?? 0);
}

export function expectedYield(producible, quality) {
  return Math.round(producible.yieldUnits * applyCurve(producible.yieldCurve, quality));
}

export function effectiveQualityFor(_def, tile) {
  return tile.quality;
}

// Pay harvest labor: owner cash → country.wageFund. Returns true if paid (or
// not required), false if the owner couldn't afford it (skip the harvest).
function payHarvestLabor(state, tile, def) {
  const wallet = walletFor(state, tile.owner);
  if (!wallet) return true;                       // wild/city/dev — no labor flow
  const cost = effectiveHarvestCost(state, tile.countryId, def);
  if (cost <= 0) return true;
  if (wallet.cash < cost) return false;
  wallet.cash -= cost;
  const country = state.countries[tile.countryId];
  if (country) {
    const haircut = country.fiscalCrisis?.active ? FISCAL_CRISIS.wageHaircutFraction : 0;
    country.wageFund += cost * (1 - haircut);
  }
  return true;
}

// Auto-harvest a mature tile (auto-mode owner OR AI). Charges labor cost; if the
// owner can't afford it, the tile stays mature and waits for next attempt.
//   Player: deposits to player.inventory — no cash yet (sell at the Market modal).
//   AI: sells immediately to keep their decision-making simple.
function autoHarvest(state, tile, def) {
  // Profit gate: don't auto-harvest at a loss. Estimate revenue (price × yield)
  // and compare to the labor cost × profitMargin. If unprofitable, skip and
  // leave the tile mature — it may become rentable later, or rot via grace
  // period if the slump continues. AI uses tile.skipStreak to decide if it
  // should uproot a perennial that keeps getting skipped.
  const units = expectedYield(def, effectiveQualityFor(def, tile));
  const harvestCost = effectiveHarvestCost(state, tile.countryId, def);
  const priceNow = Math.round(state.market.prices?.[tile.countryId]?.[def.id] || 0);
  const revenueEst = priceNow * units;
  if (harvestCost > 0 && revenueEst < harvestCost * FARMING.harvestProfitMargin) {
    tile.skipStreak = (tile.skipStreak || 0) + 1;
    // AI: a chronically-skipped perennial blocks the tile forever; uproot so it
    // can be replaced with something profitable.
    const isAI = tile.owner?.includes?.('_ai');
    if (isAI && def.perennial && (tile.skipStreak + (tile.lossStreak || 0)) >= 3) {
      const ai = state.aiFarmers?.find(a => a.id === tile.owner);
      pushLog(state, `${ai?.name ?? tile.owner} uprooted ${def.name} on (${tile.x},${tile.y}) — price too low for 3+ cycles.`);
      uprootTile(state, tile);
    }
    return;                                       // tile stays mature, may rot later
  }

  if (!payHarvestLabor(state, tile, def)) {
    // Owner is broke — leave mature, will retry next tick.
    return;
  }
  tile.skipStreak = 0;                            // successful harvest path resets
  tile.lastHarvestDay = state.time.totalDays;
  tile.matureSinceDay = null;                     // clear grace timer

  if (tile.owner === 'player') {
    harvestToInventory(state, 'player', tile.crop, units, tile.countryId);
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
    // AI cosecha → deposita en su wallet → INMEDIATAMENTE lista al market.
    // Sin ventana de hoarding entre harvest y el tick semanal de aiTrySellInventory.
    // Respeta keepFraction del AI (default 0 = lista todo; personalidades futuras
    // pueden setear distinto para retener una fracción).
    const ai = state.aiFarmers?.find(a => a.id === tile.owner);
    if (ai) {
      harvestToInventory(state, ai.id, tile.crop, units, tile.countryId);
      const keep = Math.max(0, Math.min(1, ai.keepFraction ?? 0));
      const listQty = Math.floor(units * (1 - keep));
      if (listQty > 0) listOnMarket(state, ai.id, tile.crop, listQty, tile.countryId);
    }
    // Profitability streak: AI counts how many consecutive harvests would
    // have lost money at current spot prices. For perennials, after 2 lost
    // cycles in a row, uproot so the tile can be replanted with something
    // more lucrative. Use current spot price as proxy for revenue at time of
    // harvest (actual sale revenue depends on when aiTrySellInventory fires).
    const cid = ai?.countryId ?? tile.countryId ?? 'home';
    const spot = state.market.prices?.[cid]?.[tile.crop] || 0;
    const revenueAtHarvest = spot * units;
    if (revenueAtHarvest < harvestCost) {
      tile.lossStreak = (tile.lossStreak || 0) + 1;
    } else {
      tile.lossStreak = 0;
    }
    if (def.perennial && (tile.lossStreak || 0) >= 2) {
      pushLog(state, `${ai?.name ?? tile.owner} uprooted ${def.name} on (${tile.x},${tile.y}) — 2 unprofitable cycles.`);
      uprootTile(state, tile);
      return;        // tile is now fallow with lockType preserved
    }
  }

  if (def.perennial) {
    // Perennials regrow by themselves — autoMode covers the harvest cost only.
    tile.state = 'cosechado';
    tile.growth = 0;
  } else {
    // Annual — clear the tile and (when in auto-mode) try to replant. If the
    // replant fails due to cash, leave `tile.lastCrop` so the farming tick can
    // retry on a later day once funds are back.
    const lastCrop = tile.crop;
    tile.lastCrop = lastCrop;
    tile.state = 'fallow';
    tile.crop = null;
    tile.growth = 0;
    if (tile.autoMode) {
      const replanted = tryAutoReplant(state, tile, lastCrop);
      if (!replanted && tile.owner === 'player') {
        pushLog(state, `Auto-manage paused on (${tile.x},${tile.y}) — couldn't replant ${def.name}. Will retry.`);
      }
    }
  }
}

function tryAutoReplant(state, tile, producibleId) {
  const def = PRODUCIBLES[producibleId];
  if (!def) return false;
  // If the crop needs plowing, plow first (auto-mode hires labor for both).
  if (def.requiresPlow && tile.state === 'fallow') {
    const r = plowTile(state, tile, tile.owner);
    if (!r.ok) return false;
  }
  const r = plantTile(state, tile, producibleId, tile.owner);
  return r.ok;
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
    // Auto-replant retry: if this tile is a fallow auto-managed crop tile that
    // failed its replant earlier (cash shortage), try again now. This closes
    // the hole where one missed replant froze the loop forever.
    if (!tile.crop && tile.state === 'fallow' && tile.autoMode && tile.lastCrop
        && (tile.owner === 'player' || tile.owner?.includes?.('_ai'))) {
      tryAutoReplant(state, tile, tile.lastCrop);
    }
    if (!tile.crop) return;
    if (tile.owner === 'wild' || tile.owner === 'developer' || tile.owner === 'city') return;
    const def = PRODUCIBLES[tile.crop];
    if (!def) return;
    tile.ageDays += 1;

    // Auto-harvest fires only for AI farmers OR player tiles with autoMode on.
    // Without autoMode the tile sits at 'mature' and waits for the player's
    // manual harvest click (no labor cost in that path).
    const autoFire = tile.owner !== 'player' || tile.autoMode === true;

    if (tile.state === 'planted') {
      const envMult = growthMultiplier(state);
      const dailyGrowth = (1 / def.growthDays) * applyCurve(def.growthCurve, tile.quality) * envMult;
      tile.growth = Math.min(1, tile.growth + dailyGrowth);
      if (tile.growth >= 1) {
        tile.state = 'mature';
        tile.matureSinceDay = state.time.totalDays;
        if (autoFire) autoHarvest(state, tile, def);
      }
    } else if (tile.state === 'mature') {
      // Grace-period rot/regrow. If the mature tile sits too long unharvested,
      // an annual rots (lockType preserved) and a perennial falls back to
      // 'cosechado' losing this cycle's fruit but keeping the plant alive.
      if (tile.matureSinceDay != null) {
        const sinceMature = state.time.totalDays - tile.matureSinceDay;
        if (sinceMature > FARMING.harvestGraceDays) {
          if (def.perennial) {
            tile.state = 'cosechado';
            tile.lastHarvestDay = tile.matureSinceDay;
            tile.growth = 0;
            tile.matureSinceDay = null;
            if (tile.owner === 'player') {
              pushLog(state, `${def.name} on (${tile.x},${tile.y}) skipped — fruit lost, tree survives.`);
            }
          } else {
            tile.state = 'fallow';
            tile.lastCrop = tile.crop;   // remember for retry-replant
            tile.crop = null;
            tile.growth = 0;
            tile.matureSinceDay = null;
            if (tile.owner === 'player') {
              pushLog(state, `${def.name} on (${tile.x},${tile.y}) rotted — never harvested.`);
            }
            return;
          }
        }
      }
      // Still mature after the grace check — try the auto-harvest path so
      // recently-skipped tiles get re-evaluated next tick (price may recover).
      if (autoFire) autoHarvest(state, tile, def);
    } else if (def.perennial && tile.state === 'cosechado') {
      const since = state.time.totalDays - tile.lastHarvestDay;
      if (since >= def.perennial.regrowDays) {
        tile.state = 'mature';
        tile.matureSinceDay = state.time.totalDays;
        tile.growth = 1;
        if (autoFire) autoHarvest(state, tile, def);
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
  const buyerId = opts.buyerId || 'player';
  if (tile.owner !== 'wild') return { ok: false, reason: 'Not available' };
  const cost = tilePrice(tile, state);
  const wallet = walletFor(state, buyerId);
  if (!wallet) return { ok: false, reason: 'No wallet for buyer' };

  if (mode === 'cash') {
    if (wallet.cash < cost) return { ok: false, reason: 'Not enough cash' };
    wallet.cash -= cost;
    tile.owner = buyerId;
    if (buyerId === 'player') {
      pushLog(state, `Bought tile (${tile.x},${tile.y}) for $${cost} cash`);
      pushFx(state, { type: 'sfx', kind: 'thump' });
      pushFx(state, { type: 'bounceTile', tileId: tile.id, scale: 1.2 });
    }
    // Si el buyer es un AI farmer, agregar el tile a su ownedTileIds para
    // que el motor lo trate como suyo.
    if (buyerId !== 'player') {
      const ai = state.aiFarmers?.find(a => a.id === buyerId);
      if (ai && !ai.ownedTileIds.includes(tile.id)) ai.ownedTileIds.push(tile.id);
    }
    return { ok: true, cost, mode };
  }

  if (mode === 'finance') {
    // Finance sólo para player por ahora (loans con collateralTileId).
    if (buyerId !== 'player') return { ok: false, reason: 'Finance only for player' };
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

// Shared cash router for setup costs. Splits the total into labor (→ wageFund,
// with crisis haircut) and commodity (→ marketPool). Used by plant/plow/survey.
function payLaborAndCommodity(state, wallet, cid, labor, commodity) {
  wallet.cash -= (labor + commodity);
  const country = state.countries[cid];
  if (!country) return;
  const haircut = country.fiscalCrisis?.active ? FISCAL_CRISIS.wageHaircutFraction : 0;
  if (labor > 0) country.wageFund += labor * (1 - haircut);
  if (commodity > 0) country.marketPool += commodity;
}

export function plowTile(state, tile, ownerId = 'player') {
  if (tile.owner !== ownerId) return { ok: false };
  const action = LAND_ACTIONS.plow;
  if (tile.state !== action.fromState) return { ok: false, reason: 'Can only plow fallow land' };
  if (tile.lockType && tile.lockType !== 'crop') {
    return { ok: false, reason: `Tile locked to ${tile.lockType}` };
  }
  const wallet = walletFor(state, ownerId);
  if (!wallet) return { ok: false, reason: 'Wallet missing' };
  const cost = effectivePlowCost(state, tile.countryId);
  if (wallet.cash < cost) return { ok: false, reason: 'Not enough cash' };
  payLaborAndCommodity(state, wallet, tile.countryId, cost, 0);
  tile.state = action.toState;
  if (ownerId === 'player') pushFx(state, { type: 'sfx', kind: 'plow' });
  return { ok: true, cost };
}

// Producible category → tile lockType. Once a tile commits to a category it
// stays committed; future plant calls must match.
export function lockTypeForCategory(category) {
  if (category === 'annual_crop' || category === 'perennial_crop') return 'crop';
  return null;                                  // 'processed' → not plantable
}

// Open a venture on a tile (plant a crop, open a mine). Unified for player and
// AI — they pass their own ownerId. Cost composition: labor (→ wageFund) plus
// commodity portion for crops only (0.1 units of seed → marketPool).
export function plantTile(state, tile, producibleId, ownerId = 'player') {
  if (tile.owner !== ownerId) return { ok: false };
  const def = PRODUCIBLES[producibleId];
  if (!def) return { ok: false, reason: 'Unknown producible' };
  const requiredState = def.requiresPlow ? 'plowed' : 'fallow';
  if (tile.state !== requiredState) {
    return { ok: false, reason: def.requiresPlow ? 'Plow first' : 'Tile not ready' };
  }
  const wantLock = lockTypeForCategory(def.category);
  if (tile.lockType && wantLock && tile.lockType !== wantLock) {
    return { ok: false, reason: `Tile locked to ${tile.lockType}` };
  }
  const wallet = walletFor(state, ownerId);
  if (!wallet) return { ok: false, reason: 'Wallet missing' };
  const { labor, commodity, total } = setupCostSplit(state, tile.countryId, def);
  if (wallet.cash < total) return { ok: false, reason: 'Not enough cash' };
  payLaborAndCommodity(state, wallet, tile.countryId, labor, commodity);
  tile.state = 'planted';
  tile.crop = producibleId;
  tile.growth = 0;
  tile.plantedDay = state.time.totalDays;
  tile.ageDays = 0;
  tile.skipStreak = 0;
  tile.lossStreak = 0;
  if (!tile.lockType) tile.lockType = wantLock;
  if (ownerId === 'player') {
    pushLog(state, `Planted ${def.name} at (${tile.x},${tile.y}) — $${total}`);
    pushFx(state, { type: 'sfx', kind: 'plant' });
  }
  return { ok: true, cost: total };
}

// Universal uproot: rip out any venture on the tile so the tile can be reused.
// Works for crops (any growth state, perennial included), mines (any status),
// and industries (clears + removes the industry record). The tile.lockType is
// PRESERVED — once committed to a category, it stays that category forever.
export function uprootTile(state, tile) {
  if (!tile) return { ok: false, reason: 'No tile' };
  if (tile.owner === 'wild' || tile.owner === 'developer' || tile.owner === 'city') {
    return { ok: false, reason: 'Not yours' };
  }
  const lastDef = tile.crop ? PRODUCIBLES[tile.crop] : null;
  tile.crop = null;
  tile.state = 'fallow';
  tile.growth = 0;
  tile.plantedDay = null;
  tile.ageDays = 0;
  tile.lastCrop = null;        // also clear so auto-replant retry doesn't fire
  tile.autoReplant = false;
  // autoMode is a user preference; keep it.
  if (tile.owner === 'player' && lastDef) {
    pushLog(state, `Uprooted ${lastDef.name} on (${tile.x},${tile.y}).`);
    pushFx(state, { type: 'sfx', kind: 'plow' });
  }
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
  const cropId = tile.crop;
  const def = PRODUCIBLES[cropId];
  const units = expectedYield(def, effectiveQualityFor(def, tile));
  // SOLID/LSP: misma ruta que la AI — la cosecha aterriza en el inventario
  // del player y se lista en el market vía consignación. El cash llega cuando
  // alguien compre. Si no se quiere auto-listar (manual harvest), las unidades
  // quedan en inventario del player.
  harvestToInventory(state, 'player', cropId, units, tile.countryId);
  tile.lastHarvestDay = state.time.totalDays;
  tile.matureSinceDay = null;                       // clear grace timer
  tile.skipStreak = 0;

  if (def.perennial) {
    tile.state = 'cosechado';
    tile.growth = 0;
  } else {
    tile.state = 'fallow';
    tile.crop = null;
    tile.growth = 0;
  }

  // Auto-list al market (consignación). Cash llega cuando se compre.
  const r = listOnMarket(state, 'player', cropId, units, tile.countryId);
  if (r.ok) {
    pushLog(state, `Harvested ${units}u of ${def.name} → listed in market`);
    return { ok: true, units, listed: r.units };
  }
  pushLog(state, `Harvested ${units}u of ${def.name} → kept in inventory (${r.reason})`);
  return { ok: true, units, revenue: 0, kept: true };
}


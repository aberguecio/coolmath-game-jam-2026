// Industries — build/cycle/salary lifecycle for factories on halo tiles.
//
// Each entry in state.industries:
//   { id, ownerId, countryId, tileId, recipeId, status,
//     startBuildDay, operationalDay, lastCycleDay, lastSalaryMonth, closedOnDay }
// status: 'building' | 'operational' | 'idle' | 'closed'
//
// AI behaviours (build/close/reopen/topup/sell) live in IndustryAI.js.
// Fiscal crisis state machine lives in FiscalCrisis.js.
// Day-zero seeding lives in WorldSeed.js.

import { INDUSTRIES } from '../data/industries.js';
import { PRODUCIBLES } from '../data/producibles.js';
import { FISCAL_CRISIS, INDUSTRY } from '../data/tunables.js';
import { pushLog, pushFx, isHaloTile } from '../state/GameState.js';
import { walletFor } from './Bank.js';
import { executeTransaction } from './Transactions.js';
import { effectiveSalary, effectiveBuildCost } from './Inflation.js';

let _nextId = 1;
export function nextIndustryId() { return `ind_${_nextId++}`; }

// =============================================================================
// Construction
// =============================================================================
export function canBuildIndustryHere(state, ownerId, tile, recipeId) {
  if (!INDUSTRIES[recipeId]) return { ok: false, reason: 'Unknown recipe' };
  if (!tile) return { ok: false, reason: 'No tile' };
  if (tile.owner !== ownerId) return { ok: false, reason: 'Not yours' };
  if (tile.industryId) return { ok: false, reason: 'Tile already has an industry' };
  if (!isHaloTile(state, tile)) return { ok: false, reason: 'Must be a city halo tile' };
  // Land lock-in: a tile previously used for crops or mining can't host an industry.
  if (tile.lockType && tile.lockType !== 'industry') {
    return { ok: false, reason: `Tile locked to ${tile.lockType}` };
  }
  return { ok: true };
}

export function buildIndustry(state, ownerId, tile, recipeId) {
  const check = canBuildIndustryHere(state, ownerId, tile, recipeId);
  if (!check.ok) return check;
  const recipe = INDUSTRIES[recipeId];
  const wallet = walletFor(state, ownerId);
  if (!wallet) return { ok: false, reason: 'Wallet missing' };
  const buildCost = effectiveBuildCost(state, tile.countryId, recipe);
  if (wallet.cash < buildCost) return { ok: false, reason: 'Not enough cash' };
  wallet.cash -= buildCost;
  const id = nextIndustryId();
  state.industries.push({
    id, ownerId, countryId: tile.countryId,
    tileId: tile.id, recipeId,
    status: 'building',
    startBuildDay: state.time.totalDays,
    operationalDay: null,
    lastCycleDay: null,
    lastSalaryMonth: null,
  });
  tile.industryId = id;
  tile.state = 'industry';
  tile.lockType = 'industry';                       // permanent — survives close/uproot
  if (ownerId === 'player') {
    pushLog(state, `Started building ${recipe.name} at (${tile.x},${tile.y})`);
    pushFx(state, { type: 'sfx', kind: 'thump' });
    pushFx(state, { type: 'bounceTile', tileId: tile.id, scale: 1.3 });
  }
  return { ok: true, industryId: id };
}

export function closeIndustry(state, industryId) {
  const ind = state.industries.find(i => i.id === industryId);
  if (!ind) return { ok: false, reason: 'Not found' };
  ind.status = 'closed';
  ind.closedOnDay = state.time.totalDays;
  if (ind.ownerId === 'player') pushLog(state, `Closed industry at tile ${ind.tileId}.`);
  return { ok: true };
}

export function reopenIndustry(state, industryId) {
  const ind = state.industries.find(i => i.id === industryId);
  if (!ind) return { ok: false, reason: 'Not found' };
  if (ind.status !== 'closed') return { ok: false, reason: 'Not closed' };
  const recipe = INDUSTRIES[ind.recipeId];
  const wallet = walletFor(state, ind.ownerId);
  if (!wallet) return { ok: false, reason: 'Wallet missing' };
  // Reopens are discounted vs fresh builds — facility exists, just restart capital.
  const reopenCost = Math.round(effectiveBuildCost(state, ind.countryId, recipe) * INDUSTRY.reopenCostFactor);
  if (wallet.cash < reopenCost) return { ok: false, reason: 'Not enough cash' };
  wallet.cash -= reopenCost;
  ind.status = 'building';
  ind.startBuildDay = state.time.totalDays;
  if (ind.ownerId === 'player') pushLog(state, `Reopening ${recipe.name} ($${reopenCost})…`);
  return { ok: true };
}

// =============================================================================
// Daily tick — handle build completion + production cycles
// =============================================================================
export function tickIndustries(state) {
  for (const ind of state.industries) {
    const recipe = INDUSTRIES[ind.recipeId];
    if (!recipe) continue;

    if (ind.status === 'building') {
      if (state.time.totalDays - ind.startBuildDay >= recipe.buildDays) {
        ind.status = 'operational';
        ind.operationalDay = state.time.totalDays;
        ind.lastCycleDay = state.time.totalDays;
        if (ind.ownerId === 'player') {
          pushLog(state, `${recipe.name} is now operational!`);
          pushFx(state, { type: 'sfx', kind: 'chime' });
        }
      }
      continue;
    }

    if (ind.status === 'closed') continue;

    const sinceCycle = state.time.totalDays - (ind.lastCycleDay ?? state.time.totalDays);
    if (sinceCycle < recipe.cycleDays) {
      // Don't lie about status — leave it whatever it was. 'idle' stays 'idle'
      // until the next cycle attempt actually succeeds.
      continue;
    }

    const wallet = walletFor(state, ind.ownerId);
    if (!wallet) { ind.status = 'idle'; continue; }
    if (!wallet.inventory) wallet.inventory = {};
    const isPlayer = ind.ownerId === 'player';
    const cid = ind.countryId;

    // 1. Ensure inputs are available. Player must stock manually; AI auto-buys.
    let allInputs = true;
    for (const [pid, qty] of Object.entries(recipe.inputs)) {
      const have = wallet.inventory[pid] || 0;
      if (have >= qty) continue;
      if (isPlayer) { allInputs = false; break; }
      const need = qty - have;
      const stock = state.market.inventory?.[cid]?.[pid] || 0;
      const price = state.market.prices?.[cid]?.[pid] || 0;
      if (price <= 0 || stock < need || wallet.cash < price * need * 1.2) {
        allInputs = false; break;
      }
      const r = executeTransaction(state, {
        sellerId: 'foreign', buyerId: ind.ownerId,
        productId: pid, units: need, unitPrice: price,
        countryOfTransaction: cid, sellerCountryId: cid,
        type: 'b2b',
      });
      if (!r.ok) { allInputs = false; break; }
      state.market.inventory[cid][pid] -= need;
      wallet.inventory[pid] = (wallet.inventory[pid] || 0) + need;
    }
    if (!allInputs) { ind.status = 'idle'; continue; }

    // 2. Consume inputs
    for (const [pid, qty] of Object.entries(recipe.inputs)) {
      wallet.inventory[pid] -= qty;
    }

    // 3. Produce outputs. Player keeps in inventory; AI auto-sells to market.
    for (const [pid, qty] of Object.entries(recipe.outputs)) {
      if (isPlayer) {
        wallet.inventory[pid] = (wallet.inventory[pid] || 0) + qty;
      } else {
        const price = state.market.prices?.[cid]?.[pid] || 0;
        if (price <= 0) {
          wallet.inventory[pid] = (wallet.inventory[pid] || 0) + qty;
          continue;
        }
        const r = executeTransaction(state, {
          sellerId: ind.ownerId, buyerId: 'foreign',
          productId: pid, units: qty, unitPrice: price,
          countryOfTransaction: cid, sellerCountryId: cid,
          type: 'b2b',
        });
        if (r.ok) {
          const country = state.countries[cid];
          if (country) country.supplyToday[pid] = (country.supplyToday[pid] || 0) + qty;
        } else {
          // Sale failed (saturated market) — keep stock for monthly auto-sell.
          wallet.inventory[pid] = (wallet.inventory[pid] || 0) + qty;
        }
      }
    }

    ind.status = 'operational';
    ind.lastCycleDay = state.time.totalDays;
    if (isPlayer) {
      const out = Object.keys(recipe.outputs)[0];
      const def = PRODUCIBLES[out];
      const tile = state.maps[ind.countryId].tiles[ind.tileId];
      if (tile && def) {
        pushFx(state, {
          type: 'popText', atTile: tile.id, text: `+${recipe.outputs[out]} ${def.name}`,
          color: '#' + def.color.toString(16).padStart(6, '0'),
          duration: 1500, rise: 28, fontSize: 11,
        });
      }
    }
  }
}

// =============================================================================
// Monthly tick — pay salaries; close industry if owner can't afford.
// Crisis: salary contribution to wageFund is haircut.
// =============================================================================
export function tickIndustrySalaries(state) {
  const monthKey = `${state.time.year}-${state.time.month}`;
  for (const ind of state.industries) {
    if (ind.status === 'closed' || ind.status === 'building') continue;
    if (ind.lastSalaryMonth === monthKey) continue;
    const recipe = INDUSTRIES[ind.recipeId];
    if (!recipe) continue;
    const wallet = walletFor(state, ind.ownerId);
    if (!wallet) {
      ind.status = 'closed';
      ind.closedOnDay = state.time.totalDays;
      continue;
    }
    const country = state.countries[ind.countryId];
    if (!country) continue;
    const salary = effectiveSalary(state, ind.countryId, recipe);
    if (wallet.cash < salary) {
      ind.status = 'closed';
      ind.closedOnDay = state.time.totalDays;
      if (ind.ownerId === 'player') {
        pushLog(state, `${recipe.name} closed — couldn't pay salary $${salary}.`);
      }
      continue;
    }
    const haircut = country.fiscalCrisis?.active
      ? FISCAL_CRISIS.wageHaircutFraction
      : 0;
    wallet.cash -= salary;
    country.wageFund += salary * (1 - haircut);
    ind.lastSalaryMonth = monthKey;
    if (ind.ownerId === 'player') {
      pushLog(state, `${recipe.name} salary -$${salary}.`);
    }
  }
}

// =============================================================================
// Re-exports for callers that historically imported everything from Industries.
// =============================================================================
export { tickFiscalCrisis } from './FiscalCrisis.js';
export { seedStarterProduction, seedIndustries } from './WorldSeed.js';
export {
  aiTryBuildIndustry, aiTryCloseIndustry, aiTryReopenIndustry,
  aiTopUpIndustryInputs, aiSellIndustryOutputs,
} from './IndustryAI.js';

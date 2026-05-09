// Industries system — build/cycle/salary lifecycle for factories on halo tiles.
//
// Each entry in state.industries:
//   { id, ownerId, countryId, tileId, recipeId, status, startBuildDay, lastSalaryMonth,
//     lastCycleDay }
// status: 'building' | 'operational' | 'idle' | 'closed'

import { INDUSTRIES, INDUSTRY_LIST } from '../data/industries.js';
import { PRODUCIBLES } from '../data/producibles.js';
import { COUNTRY_IDS, COUNTRIES } from '../data/countries.js';
import { FISCAL_CRISIS, INDUSTRY } from '../data/tunables.js';
import { pushLog, pushFx, pushAIDecision, isHaloTile, getHaloTileIds } from '../state/GameState.js';
import { walletFor } from './Bank.js';
import {
  sellToMarket, executeTransaction, priceMA,
  effectiveSalary, effectiveBuildCost, priceIndexFor,
} from './Market.js';

let _nextId = 1;
function nextIndustryId() { return `ind_${_nextId++}`; }

// =============================================================================
// Construction
// =============================================================================
export function canBuildIndustryHere(state, ownerId, tile, recipeId) {
  if (!INDUSTRIES[recipeId]) return { ok: false, reason: 'Unknown recipe' };
  if (!tile) return { ok: false, reason: 'No tile' };
  if (tile.owner !== ownerId) return { ok: false, reason: 'Not yours' };
  if (tile.industryId) return { ok: false, reason: 'Tile already has an industry' };
  if (!isHaloTile(state, tile)) return { ok: false, reason: 'Must be a city halo tile' };
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
  const buildCost = effectiveBuildCost(state, ind.countryId, recipe);
  if (wallet.cash < buildCost) return { ok: false, reason: 'Not enough cash' };
  wallet.cash -= buildCost;
  ind.status = 'building';
  ind.startBuildDay = state.time.totalDays;
  if (ind.ownerId === 'player') pushLog(state, `Reopening ${recipe.name}…`);
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
      ind.status = 'operational';
      continue;
    }

    const wallet = walletFor(state, ind.ownerId);
    if (!wallet) { ind.status = 'idle'; continue; }
    if (!wallet.inventory) wallet.inventory = {};
    const isPlayer = ind.ownerId === 'player';
    const cid = ind.countryId;

    // 1. Ensure inputs are available. Player must stock manually; AI auto-buys missing.
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
    if (!allInputs) {
      ind.status = 'idle';
      continue;
    }

    // 2. Consume inputs
    for (const [pid, qty] of Object.entries(recipe.inputs)) {
      wallet.inventory[pid] -= qty;
    }

    // 3. Produce outputs. Player keeps in inventory; AI auto-sells to local market.
    for (const [pid, qty] of Object.entries(recipe.outputs)) {
      if (isPlayer) {
        wallet.inventory[pid] = (wallet.inventory[pid] || 0) + qty;
      } else {
        const price = state.market.prices?.[cid]?.[pid] || 0;
        if (price <= 0) {
          // No price set yet — fall back to inventory
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
    if (!wallet) { ind.status = 'closed'; continue; }
    const country = state.countries[ind.countryId];
    if (!country) continue;
    const salary = effectiveSalary(state, ind.countryId, recipe);
    if (wallet.cash < salary) {
      ind.status = 'closed';
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
// Fiscal-crisis state machine (monthly)
// =============================================================================
export function tickFiscalCrisis(state) {
  for (const cid of COUNTRY_IDS) {
    const c = state.countries[cid];
    if (!c) continue;
    const fc = c.fiscalCrisis;
    if (c.treasury < 0) {
      fc.monthsNegative += 1;
      fc.monthsPositive = 0;
      if (!fc.active && fc.monthsNegative >= FISCAL_CRISIS.triggerNegativeMonths) {
        fc.active = true;
        fc.taxBump = 0;
        fc.preferenceCrush = 0;
        if (cid === 'home') pushLog(state, `🚨 FISCAL CRISIS in Home — taxes rising.`);
      }
      if (fc.active) {
        fc.taxBump += FISCAL_CRISIS.taxBumpPerMonth;
        fc.preferenceCrush = Math.min(1, fc.preferenceCrush + FISCAL_CRISIS.preferenceCrushPerMonth);
      }
    } else {
      fc.monthsPositive += 1;
      fc.monthsNegative = 0;
      if (fc.active && fc.monthsPositive >= FISCAL_CRISIS.recoveryPositiveMonths) {
        // Anneal back
        fc.taxBump = Math.max(0, fc.taxBump - FISCAL_CRISIS.taxBumpPerMonth);
        fc.preferenceCrush = Math.max(0, fc.preferenceCrush - FISCAL_CRISIS.preferenceCrushPerMonth);
        if (fc.taxBump <= 0 && fc.preferenceCrush <= 0) {
          fc.active = false;
          if (cid === 'home') pushLog(state, `Fiscal crisis ended in Home.`);
        }
      }
    }
  }
}

// =============================================================================
// Seed comprehensive starter production: every country starts with at least one
// tile producing each commodity (raw crops, minerals, processed industries).
// Distributes ownership across each country's AI farmers in round-robin.
// =============================================================================

function pickWildTileNot(map, predicate) {
  for (const t of map.tiles) {
    if (t.owner !== 'wild') continue;
    if (!predicate || predicate(t)) return t;
  }
  return null;
}

function pickMineralTile(state, cid, mineralId) {
  // A tile in this country with deposit of `mineralId` and currently wild.
  const map = state.maps[cid];
  for (const t of map.tiles) {
    if (t.owner !== 'wild') continue;
    if ((t.minerals?.[mineralId] ?? 0) > 0.5) return t;
  }
  // Fallback: any wild tile (will create a synthetic deposit)
  for (const t of map.tiles) {
    if (t.owner === 'wild') {
      t.minerals = t.minerals || {};
      if (!(t.minerals[mineralId] > 0)) t.minerals[mineralId] = 0.6;
      return t;
    }
  }
  return null;
}

export function seedStarterProduction(state) {
  for (const cid of COUNTRY_IDS) {
    const ais = state.aiFarmers.filter(a => a.countryId === cid);
    if (ais.length === 0) continue;
    let aiIdx = 0;
    const nextAi = () => ais[(aiIdx++) % ais.length];

    // === 1. Tile-grown producibles: 1 tile per crop/mineral, planted/mining ===
    for (const def of Object.values(PRODUCIBLES)) {
      if (def.category === 'processed') continue;

      let tile = null;
      if (def.category === 'mining') {
        tile = pickMineralTile(state, cid, def.id);
      } else {
        tile = pickWildTileNot(state.maps[cid], (t) => true);
      }
      if (!tile) continue;

      const owner = nextAi();
      tile.owner = owner.id;
      tile.crop = def.id;
      tile.plantedDay = state.time.totalDays;
      tile.ageDays = 0;

      if (def.category === 'mining') {
        tile.surveyed = true;
        // Skip half the build phase so harvest is closer
        tile.state = 'planted';
        tile.growth = 0.5;
        tile.plantedDay = state.time.totalDays - Math.floor(def.growthDays / 2);
      } else if (def.perennial) {
        // Perennial: already mature, sitting in 'cosechado' so it regrows soon
        tile.state = 'cosechado';
        tile.growth = 0;
        const regrow = def.perennial.regrowDays;
        tile.lastHarvestDay = state.time.totalDays - Math.floor(regrow * 0.7);
      } else {
        // Annual: mid-cycle so harvest comes soon
        tile.state = 'planted';
        tile.growth = 0.5;
        tile.plantedDay = state.time.totalDays - Math.floor(def.growthDays / 2);
      }

      if (!owner.ownedTileIds.includes(tile.id)) owner.ownedTileIds.push(tile.id);
      // Pre-seed some inventory so the AI can replant quickly
      if (!owner.inventory) owner.inventory = {};
    }

    // === 2. All industries: 1 operational factory per recipe per country ===
    // Halo may already be partly claimed by AI farmers — re-use those tiles, the
    // current AI owner gets the industry. Don't break on first failure: try every
    // industry. Recipes that cannot find any tile are simply skipped this country.
    const halo = getHaloTileIds(state, cid);
    let haloIdx = 0;
    for (const recipe of Object.values(INDUSTRIES)) {
      let tile = null;
      let owner = null;
      // Find next halo tile that's not the city and not already hosting an industry.
      while (haloIdx < halo.length && !tile) {
        const t = state.maps[cid].tiles[halo[haloIdx++]];
        if (!t) continue;
        if (t.industryId) continue;        // already has industry
        if (t.owner === 'city') continue;
        if (t.owner === 'wild') {
          owner = nextAi();
          t.owner = owner.id;
          tile = t;
        } else if (t.owner && t.owner.includes('_ai')) {
          owner = state.aiFarmers.find(a => a.id === t.owner);
          if (owner) tile = t;
        }
      }
      if (!tile || !owner) continue;        // skip this recipe in this country

      const id = nextIndustryId();
      state.industries.push({
        id, ownerId: owner.id, countryId: cid,
        tileId: tile.id, recipeId: recipe.id,
        status: 'operational',
        startBuildDay: state.time.totalDays - recipe.buildDays,
        operationalDay: state.time.totalDays,
        // Backdate so the very first tickIndustries triggers a production cycle.
        lastCycleDay: state.time.totalDays - recipe.cycleDays,
        lastSalaryMonth: null,
      });
      tile.industryId = id;
      tile.state = 'industry';            // distinct from 'fallow' so UI knows
      if (!owner.ownedTileIds.includes(tile.id)) owner.ownedTileIds.push(tile.id);
      // Pre-seed enough inputs for ~30 cycles. Industries replenish inputs by buying
      // from the market periodically (aiTopUpIndustryInputs, monthly).
      if (!owner.inventory) owner.inventory = {};
      for (const [pid, qty] of Object.entries(recipe.inputs)) {
        owner.inventory[pid] = (owner.inventory[pid] || 0) + qty * 30;
      }
      for (const [pid, qty] of Object.entries(recipe.outputs)) {
        owner.inventory[pid] = (owner.inventory[pid] || 0) + qty * 5;
      }
    }
  }
}

// Backward-compat alias used by Game.create() before this rewrite.
export function seedIndustries(state) { return seedStarterProduction(state); }

// =============================================================================
// AI: build / close industries based on moving-average prices
// =============================================================================

// Daily-ish (in cooldown branch): consider building one new industry on a halo tile.
export function aiTryBuildIndustry(state, ai) {
  if (Math.random() > 0.20) return;       // ~1 chance per cooldown
  const halo = getHaloTileIds(state, ai.countryId).map(id => state.maps[ai.countryId].tiles[id]);
  const wildHalo = halo.filter(t => t && t.owner === 'wild');
  if (wildHalo.length === 0) return;
  if (!ai.cash || ai.cash < 8000) return; // need at least cheapest buildCost

  // Score each recipe by 30-day MA ROI
  const lookback = INDUSTRY.aiPriceLookbackDays;
  let best = null, bestRoi = -Infinity, bestReason = '';
  for (const recipe of Object.values(INDUSTRIES)) {
    if (ai.cash < effectiveBuildCost(state, ai.countryId, recipe)) continue;
    let inputCost = 0, outputRev = 0;
    for (const [pid, qty] of Object.entries(recipe.inputs)) {
      inputCost += priceMA(state, pid, ai.countryId, lookback) * qty;
    }
    for (const [pid, qty] of Object.entries(recipe.outputs)) {
      outputRev += priceMA(state, pid, ai.countryId, lookback) * qty;
    }
    // Cycles per month and salary
    const cyclesPerMonth = 30 / recipe.cycleDays;
    const monthlyMargin = (outputRev - inputCost) * cyclesPerMonth - effectiveSalary(state, ai.countryId, recipe);
    const roi = monthlyMargin / Math.max(1, effectiveBuildCost(state, ai.countryId, recipe));
    pushAIDecision(state, {
      companyId: ai.id, recipeId: recipe.id,
      action: 'considered',
      reason: `30d ROI ${(roi * 100).toFixed(1)}% (margin $${Math.round(monthlyMargin)}/mo)`,
    });
    if (roi > bestRoi) { bestRoi = roi; best = recipe; bestReason = `ROI ${(roi * 100).toFixed(1)}%`; }
  }

  if (!best || bestRoi < INDUSTRY.aiBuildRoiThreshold) return;
  // Pick a halo tile and build
  const tile = wildHalo[0];
  const r = buildIndustry(state, ai.id, tile, best.id);
  if (r.ok) {
    pushAIDecision(state, {
      companyId: ai.id, recipeId: best.id, action: 'built', reason: bestReason,
    });
    pushLog(state, `${ai.name} started building ${best.name} in ${ai.countryId}.`);
  }
}

// Monthly: AI tops up industry inputs by buying from the local market. Without this
// the seeded 30-cycle buffer drains and industries go idle. AI uses the local price.
export function aiTopUpIndustryInputs(state, ai) {
  const owned = state.industries.filter(
    i => i.ownerId === ai.id && (i.status === 'operational' || i.status === 'idle'),
  );
  if (owned.length === 0) return;
  if (!ai.inventory) ai.inventory = {};
  const cid = ai.countryId;
  for (const ind of owned) {
    const recipe = INDUSTRIES[ind.recipeId];
    if (!recipe) continue;
    // Target buffer = 10 cycles of inputs.
    for (const [pid, qty] of Object.entries(recipe.inputs)) {
      const have = ai.inventory[pid] || 0;
      const target = qty * 10;
      if (have >= target) continue;
      const need = target - have;
      const stock = state.market.inventory?.[cid]?.[pid] || 0;
      if (stock <= 0) continue;
      const price = state.market.prices?.[cid]?.[pid] || 0;
      if (price <= 0) continue;
      const affordable = ai.cash / price;
      const buy = Math.floor(Math.min(need, stock, affordable));
      if (buy <= 0) continue;
      // Use executeTransaction (b2b)
      const r = executeTransaction(state, {
        sellerId: 'foreign',
        buyerId: ai.id,
        productId: pid,
        units: buy,
        unitPrice: price,
        countryOfTransaction: cid,
        sellerCountryId: cid,
        type: 'b2b',
      });
      if (r.ok) {
        state.market.inventory[cid][pid] -= buy;
        ai.inventory[pid] = have + buy;
      }
    }
  }
}

// Monthly: AI sells finished output stock back to the local market so cash refreshes.
export function aiSellIndustryOutputs(state, ai) {
  if (!ai.inventory) return;
  for (const ind of state.industries) {
    if (ind.ownerId !== ai.id) continue;
    if (ind.status === 'closed' || ind.status === 'building') continue;
    const recipe = INDUSTRIES[ind.recipeId];
    if (!recipe) continue;
    const cid = ai.countryId;
    for (const pid of Object.keys(recipe.outputs)) {
      const have = ai.inventory[pid] || 0;
      // Keep a small reserve, sell the rest.
      const sell = Math.max(0, Math.floor(have - recipe.outputs[pid] * 5));
      if (sell <= 0) continue;
      const price = state.market.prices?.[cid]?.[pid] || 0;
      if (price <= 0) continue;
      const r = executeTransaction(state, {
        sellerId: ai.id,
        buyerId: 'foreign',
        productId: pid,
        units: sell,
        unitPrice: price,
        countryOfTransaction: cid,
        sellerCountryId: cid,
        type: 'b2b',
      });
      if (r.ok) {
        ai.inventory[pid] -= sell;
        const country = state.countries[cid];
        if (country) country.supplyToday[pid] = (country.supplyToday[pid] || 0) + sell;
      }
    }
  }
}

// Monthly: re-open closed industries when the 30-day MA margin turns profitable again.
// Pays buildCost (sunk again — same as the player paying to reopen).
export function aiTryReopenIndustry(state, ai) {
  const closed = state.industries.filter(i => i.ownerId === ai.id && i.status === 'closed' && !i.foreclosed);
  for (const ind of closed) {
    const recipe = INDUSTRIES[ind.recipeId];
    if (!recipe) continue;
    if (ai.cash < effectiveBuildCost(state, ai.countryId, recipe)) continue;
    const lookback = INDUSTRY.aiPriceLookbackDays;
    let inputCost = 0, outputRev = 0;
    for (const [pid, qty] of Object.entries(recipe.inputs)) {
      inputCost += priceMA(state, pid, ai.countryId, lookback) * qty;
    }
    for (const [pid, qty] of Object.entries(recipe.outputs)) {
      outputRev += priceMA(state, pid, ai.countryId, lookback) * qty;
    }
    const cyclesPerMonth = 30 / recipe.cycleDays;
    const monthlyMargin = (outputRev - inputCost) * cyclesPerMonth - effectiveSalary(state, ai.countryId, recipe);
    const roi = monthlyMargin / Math.max(1, effectiveBuildCost(state, ai.countryId, recipe));
    if (roi >= INDUSTRY.aiBuildRoiThreshold) {
      // Reopen — pay buildCost, restart in 'building' for the buildDays countdown
      ai.cash -= effectiveBuildCost(state, ai.countryId, recipe);
      ind.status = 'building';
      ind.startBuildDay = state.time.totalDays;
      ind.operationalDay = null;
      ind.lastCycleDay = null;
      pushAIDecision(state, {
        companyId: ai.id, recipeId: recipe.id, action: 'reopened',
        reason: `30d ROI ${(roi * 100).toFixed(1)}% — back above ${(INDUSTRY.aiBuildRoiThreshold * 100).toFixed(1)}%`,
      });
      pushLog(state, `${ai.name} reopened ${recipe.name} (margin recovered).`);
    }
  }
}

// Monthly: close any industry whose 90-day moving-average margin is too negative.
export function aiTryCloseIndustry(state, ai) {
  const owned = state.industries.filter(i => i.ownerId === ai.id && i.status !== 'closed' && i.status !== 'building');
  for (const ind of owned) {
    const recipe = INDUSTRIES[ind.recipeId];
    if (!recipe) continue;
    const lookback = INDUSTRY.aiCloseMarginLookbackDays;
    let inputCost = 0, outputRev = 0;
    for (const [pid, qty] of Object.entries(recipe.inputs)) {
      inputCost += priceMA(state, pid, ai.countryId, lookback) * qty;
    }
    for (const [pid, qty] of Object.entries(recipe.outputs)) {
      outputRev += priceMA(state, pid, ai.countryId, lookback) * qty;
    }
    const cyclesPerMonth = 30 / recipe.cycleDays;
    const monthlyMargin = (outputRev - inputCost) * cyclesPerMonth - recipe.monthlySalary;
    if (monthlyMargin < -recipe.monthlySalary * 0.5) {
      pushAIDecision(state, {
        companyId: ai.id, recipeId: recipe.id, action: 'closed',
        reason: `90d margin $${Math.round(monthlyMargin)}/mo`,
      });
      ind.status = 'closed';
      pushLog(state, `${ai.name} closed ${recipe.name} (90d margin negative).`);
    }
  }
}

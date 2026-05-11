// WorldSeed — generates day-zero starter production so every country has at
// least one tile producing each commodity (raw crops, minerals, processed
// industries) and at least one operational factory per recipe. AI farmers in
// the country round-robin own these tiles. Idempotent against HMR / re-init.

import { PRODUCIBLES } from '../data/producibles.js';
import { INDUSTRIES } from '../data/industries.js';
import { COUNTRY_IDS } from '../data/countries.js';
import { getHaloTileIds } from '../state/GameState.js';
import { nextIndustryId } from './Industries.js';

function pickWildTileNot(map, predicate) {
  for (const t of map.tiles) {
    if (t.owner !== 'wild') continue;
    if (!predicate || predicate(t)) return t;
  }
  return null;
}

function pickMineralTile(state, cid, mineralId) {
  const map = state.maps[cid];
  for (const t of map.tiles) {
    if (t.owner !== 'wild') continue;
    if ((t.minerals?.[mineralId] ?? 0) > 0.5) return t;
  }
  // Fallback: synthesise a deposit on any wild tile.
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
  if (state.starterSeeded) return;
  state.starterSeeded = true;
  for (const cid of COUNTRY_IDS) {
    const ais = state.aiFarmers.filter(a => a.countryId === cid);
    if (ais.length === 0) continue;
    let aiIdx = 0;
    const nextAi = () => ais[(aiIdx++) % ais.length];

    // === 1. Tile-grown producibles: 1 tile per crop/mineral ===
    for (const def of Object.values(PRODUCIBLES)) {
      if (def.category === 'processed') continue;

      let tile = null;
      if (def.category === 'mining') {
        tile = pickMineralTile(state, cid, def.id);
      } else {
        tile = pickWildTileNot(state.maps[cid], () => true);
      }
      if (!tile) continue;

      const owner = nextAi();
      tile.owner = owner.id;
      tile.crop = def.id;
      tile.plantedDay = state.time.totalDays;
      tile.ageDays = 0;

      if (def.category === 'mining') {
        tile.surveyed = true;
        tile.state = 'planted';
        tile.growth = 0.5;
        tile.plantedDay = state.time.totalDays - Math.floor(def.growthDays / 2);
        tile.lockType = 'mining';
      } else if (def.perennial) {
        tile.state = 'cosechado';
        tile.growth = 0;
        const regrow = def.perennial.regrowDays;
        tile.lastHarvestDay = state.time.totalDays - Math.floor(regrow * 0.7);
        tile.lockType = 'crop';
      } else {
        tile.state = 'planted';
        tile.growth = 0.5;
        tile.plantedDay = state.time.totalDays - Math.floor(def.growthDays / 2);
        tile.lockType = 'crop';
      }

      if (!owner.ownedTileIds.includes(tile.id)) owner.ownedTileIds.push(tile.id);
      if (!owner.inventory) owner.inventory = {};
    }

    // === 2. One operational factory per recipe per country ===
    const halo = getHaloTileIds(state, cid);
    let haloIdx = 0;
    for (const recipe of Object.values(INDUSTRIES)) {
      let tile = null;
      let owner = null;
      while (haloIdx < halo.length && !tile) {
        const t = state.maps[cid].tiles[halo[haloIdx++]];
        if (!t) continue;
        if (t.industryId) continue;
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
      if (!tile || !owner) continue;

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
      tile.state = 'industry';
      tile.lockType = 'industry';
      if (!owner.ownedTileIds.includes(tile.id)) owner.ownedTileIds.push(tile.id);
      if (!owner.inventory) owner.inventory = {};
      // ~30 cycles of inputs and a small output buffer. Topup runs monthly
      // afterwards (aiTopUpIndustryInputs).
      for (const [pid, qty] of Object.entries(recipe.inputs)) {
        owner.inventory[pid] = (owner.inventory[pid] || 0) + qty * 30;
      }
      for (const [pid, qty] of Object.entries(recipe.outputs)) {
        owner.inventory[pid] = (owner.inventory[pid] || 0) + qty * 5;
      }
    }
  }
}

// Backwards-callable name used historically.
export function seedIndustries(state) { return seedStarterProduction(state); }

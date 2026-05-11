// Mineral deposits, surveying, discovery boom.
//
// World gen: for every producible with `patches`, place `count` patches of
// `sizePerPatch` tiles each. Patches are organic blobs grown via random adjacency.
// Tiles get a hidden `minerals[id]` richness, revealed only after surveying.
//
// Survey: player pays `MINERALS.surveyCost` to test a tile. Reveals what's there.
// If a positive deposit is found, every tile within `discoveryRadius` gains a
// `boomFactor` multiplier on its sale price (speculation), capped at `maxBoom`.

import { PRODUCIBLE_LIST, PRODUCIBLES } from '../data/producibles.js';
import { MINERALS, MAP, FISCAL_CRISIS, INDUSTRY } from '../data/tunables.js';
import { CITY } from '../data/tunables.js';
import { COUNTRY_IDS } from '../data/countries.js';
import { pushLog, pushFx } from '../state/GameState.js';
import { walletFor } from './Bank.js';
import { effectiveMonthlyOpCost, effectiveSetupCost, effectiveSurveyCost } from './Inflation.js';

function rand(min, max) { return min + Math.random() * (max - min); }

// Place patches in EVERY country's map at world generation.
export function generateMineralDeposits(state) {
  for (const cid of Object.keys(state.maps)) {
    generateDepositsForMap(state, cid);
  }
}

function generateDepositsForMap(state, countryId) {
  const map = state.maps[countryId];
  const tiles = map.tiles;
  const cols = map.cols, rows = map.rows;
  const city = state.cities[countryId];
  const cityIdx = city ? city.y * cols + city.x : -1;

  function neighbors(t) {
    const out = [];
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = t.x + dx, ny = t.y + dy;
      if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) continue;
      out.push(tiles[ny * cols + nx]);
    }
    return out;
  }

  function canSeed(t) {
    return t.id !== cityIdx;
  }

  function growPatch(mineralId, size, richMin, richMax) {
    const inPatch = new Set();
    // Pick a random seed
    let seedAttempts = 0;
    let seed;
    do {
      seed = tiles[Math.floor(Math.random() * tiles.length)];
      seedAttempts++;
    } while (!canSeed(seed) && seedAttempts < 50);
    if (!canSeed(seed)) return;
    inPatch.add(seed.id);

    // Grow by adjacency until size reached
    let safety = 0;
    while (inPatch.size < size && safety++ < size * 50) {
      const candidates = [];
      for (const id of inPatch) {
        for (const n of neighbors(tiles[id])) {
          if (inPatch.has(n.id) || !canSeed(n)) continue;
          candidates.push(n);
        }
      }
      if (candidates.length === 0) break;
      const pick = candidates[Math.floor(Math.random() * candidates.length)];
      inPatch.add(pick.id);
    }

    for (const id of inPatch) {
      const t = tiles[id];
      const richness = rand(richMin, richMax);
      // Existing deposit on the tile? Take the max — patches may overlap.
      const prev = t.minerals?.[mineralId] ?? 0;
      t.minerals = t.minerals || {};
      t.minerals[mineralId] = Math.max(prev, richness);
    }
  }

  for (const def of PRODUCIBLE_LIST) {
    if (!def.patches) continue;
    const cfg = def.patches;
    const richMin = cfg.richness?.min ?? 0.4;
    const richMax = cfg.richness?.max ?? 0.9;
    for (let i = 0; i < cfg.count; i++) {
      growPatch(def.id, cfg.sizePerPatch, richMin, richMax);
    }
  }
}

// Returns { has: bool, list: [{ id, name, richness }] } for the surveyed tile.
function describeDeposits(tile) {
  const list = [];
  for (const def of PRODUCIBLE_LIST) {
    if (def.category !== 'mining') continue;
    const r = tile.minerals?.[def.id] ?? 0;
    if (r > 0) list.push({ id: def.id, name: def.name, richness: r });
  }
  return { has: list.length > 0, list };
}

export function surveyTile(state, tile, ownerId = 'player') {
  if (tile.owner !== ownerId) return { ok: false, reason: 'Not yours' };
  if (tile.surveyed) return { ok: false, reason: 'Already surveyed' };
  const wallet = walletFor(state, ownerId);
  if (!wallet) return { ok: false, reason: 'Wallet missing' };
  const cost = effectiveSurveyCost(state, tile.countryId);
  if (wallet.cash < cost) return { ok: false, reason: 'Not enough cash' };

  wallet.cash -= cost;
  const country = state.countries[tile.countryId];
  if (country) {
    const haircut = country.fiscalCrisis?.active ? FISCAL_CRISIS.wageHaircutFraction : 0;
    country.wageFund += cost * (1 - haircut);
  }
  tile.surveyed = true;
  pushFx(state, { type: 'sfx', kind: 'survey' });
  const { has, list } = describeDeposits(tile);

  if (!has) {
    pushLog(state, `Survey (${tile.x},${tile.y}): no minerals found.`);
    pushFx(state, { type: 'bounceTile', tileId: tile.id, scale: 1.12 });
    pushFx(state, {
      type: 'popText',
      atTile: tile.id,
      text: 'No minerals',
      color: '#9aa4ad',
      duration: 3200,
      rise: 28,
      fontSize: 14,
    });
    return { ok: true, has: false, list };
  }

  const summary = list.map(m => `${m.name} ${(m.richness * 100).toFixed(0)}%`).join(', ');
  pushLog(state, `Survey (${tile.x},${tile.y}): ${summary}`);
  pushFx(state, { type: 'sfx', kind: 'chime' });
  pushFx(state, {
    type: 'popText',
    atTile: tile.id,
    text: summary,
    color: '#ffd166',
    duration: 3000,
    rise: 32,
    fontSize: 14,
  });
  applyDiscoveryBoom(state, tile);
  return { ok: true, has: true, list };
}

function applyDiscoveryBoom(state, sourceTile) {
  const r = MINERALS.discoveryRadius;
  pushFx(state, { type: 'bounceTile', tileId: sourceTile.id, scale: 1.5 });

  // Boom only spreads within the same country's map.
  const map = state.maps[sourceTile.countryId];
  if (!map) return;
  for (const t of map.tiles) {
    const dx = t.x - sourceTile.x;
    const dy = t.y - sourceTile.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > r) continue;
    const falloff = 1 - dist / r;
    const add = MINERALS.discoveryBoost * falloff;
    const prev = t.boomFactor ?? 1;
    const next = Math.min(MINERALS.maxBoom, prev + add);
    const delta = next - prev;
    t.boomFactor = next;

    if (delta > 0.01 && t.id !== sourceTile.id) {
      // Floating "+X%" on each affected neighbor
      pushFx(state, {
        type: 'popText',
        atTile: t.id,
        text: `+${Math.round(delta * 100)}%`,
        color: '#ffaa55',
      });
      pushFx(state, { type: 'bounceTile', tileId: t.id, scale: 1.15 });
    }
  }
}

// Effective ore quality for a mining producible on a tile.
export function mineralRichness(tile, mineralId) {
  return tile.minerals?.[mineralId] ?? 0;
}

// Tile can plant a mining producible only if surveyed and has a deposit.
export function canMineHere(tile, def) {
  if (def.category !== 'mining') return true;
  if (!tile.surveyed) return false;
  return mineralRichness(tile, def.id) > 0;
}

// Monthly tick: every operational mine pays its monthlyOpCost (labor) into
// wageFund. Closed mines pay nothing and produce nothing. Owner-broke mines
// auto-close (status='closed') so a permanent stall doesn't go unnoticed.
export function tickMiningOps(state) {
  for (const cid of COUNTRY_IDS) {
    const map = state.maps?.[cid];
    if (!map) continue;
    const country = state.countries[cid];
    if (!country) continue;
    const haircut = country.fiscalCrisis?.active ? FISCAL_CRISIS.wageHaircutFraction : 0;
    for (const tile of map.tiles) {
      if (!tile.crop) continue;
      if (tile.industryId) continue;
      if (tile.owner === 'wild' || tile.owner === 'developer' || tile.owner === 'city') continue;
      const def = PRODUCIBLES[tile.crop];
      if (!def || def.category !== 'mining') continue;
      if (tile.miningStatus === 'closed') continue;     // closed mines pay nothing
      // Mine is "operational" if it's currently running or resting between cycles.
      if (tile.state !== 'planted' && tile.state !== 'mature' && tile.state !== 'cosechado') continue;

      const cost = effectiveMonthlyOpCost(state, cid, def);
      if (cost <= 0) continue;
      const wallet = walletFor(state, tile.owner);
      if (!wallet) continue;
      if (wallet.cash < cost) {
        // Owner can't afford — auto-close. Player has to reopen explicitly.
        tile.miningStatus = 'closed';
        tile.miningStalled = false;
        if (tile.owner === 'player') {
          pushLog(state, `${def.name} mine on (${tile.x},${tile.y}) closed — couldn't pay $${cost} ops cost.`);
        }
        continue;
      }
      tile.miningStalled = false;
      wallet.cash -= cost;
      country.wageFund += cost * (1 - haircut);
    }
  }
}

// Player toggles a mine open/closed. Closed mines pay no labor and produce
// nothing; reopening costs a fraction of the original seed cost (restart fee).
export function closeMine(state, tile) {
  if (!tile.crop) return { ok: false, reason: 'No mine here' };
  const def = PRODUCIBLES[tile.crop];
  if (!def || def.category !== 'mining') return { ok: false, reason: 'Not a mine' };
  if (tile.miningStatus === 'closed') return { ok: false, reason: 'Already closed' };
  tile.miningStatus = 'closed';
  if (tile.owner === 'player') {
    pushLog(state, `Closed ${def.name} mine on (${tile.x},${tile.y}).`);
  }
  return { ok: true };
}

export function reopenMine(state, tile) {
  if (!tile.crop) return { ok: false, reason: 'No mine here' };
  const def = PRODUCIBLES[tile.crop];
  if (!def || def.category !== 'mining') return { ok: false, reason: 'Not a mine' };
  if (tile.miningStatus !== 'closed') return { ok: false, reason: 'Not closed' };
  const cost = Math.round(effectiveSetupCost(state, tile.countryId, def) * INDUSTRY.reopenCostFactor);
  const wallet = walletFor(state, tile.owner);
  if (!wallet) return { ok: false, reason: 'Wallet missing' };
  if (wallet.cash < cost) return { ok: false, reason: `Need $${cost} to restart` };
  wallet.cash -= cost;
  tile.miningStatus = 'operational';
  if (tile.owner === 'player') {
    pushLog(state, `Reopened ${def.name} mine on (${tile.x},${tile.y}) for $${cost}.`);
  }
  return { ok: true, cost };
}

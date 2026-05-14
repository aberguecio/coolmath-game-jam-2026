import { TIME, MAP, PLAYER_START, TILE, CITY, WAGES } from '../data/tunables.js';
import { distanceToCity, cityRadius } from '../systems/City.js';
import { createAIFarmersForCountry } from '../systems/AI.js';
import { createCountriesState, initMarket } from '../systems/Market.js';
import { initMarketSnapshot } from '../systems/MarketHistory.js';
import { generateMineralDeposits } from '../systems/Mining.js';
import { COUNTRY_IDS, PLAYER_COUNTRY_ID, COUNTRIES } from '../data/countries.js';
import { PRODUCIBLES, PRODUCIBLE_IDS } from '../data/producibles.js';
import { TAX_RATES } from '../data/taxRates.js';
import { DISTANCES } from '../data/distances.js';

const TUTORIAL_LS_KEY = 'coolmath:tutorial';

// =============================================================================
// Boot-time validation: registries must cross-reference each other consistently.
// =============================================================================
function validateRegistries() {
  // Each country's taxRatesId must exist; distances must be symmetric and complete.
  for (const cid of COUNTRY_IDS) {
    const reg = COUNTRIES[cid];
    if (reg.taxRatesId && !TAX_RATES[reg.taxRatesId]) {
      throw new Error(`Country ${cid} references missing taxRatesId "${reg.taxRatesId}"`);
    }
    if (!DISTANCES[cid]) throw new Error(`Country ${cid} missing in distances.js`);
    for (const other of COUNTRY_IDS) {
      if (DISTANCES[cid][other] == null) throw new Error(`distances.${cid}.${other} missing`);
      if (DISTANCES[cid][other] !== DISTANCES[other][cid]) throw new Error(`distances asymmetric: ${cid}↔${other}`);
    }
  }
}

function rnd(seed) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function generateTilesFor(countryId, seed) {
  const rand = rnd(seed);
  const tiles = [];
  for (let y = 0; y < MAP.rows; y++) {
    for (let x = 0; x < MAP.cols; x++) {
      const id = y * MAP.cols + x;
      const noise = rand();
      const bias = 1 - Math.abs(y - MAP.rows * 0.6) / MAP.rows;
      const quality = Math.max(0.2, Math.min(1, noise * 0.6 + bias * 0.5));
      tiles.push({
        id, x, y, countryId,
        owner: 'wild',
        quality,
        state: 'fallow',
        crop: null,
        growth: 0,
        plantedDay: null,
        ageDays: 0,
        lastHarvestDay: null,
        minerals: {},
        surveyed: false,
        boomFactor: 1,
        pendingOffer: null,
        autoReplant: false,
        // Auto-management: when true, plowing/planting/harvesting fire automatically
        // and the tile pays harvestCost / setup costs (= "hires labor"). Default OFF
        // means the player has to click each action manually — solo farming, no labor cost.
        // AI farmers always operate as if autoMode = true (hired-labor model).
        autoMode: false,
        // Land lock-in: once a tile is committed to a category it stays committed
        // even after the venture ends. Permitted values: null | 'crop' | 'mining' | 'industry'.
        // Set on first plantTile / buildIndustry; never cleared (uproot keeps lockType).
        lockType: null,
        // Mining status machine. 'operational' = pays monthlyOpCost and produces.
        // 'closed' = paused (no cost, no production). Only meaningful for mining tiles.
        miningStatus: 'operational',
        // Day the tile first entered 'mature'. Drives the grace-period rot/regrow
        // logic — an annual past `FARMING.harvestGraceDays` rots; a perennial
        // falls back to 'cosechado' losing that cycle's fruit. Cleared on
        // successful harvest / uproot / rot.
        matureSinceDay: null,
        // How many consecutive cycles autoHarvest skipped this tile because
        // revenue < cost × profitMargin. Used by AI to uproot chronically
        // unprofitable perennials even before they get harvested at a loss.
        skipStreak: 0,
        // Housing
        developmentDay: null,         // when developed-tile was completed
      });
    }
  }
  return { cols: MAP.cols, rows: MAP.rows, tiles, countryId };
}

const CITY_POSITIONS = {
  home:    { x: CITY.x, y: CITY.y },
  usa:     { x: 3,      y: 4 },
  china:   { x: 11,     y: 11 },
  brazil:  { x: 8,      y: 9 },
  germany: { x: 5,      y: 2 },
};

function createCitiesFor() {
  const cities = {};
  for (const cid of COUNTRY_IDS) {
    const pos = CITY_POSITIONS[cid] || { x: CITY.x, y: CITY.y };
    // tileIds is an array of tile.id's owned by the city. Halo = 8-neighborhood union of these.
    cities[cid] = {
      countryId: cid,
      x: pos.x, y: pos.y,
      tileIds: [pos.y * MAP.cols + pos.x],
      population: CITY.startPopulation,
    };
  }
  return cities;
}

function loadTutorialState() {
  try {
    const raw = localStorage.getItem(TUTORIAL_LS_KEY);
    if (!raw) return { stepIdx: 0, dismissed: false, bankOpened: false };
    const parsed = JSON.parse(raw);
    return {
      stepIdx: parsed.stepIdx ?? 0,
      dismissed: parsed.dismissed === true,
      bankOpened: parsed.bankOpened === true,
    };
  } catch {
    return { stepIdx: 0, dismissed: false, bankOpened: false };
  }
}

export function persistTutorial(state) {
  try { localStorage.setItem(TUTORIAL_LS_KEY, JSON.stringify(state.tutorial)); } catch {}
}

export function createInitialState() {
  validateRegistries();

  const maps = {};
  for (const cid of COUNTRY_IDS) maps[cid] = generateTilesFor(cid, hashStr(cid + ':seed'));

  const homeMap = maps[PLAYER_COUNTRY_ID];
  for (const id of PLAYER_START.ownedTileIds) {
    if (homeMap.tiles[id]) homeMap.tiles[id].owner = 'player';
  }

  const cities = createCitiesFor();
  for (const cid of COUNTRY_IDS) {
    const m = maps[cid];
    const c = cities[cid];
    const cityTile = m.tiles[c.y * m.cols + c.x];
    if (cityTile) {
      cityTile.owner = 'city';
      cityTile.state = 'lot';
    }
  }

  const state = {
    time: {
      day: TIME.startDay,
      month: TIME.startMonth,
      year: TIME.startYear,
      totalDays: 0,
      accumulator: 0,
      speedIdx: 1,
      paused: false,
    },
    player: {
      cash: PLAYER_START.cash,
      bankrupt: false,
      wcCooldownUntilDay: 0,
      // Inventory partitioned by country — the player cannot teleport goods.
      // Buy in Riverside → stays in inventoryByCountry.usa. To move it home
      // the player must (eventually) found an exporter; see TODO.md.
      inventoryByCountry: Object.fromEntries(COUNTRY_IDS.map(cid => [cid, {}])),
    },
    maps,
    cities,
    map: maps[PLAYER_COUNTRY_ID],
    city: cities[PLAYER_COUNTRY_ID],
    market: {
      // PER-COUNTRY: prices[cid][pid], inventory[cid][pid], history[cid][pid], targetStock[cid][pid]
      prices: {},
      history: {},
      inventory: {},
      targetStock: {},
      dailyConsumption: {},
    },
    countries: createCountriesState(),
    loans: [],
    selection: { tileId: null, countryId: PLAYER_COUNTRY_ID },
    log: [{ day: 0, text: 'Welcome. You own 1 plot in Home and $0. Visit the bank.' }],
    aiFarmers: [],
    exporters: [],
    // Centralised wallet registry — id → wallet object. Lets Transactions.js
    // resolve any owner type via a single lookup instead of a hardcoded chain
    // (aiFarmers ?? exporters ?? banks…). Pattern: any actor with a `cash`
    // field registers here at creation, deregisters on destruction.
    wallets: {},
    activeEvents: [],
    eventHistory: [],
    fxQueue: [],
    ledger: [],                        // ring of recent transactions for debug/audit (last 200)
    aiDecisionLog: [],                 // ring of recent AI build/close decisions
    tradeFlows: [],                    // {day, src, dst, pid, units} — last ~60 days, used by World view
    tutorial: loadTutorialState(),
    ui: {
      bankOpen: false,
      bankApply: {},
      countryChartOpen: false,
      savedSpeedIdx: 1,
      currentMap: PLAYER_COUNTRY_ID,
    },
  };

  // Seed wageFund + treasury + marketPool + fiscalCrisis tracking in each country runtime.
  // Liquidity split: 30 days each across wageFund / treasury / marketPool — same total but
  // distributed so each ledger account has working capital.
  for (const cid of COUNTRY_IDS) {
    const c = state.countries[cid];
    if (!c) continue;
    const dailyFood = c.population * WAGES.dailyFoodCostPerCapita;
    c.wageFund = dailyFood * 30;
    c.treasury = dailyFood * 30;
    c.marketPool = dailyFood * 30;
    c.fiscalCrisis = {
      active: false,
      monthsNegative: 0,
      monthsPositive: 0,
      taxBump: 0,
      preferenceCrush: 0,
      wageHaircutMonths: 0,
    };
    // Labor market — Sprint A. wageRate emerges from demand/supply via tickLaborMarket.
    c.wageRate = WAGES.baseWage;
    c.wageRateHistory = [WAGES.baseWage];
    c.laborSupply = c.population * WAGES.workersPerPopUnit;
    c.laborDemand = 0;          // populated on first tickLaborMarket
  }

  initMarket(state);
  initMarketSnapshot(state);
  generateMineralDeposits(state);

  return state;
}


export function initAIFarmers(state) {
  state.aiFarmers = [];
  if (!state.wallets) state.wallets = {};
  for (const cid of COUNTRY_IDS) {
    const farmers = createAIFarmersForCountry(state, cid);
    for (const f of farmers) {
      state.aiFarmers.push(f);
      state.wallets[f.id] = f;       // register wallet for executeTransaction
    }
  }
  // Player wallet is also addressable for symmetry, though Transactions.js
  // also short-circuits to state.player for the 'player' id.
  state.wallets.player = state.player;
}

// Helper used by any module that creates a new actor with cash.
export function registerWallet(state, wallet) {
  if (!state.wallets) state.wallets = {};
  state.wallets[wallet.id] = wallet;
}
export function unregisterWallet(state, id) {
  if (state.wallets) delete state.wallets[id];
}

// =============================================================================
// Helpers used across systems
// =============================================================================
export function tileById(state, countryId, tileId) {
  return state.maps?.[countryId]?.tiles?.[tileId] ?? null;
}

export function cityOfTile(state, tile) {
  return state.cities?.[tile.countryId] ?? state.city;
}

// Returns tile ids in 8-neighborhood union of city.tileIds (halo). Excludes city tiles themselves.
export function getHaloTileIds(state, countryId) {
  const map = state.maps[countryId];
  const city = state.cities[countryId];
  if (!map || !city) return [];
  const cityIdSet = new Set(city.tileIds);
  const halo = new Set();
  for (const cid of city.tileIds) {
    const t = map.tiles[cid];
    if (!t) continue;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = t.x + dx, ny = t.y + dy;
        if (nx < 0 || nx >= map.cols || ny < 0 || ny >= map.rows) continue;
        const ntId = ny * map.cols + nx;
        if (!cityIdSet.has(ntId)) halo.add(ntId);
      }
    }
  }
  return [...halo];
}

export function isHaloTile(state, tile) {
  if (!tile) return false;
  const halo = getHaloTileIds(state, tile.countryId);
  return halo.includes(tile.id);
}

export function tilePrice(tile, state = null) {
  let base = TILE.baseRuralPrice + tile.quality * TILE.qualityPriceFactor;
  const city = state ? cityOfTile(state, tile) : null;
  if (city) {
    const r = cityRadius(city);
    const d = distanceToCity(tile, city);
    if (d < r * 1.5) {
      const proximity = Math.max(0, 1 - d / (r * 1.5));
      base *= 1 + proximity * 1.5;
    }
  }
  base *= tile.boomFactor ?? 1;
  return Math.round(base);
}

export function pushLog(state, text) {
  state.log.unshift({ day: state.time.totalDays, text });
  if (state.log.length > 40) state.log.length = 40;
  // Mirror into the unified event history so the Events modal sees ALL action,
  // not just world events. Default tier=2 (strategic) — most pushLog sites
  // already describe meaningful state changes (buy/sell/build/close).
  logEvent(state, { tier: 2, category: 'log', summary: text });
}

// Resolve a wallet id into a display name. Used by logEvent when the caller
// passes actorId but not actorName — saves callers from repeating the lookup.
export function resolveActorName(state, actorId) {
  if (!actorId) return null;
  if (actorId === 'player') return 'YOU (Player)';
  if (actorId === 'population' || actorId === 'treasury' || actorId === 'foreign') return actorId;
  const ai = state.aiFarmers?.find(a => a.id === actorId);
  if (ai) return ai.name;
  const exp = state.exporters?.find(e => e.id === actorId);
  if (exp) return exp.name;
  return actorId;
}

// Unified event history. Every meaningful tick or decision lands here so the
// Events modal can filter and export. Schema:
//   { day, tier, category, countryId, actorId, actorName, summary, reason,
//     amount, meta }
// Ring buffer cap 10000 — at speed ×8 a year produces ~5k entries with the
// current tier mix, so this holds a couple of in-game years comfortably.
const EVENT_HISTORY_CAP = 10000;
export function logEvent(state, entry) {
  if (!state.eventHistory) state.eventHistory = [];
  const actorName = entry.actorName ?? resolveActorName(state, entry.actorId);
  state.eventHistory.push({
    day: state.time.totalDays,
    tier: entry.tier ?? 3,
    category: entry.category ?? 'misc',
    countryId: entry.countryId ?? null,
    actorId: entry.actorId ?? null,
    actorName: actorName ?? null,
    summary: entry.summary ?? '',
    reason: entry.reason ?? null,
    amount: entry.amount ?? null,
    meta: entry.meta ?? null,
  });
  if (state.eventHistory.length > EVENT_HISTORY_CAP) state.eventHistory.shift();
}

export function pushFx(state, event) {
  if (!state.fxQueue) state.fxQueue = [];
  state.fxQueue.push(event);
}

// Append AI decision log (one per company × producible/industry consideration).
export function pushAIDecision(state, entry) {
  if (!state.aiDecisionLog) state.aiDecisionLog = [];
  state.aiDecisionLog.push({ day: state.time.totalDays, ...entry });
  if (state.aiDecisionLog.length > 200) state.aiDecisionLog.shift();
  // Mirror to eventHistory at tier 3 (tactical) — these are decision-level
  // events with a reason attached, perfect for "why did the AI do X?" audits.
  logEvent(state, {
    tier: 3,
    category: `ai-${entry.action ?? 'decision'}`,
    actorId: entry.companyId,
    summary: `${entry.action ?? 'considered'} ${entry.recipeId ?? entry.producibleId ?? ''}`.trim(),
    reason: entry.reason ?? null,
  });
}

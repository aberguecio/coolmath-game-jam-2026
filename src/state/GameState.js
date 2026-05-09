import { TIME, MAP, PLAYER_START, TILE, CITY, WAGES } from '../data/tunables.js';
import { distanceToCity, cityRadius } from '../systems/City.js';
import { createAIFarmersForCountry } from '../systems/AI.js';
import { createCountriesState, initMarket } from '../systems/Market.js';
import { generateMineralDeposits } from '../systems/Mining.js';
import { COUNTRY_IDS, PLAYER_COUNTRY_ID, COUNTRIES } from '../data/countries.js';
import { PRODUCIBLES, PRODUCIBLE_IDS } from '../data/producibles.js';
import { INDUSTRIES, INDUSTRY_IDS } from '../data/industries.js';
import { TAX_RATES } from '../data/taxRates.js';
import { DISTANCES } from '../data/distances.js';

const TUTORIAL_LS_KEY = 'coolmath:tutorial';

// =============================================================================
// Boot-time validation: registries must cross-reference each other consistently.
// =============================================================================
function validateRegistries() {
  // Industry inputs/outputs must point to real producibles.
  for (const ind of Object.values(INDUSTRIES)) {
    for (const pid of Object.keys(ind.inputs || {})) {
      if (!PRODUCIBLES[pid]) throw new Error(`Industry "${ind.id}" input "${pid}" is not in producibles.js`);
    }
    for (const pid of Object.keys(ind.outputs || {})) {
      if (!PRODUCIBLES[pid]) throw new Error(`Industry "${ind.id}" output "${pid}" is not in producibles.js`);
    }
  }
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
    // Seeded industries must reference a real industry id.
    for (const indId of reg.seededIndustries || []) {
      if (!INDUSTRIES[indId]) throw new Error(`Country ${cid} seededIndustries references "${indId}" missing in industries.js`);
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
        // Industry / housing
        industryId: null,             // industry record id placed here (if any)
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

export function resetTutorial() {
  try { localStorage.removeItem(TUTORIAL_LS_KEY); } catch {}
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
      inventory: {},
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
    industries: [],                    // per-tile factories — populated by seedIndustries()
    selection: { tileId: null, countryId: PLAYER_COUNTRY_ID },
    log: [{ day: 0, text: 'Welcome. You own 1 plot in Home and $0. Visit the bank.' }],
    aiFarmers: [],
    activeEvents: [],
    fxQueue: [],
    ledger: [],                        // ring of recent transactions for debug/audit (last 200)
    aiDecisionLog: [],                 // ring of recent AI build/close decisions
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
    c.dailyNutritionConsumed = 0;
    c.dailyNutritionNeed = c.population * WAGES.dailyFoodCostPerCapita * 0.25;
  }

  initMarket(state);
  generateMineralDeposits(state);

  return state;
}


export function initAIFarmers(state) {
  state.aiFarmers = [];
  for (const cid of COUNTRY_IDS) {
    const farmers = createAIFarmersForCountry(state, cid);
    state.aiFarmers.push(...farmers);
  }
}

// =============================================================================
// Helpers used across systems
// =============================================================================
export function allTiles(state) {
  const out = [];
  for (const cid of COUNTRY_IDS) {
    const m = state.maps?.[cid];
    if (m) for (const t of m.tiles) out.push(t);
  }
  return out;
}

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
}

export function pushFx(state, event) {
  if (!state.fxQueue) state.fxQueue = [];
  state.fxQueue.push(event);
}

// Append to the dev ledger ring; oldest entries fall off after ~200.
export function pushLedger(state, entry) {
  if (!state.ledger) state.ledger = [];
  state.ledger.push({ day: state.time.totalDays, ...entry });
  if (state.ledger.length > 200) state.ledger.shift();
}

// Append AI decision log (one per company × producible/industry consideration).
export function pushAIDecision(state, entry) {
  if (!state.aiDecisionLog) state.aiDecisionLog = [];
  state.aiDecisionLog.push({ day: state.time.totalDays, ...entry });
  if (state.aiDecisionLog.length > 200) state.aiDecisionLog.shift();
}

// Observation — snapshot read-only del estado serializable a JSON.
//
// Lo que el bot ve = lo que un humano ve por la UI. Si la UI muestra X, este
// snapshot lo expone. El contrato es estable: cambios internos del state no
// rompen drivers mientras `observe()` mantenga el shape.
//
// Eventos pre-filtrados por tier (sistema ya existente en GameState.js:399):
//   strategic = T1 (world events) + T2 (pushLog / decisiones del player y AI).
//   warnings  = subset categorías de crisis / default / foreclose.
//   T3 (AI decisions tactical) y T4 (transacciones individuales) deliberadamente
//   excluidos por defecto — son ruido y revientan el context window de un LLM.

import { COUNTRY_IDS, PLAYER_COUNTRY_ID } from '../data/countries.js';
import { PRODUCIBLE_IDS } from '../data/producibles.js';
import { priceMA, offMarketInventoryFor } from '../systems/Market.js';
import { walletOf } from '../systems/Transactions.js';
import { expectedPriceAt, pipelineSupplyFor } from '../systems/Forecast.js';
import { effectiveSetupCost, effectivePlowCost, effectiveHarvestCost } from '../systems/Inflation.js';
import { tilePrice, tileById } from '../state/GameState.js';
import { PRODUCIBLES } from '../data/producibles.js';

const WARNING_CATEGORIES = /fiscal|default|crash|foreclose|bankrupt|world-event/;

// observeForActor — snapshot del state desde la perspectiva de un actor
// específico. Es la generalización de observe(state): además del state público
// (precios, históricos, country fiscal), incluye los datos privados del actor
// (cash, ownedTileIds, inventory, loans) y un forecast cerrado con su country.
//
// El forecast se expone como closures para que el brain pueda hacer queries
// ad-hoc (e.g., obs.forecast.expectedPriceAt('wheat', 90)) sin importarse
// de cómo se computa.
export function observeForActor(state, actorId, opts = {}) {
  const { includeTactical = false, eventsLimit = 50 } = opts;

  const time = {
    day: state.time.day,
    month: state.time.month,
    year: state.time.year,
    totalDays: state.time.totalDays,
  };

  // Country del actor — si es player, PLAYER_COUNTRY_ID; si es AI farmer,
  // lo lee de su record (ai.countryId).
  const actorCid = countryOfActor(state, actorId);

  // Actor-specific data.
  const wallet = walletOf(state, actorId);
  const actor = {
    id: actorId,
    cash: wallet?.cash ?? 0,
    bankrupt: wallet?.bankrupt ?? false,
    countryId: actorCid,
    inventoryByCountry: cloneInventory(wallet?.inventoryByCountry),
    tilesOwned: listTilesOwnedBy(state, actorId),
    loans: (state.loans ?? [])
      .filter(l => l.borrowerId === actorId || (actorId === 'player' && l.borrowerId == null))
      .map(l => ({
        id: l.id, productId: l.productId,
        principal: l.principal, balance: l.balance,
        monthlyPayment: l.monthlyPayment,
        status: l.status,
      })),
    brainParams: wallet?.brainParams,
    brainMemory: wallet?.brainMemory,
    keepFraction: wallet?.keepFraction,
  };

  const countries = collectCountries(state);

  // Ventures (legacy slot, sólo se llena para el player por backward compat).
  const ventures = actorId === 'player' ? listPlayerVentures(state) : [];

  // Event slices.
  const eh = state.eventHistory ?? [];
  const strategic = eh.filter(e => (e.tier ?? 3) <= 2).slice(-eventsLimit);
  const warnings = eh.filter(e => WARNING_CATEGORIES.test(e.category || '')).slice(-20);
  const events = { strategic, warnings };
  if (includeTactical) {
    events.tactical = eh.filter(e => (e.tier ?? 3) === 3).slice(-eventsLimit);
  }

  // Forecast bindings — closures que ya saben el country del actor. Le dan
  // al brain todo lo necesario para evaluar ventures (costos, precios futuros,
  // pipeline) sin importarse del state directamente.
  const forecast = {
    expectedPriceAt: (pid, daysAhead) => expectedPriceAt(state, actorCid, pid, daysAhead),
    pipelineSupplyFor: (pid) => pipelineSupplyFor(state, actorCid, pid),
    setupCost: (pid) => effectiveSetupCost(state, actorCid, PRODUCIBLES[pid]),
    plowCost: () => effectivePlowCost(state, actorCid),
    harvestCost: (pid) => effectiveHarvestCost(state, actorCid, PRODUCIBLES[pid]),
    tilePriceFor: (tileId, countryId) => {
      const t = tileById(state, countryId ?? actorCid, tileId);
      return t ? tilePrice(t, state) : 0;
    },
    // Lista de tiles wild (disponibles para comprar) en el country del actor.
    wildTiles: () => {
      const map = state.maps?.[actorCid];
      if (!map) return [];
      return map.tiles
        .filter(t => t.owner === 'wild')
        .map(t => ({ id: t.id, x: t.x, y: t.y, quality: round3(t.quality ?? 0), price: tilePrice(t, state) }));
    },
  };

  return {
    time,
    actor,
    countries,
    ventures,
    events,
    forecast,
    playerCountryId: PLAYER_COUNTRY_ID,
    // Backward compat: si actorId === 'player', exponer también como `player`
    // para que callers viejos sigan funcionando.
    player: actorId === 'player' ? actor : undefined,
  };
}

// observe(state) — wrapper backward compat. Equivale a observeForActor(state, 'player').
export function observe(state, opts = {}) {
  return observeForActor(state, 'player', opts);
}

function countryOfActor(state, actorId) {
  if (actorId === 'player') return PLAYER_COUNTRY_ID;
  const ai = state.aiFarmers?.find(a => a.id === actorId);
  return ai?.countryId ?? PLAYER_COUNTRY_ID;
}

function listTilesOwnedBy(state, actorId) {
  const out = [];
  for (const cid of COUNTRY_IDS) {
    const map = state.maps?.[cid];
    if (!map) continue;
    for (const t of map.tiles) {
      if (t.owner !== actorId) continue;
      out.push({
        id: t.id, x: t.x, y: t.y, countryId: cid,
        state: t.state, lockType: t.lockType,
        crop: t.crop, growth: t.growth, ageDays: t.ageDays,
        autoMode: t.autoMode, autoReplant: t.autoReplant,
        quality: round3(t.quality ?? 0),
      });
    }
  }
  return out;
}

function collectCountries(state) {
  const countries = {};
  for (const cid of COUNTRY_IDS) {
    const c = state.countries[cid];
    if (!c) continue;
    const prices = {};
    const ma30 = {};
    const marketStock = {};
    const offMarket = {};
    const supplyDay = {};
    const consumeDay = {};
    for (const pid of PRODUCIBLE_IDS) {
      prices[pid] = round2(state.market.prices?.[cid]?.[pid] ?? 0);
      ma30[pid] = round2(priceMA(state, pid, cid, 30));
      marketStock[pid] = Math.round(state.market.inventory?.[cid]?.[pid] ?? 0);
      offMarket[pid] = Math.round(offMarketInventoryFor(state, cid, pid));
      supplyDay[pid] = Math.round(c.supplyToday?.[pid] ?? 0);
      consumeDay[pid] = Math.round(c.consumptionDay?.[pid] ?? 0);
    }
    countries[cid] = {
      priceIndex: round3(c.priceIndex ?? 1),
      wageRate: Math.round(c.wageRate ?? 0),
      population: Math.round(c.population ?? 0),
      treasury: Math.round(c.treasury ?? 0),
      wageFund: Math.round(c.wageFund ?? 0),
      marketPool: Math.round(c.marketPool ?? 0),
      laborSupply: Math.round(c.laborSupply ?? 0),
      laborDemand: Math.round(c.laborDemand ?? 0),
      fiscalCrisis: c.fiscalCrisis?.active ? { ...c.fiscalCrisis } : null,
      prices, priceMA30: ma30,
      marketStock, offMarketStock: offMarket,
      supplyDay, consumeDay,
    };
  }
  return countries;
}

// =============================================================================
// Helpers — kept private to this module.
// =============================================================================
function round2(n) { return Math.round(n * 100) / 100; }
function round3(n) { return Math.round(n * 1000) / 1000; }

function cloneInventory(byCountry) {
  if (!byCountry) return {};
  const out = {};
  for (const [cid, dict] of Object.entries(byCountry)) {
    const inner = {};
    for (const [pid, qty] of Object.entries(dict)) {
      if (qty) inner[pid] = Math.round(qty);
    }
    out[cid] = inner;
  }
  return out;
}

function listPlayerVentures(_state) {
  return [];
}

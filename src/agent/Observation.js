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

const WARNING_CATEGORIES = /fiscal|default|crash|foreclose|bankrupt|world-event/;

export function observe(state, opts = {}) {
  const { includeTactical = false, eventsLimit = 50 } = opts;

  const time = {
    day: state.time.day,
    month: state.time.month,
    year: state.time.year,
    totalDays: state.time.totalDays,
  };

  const player = {
    cash: state.player.cash,
    bankrupt: state.player.bankrupt,
    inventoryByCountry: cloneInventory(state.player.inventoryByCountry),
    tilesOwned: listPlayerTiles(state),
    loans: (state.loans ?? [])
      .filter(l => l.borrowerId === 'player' || l.borrowerId == null)
      .map(l => ({
        id: l.id, productId: l.productId,
        principal: l.principal, balance: l.balance,
        monthlyPayment: l.monthlyPayment,
        status: l.status,
      })),
  };

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

  // Ventures = industries del player + tiles farm/mine del player. El bot
  // necesita verlos como una sola lista uniforme — no le importa la diferencia
  // de implementación. Cada uno con `status` y `monthlyMargin30d` cuando aplica.
  const ventures = listPlayerVentures(state);

  // Event slices.
  const eh = state.eventHistory ?? [];
  const strategic = eh.filter(e => (e.tier ?? 3) <= 2).slice(-eventsLimit);
  const warnings = eh.filter(e => WARNING_CATEGORIES.test(e.category || '')).slice(-20);
  const events = { strategic, warnings };
  if (includeTactical) {
    events.tactical = eh.filter(e => (e.tier ?? 3) === 3).slice(-eventsLimit);
  }

  return {
    time,
    player,
    countries,
    ventures,
    events,
    playerCountryId: PLAYER_COUNTRY_ID,
  };
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

function listPlayerTiles(state) {
  const out = [];
  for (const cid of COUNTRY_IDS) {
    const map = state.maps?.[cid];
    if (!map) continue;
    for (const t of map.tiles) {
      if (t.owner !== 'player') continue;
      out.push({
        id: t.id, x: t.x, y: t.y, countryId: cid,
        state: t.state, lockType: t.lockType,
        crop: t.crop, growth: t.growth, ageDays: t.ageDays,
        autoMode: t.autoMode, autoReplant: t.autoReplant,
        miningStatus: t.miningStatus,
        industryId: t.industryId,
        surveyed: t.surveyed,
        minerals: t.surveyed ? { ...t.minerals } : null,
        quality: round3(t.quality ?? 0),
      });
    }
  }
  return out;
}

function listPlayerVentures(state) {
  const out = [];
  // Player-owned industries are stored in state.industries with ownerId='player'.
  for (const ind of state.industries ?? []) {
    if (ind.ownerId !== 'player') continue;
    out.push({
      kind: 'industry',
      id: ind.id,
      tileId: ind.tileId,
      countryId: ind.countryId,
      recipeId: ind.recipeId,
      status: ind.status,
      operationalDay: ind.operationalDay,
      lastCycleDay: ind.lastCycleDay,
    });
  }
  return out;
}

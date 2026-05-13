// Market — per-country prices, supply/demand resolution, cross-country trade,
// transactions with taxes + wages, population spending.
//
// This module is the "money rails" of the simulation. Every monetary movement
// runs through executeTransaction to guarantee taxes/wages/ledger consistency.

import { MARKET, ECONOMY_DEFAULTS, WAGES } from '../data/tunables.js';
import { PRODUCIBLES, PRODUCIBLE_IDS } from '../data/producibles.js';
import { COUNTRIES, COUNTRY_IDS, PLAYER_COUNTRY_ID } from '../data/countries.js';
import { tickPriceIndex } from './PriceIndex.js';
import { executeTransaction, walletOf } from './Transactions.js';
import { recordMarketSnapshot } from './MarketHistory.js';
import { tickProductionDecisions } from './Production.js';

export { executeTransaction } from './Transactions.js';
export { elasticityFor, elasticityTargetFor } from './Production.js';

export function marketParam(producible, key) {
  return producible.market?.[key] ?? ECONOMY_DEFAULTS[key];
}

// =============================================================================
// Country runtime state
// =============================================================================
export function createCountriesState() {
  const runtime = {};
  for (const id of COUNTRY_IDS) {
    const c = COUNTRIES[id];
    runtime[id] = {
      id,
      taxRatesId: c.taxRatesId,
      population: c.population,
      consumption: { ...c.consumption },     // sizing parameter for targetStock + priceIndex weight + world-event scaling
      supplyToday: {},                       // unidades vendidas hoy por agentes reales; tickMarket las traslada a m.inventory y resetea al final
      consumptionDay: {},                    // unidades compradas hoy por agentes reales (alimenta market snapshot CSV)
      preferenceModifiers: {},
      tradeBalanceEMA: {},
      decisionLog: {},
      // === Money loop ============================================================
      marketPool: 0,                    // wholesale market cash balance — closes loop
      // === Inflation tracking ====================================================
      priceIndex: 1.0,                  // EMA of basket vs basePrice; starts at 1
      priceIndexHistory: [1.0],         // 360-day rolling
      // === Saturation (per producible) ===========================================
      saturatedDays: {},                // pid → consecutive days a sale failed
    };
    for (const pid of PRODUCIBLE_IDS) {
      runtime[id].tradeBalanceEMA[pid] = 0;
      runtime[id].decisionLog[pid] = [1.0];
      runtime[id].saturatedDays[pid] = 0;
    }
  }
  return runtime;
}

// =============================================================================
// Per-country market initialization
// =============================================================================
export function recomputeTargetStocks(state) {
  const m = state.market;
  for (const cid of COUNTRY_IDS) {
    if (!m.targetStock[cid]) m.targetStock[cid] = {};
    for (const pid of PRODUCIBLE_IDS) {
      const dem = state.countries[cid].consumption[pid] || 0;
      m.targetStock[cid][pid] = Math.max(20, Math.round(dem * MARKET.stockBufferDays));
    }
  }
}

export function initMarket(state) {
  const m = state.market;
  m.prices = {}; m.history = {}; m.inventory = {}; m.targetStock = {};
  for (const cid of COUNTRY_IDS) {
    m.prices[cid] = {}; m.history[cid] = {}; m.inventory[cid] = {};
    for (const pid of PRODUCIBLE_IDS) {
      const def = PRODUCIBLES[pid];
      const base = marketParam(def, 'basePrice');
      m.prices[cid][pid] = base;
      m.history[cid][pid] = [base];
    }
  }
  recomputeTargetStocks(state);
  for (const cid of COUNTRY_IDS) {
    for (const pid of PRODUCIBLE_IDS) {
      m.inventory[cid][pid] = state.market.targetStock[cid][pid] ?? 50;
    }
  }
}

// =============================================================================
// Daily market tick
// =============================================================================
const TRADE_FLOW_KEEP_DAYS = 60;

export function tickMarket(state) {
  tickProductionDecisions(state);

  // Prune old trade-flow records once per day. The World view needs at most
  // 30 days of history; we keep 60 as a buffer.
  if (state.tradeFlows && state.tradeFlows.length) {
    const cutoff = state.time.totalDays - TRADE_FLOW_KEEP_DAYS;
    let keepFrom = 0;
    while (keepFrom < state.tradeFlows.length && state.tradeFlows[keepFrom].day < cutoff) keepFrom++;
    if (keepFrom > 0) state.tradeFlows.splice(0, keepFrom);
  }

  const m = state.market;
  // Per-country daily consumption counter — reset at top of tickMarket,
  // accumulated EXCLUSIVELY by populationSpend on real food sales (and any
  // future real buyer that wants to flag itself here). Feeds the snapshot CSV.
  for (const cid of COUNTRY_IDS) {
    if (!state.countries[cid].consumptionDay) state.countries[cid].consumptionDay = {};
    for (const pid of PRODUCIBLE_IDS) state.countries[cid].consumptionDay[pid] = 0;
  }

  // Per-country: trasladar la pulsación de supply real (lo que vendieron los
  // agentes hoy) a la góndola. La drainage de la góndola ocurre directamente
  // en los buyers reales (populationSpend para comida, buyFromGlobal para
  // industrias/player). No hay más capa macro abstracta.
  for (const cid of COUNTRY_IDS) {
    const c = state.countries[cid];
    for (const pid of PRODUCIBLE_IDS) {
      const supply = c.supplyToday[pid] || 0;
      if (supply > 0) {
        m.inventory[cid][pid] = (m.inventory[cid][pid] || 0) + supply;
      }
      // tradeBalanceEMA — la UI del modal del país lo lee. Ahora refleja
      // sólo el surplus real (positivo si vendieron, neutro si no). Deficits
      // se ven directamente como caída de m.inventory por los buyers reales.
      const prev = c.tradeBalanceEMA[pid] ?? 0;
      c.tradeBalanceEMA[pid] = prev * 0.85 + (-supply) * 0.15;
    }
  }

  // Cross-country movement of goods is now handled by Exporters.js (agent-
  // driven shipping with transit delays). `state.tradeFlows` gets populated
  // when an exporter cargo settles in its destination, not from a magic loop
  // here.

  // Per-country price update via stock gap. Also applies saturation pressure: when
  // a country's market has been unable to absorb production, local price drifts down
  // gradually (proportional to consecutive saturated days, capped).
  for (const cid of COUNTRY_IDS) {
    const c = state.countries[cid];
    for (const pid of PRODUCIBLE_IDS) {
      const target = m.targetStock[cid][pid] || 50;
      const inv = m.inventory[cid][pid] || 0;
      const supToday = c.supplyToday[pid] || 0;
      // Item extinto: nadie produjo hoy, la góndola está vacía. La fórmula
      // gap-driven leería gap=1 → price sube indefinidamente sin que exista
      // ni un cajón ni una transacción para anclar el valor. Freezar el
      // precio hasta que alguien vuelva a producir o aparezca stock — eso
      // es el ancla natural del modelo. No es un cap (no acota el techo
      // alcanzable cuando SÍ hay actividad), es bien-definirlo cuando no.
      if (inv === 0 && supToday === 0) {
        m.history[cid][pid].push(m.prices[cid][pid]);
        continue;
      }
      const gap = (target - inv) / target;
      const noise = (Math.random() * 2 - 1) * MARKET.noiseAmp;
      let newPrice = m.prices[cid][pid] * (1 + gap * MARKET.responsiveness + noise);

      const sat = c?.saturatedDays?.[pid] || 0;
      if (sat > 0) {
        const cut = Math.min(0.04, 0.003 * sat);
        newPrice *= (1 - cut);
      }

      m.prices[cid][pid] = Math.max(MARKET.absoluteMinPrice, newPrice);
      m.history[cid][pid].push(m.prices[cid][pid]);
      // History is unbounded — push is O(1) and memory cost is small (one
      // float per producible × country × day). A 50-year game ≈ 10MB.
    }
  }

  // Inflation index update (after prices settle for the day).
  tickPriceIndex(state);

  // Record the day's market snapshot for the debug CSV export. Runs LAST so
  // every field (price, marketStock, supplyToday, consumptionDay, priceIndex,
  // wageRate) is fully settled. After this, supplyToday is safe to reset.
  recordMarketSnapshot(state);

  // Reset supplyToday for the next day's external producers to push into.
  for (const cid of COUNTRY_IDS) state.countries[cid].supplyToday = {};
}

// =============================================================================
// Public selectors
// =============================================================================
// Backward-compatible: 3rd arg can be lookback (number, old style) or countryId (string, new).
export function priceTrend(state, producibleId, arg3 = 7, lookback = 7) {
  let cid = PLAYER_COUNTRY_ID;
  let lb = lookback;
  if (typeof arg3 === 'string') cid = arg3; else lb = arg3;
  const h = state.market.history?.[cid]?.[producibleId];
  if (!h || h.length < 2) return 0;
  const recent = h[h.length - 1];
  const past = h[Math.max(0, h.length - 1 - lb)];
  return (recent - past) / past;
}

// Moving average for AI build/close decisions.
export function priceMA(state, producibleId, countryId, days = 30) {
  const h = state.market.history?.[countryId]?.[producibleId];
  if (!h || h.length === 0) return 0;
  const slice = h.slice(-days);
  return slice.reduce((s, x) => s + x, 0) / slice.length;
}

// === Inventory helpers — used by EVERY wallet (player, AI farmer, exporter)
// so AI and player share one code path. SOLID: single source of truth for
// inventory access; adding a new actor type doesn't require new helpers.
//
// Wallets store inventory as `wallet.inventoryByCountry[cid][pid]`. Goods
// physically live in a country and can't teleport — AI is tied to its country
// so only one slot is ever used; the player can hold inventory in any country
// they've bought into.

// Returns the per-country inventory dict, auto-creating the country slot.
export function inventoryFor(wallet, cid) {
  if (!wallet) return {};
  if (!wallet.inventoryByCountry) wallet.inventoryByCountry = {};
  if (!wallet.inventoryByCountry[cid]) wallet.inventoryByCountry[cid] = {};
  return wallet.inventoryByCountry[cid];
}

// Sum a producible's qty across every country slot. Used for storage billing
// and "total holdings" displays.
export function totalInventoryOf(wallet, producibleId) {
  if (!wallet?.inventoryByCountry) return 0;
  let total = 0;
  for (const c of Object.values(wallet.inventoryByCountry)) {
    total += c[producibleId] || 0;
  }
  return total;
}

// Per-country units total — used by per-country storage cost calculation.
export function unitsInCountry(wallet, cid) {
  const dict = wallet?.inventoryByCountry?.[cid];
  if (!dict) return 0;
  let total = 0;
  for (const q of Object.values(dict)) total += Math.max(0, q);
  return total;
}

// Backwards-compat / convenience getter. If `cid` is omitted returns the
// total across countries (legacy semantic for player); otherwise the per-cid
// qty. AI callers pass the AI's countryId.
export function inventoryOf(state, ownerId, producibleId, cid = null) {
  const wallet = walletOf(state, ownerId);
  if (!wallet) return 0;
  if (cid) return wallet.inventoryByCountry?.[cid]?.[producibleId] ?? 0;
  return totalInventoryOf(wallet, producibleId);
}

export function marketInventoryOf(state, producibleId, countryId = PLAYER_COUNTRY_ID) {
  return state.market.inventory?.[countryId]?.[producibleId] ?? 0;
}

// Total off-market stock of `producibleId` held in `countryId` across EVERY
// wallet — player, AI farmers, exporters. Used by:
//   - the Market modal "Off" column (instead of the old AI-only helper)
//   - the MarketHistory snapshot recorder (one source of truth)
// Both consumers see the same number — no chance of UI showing X while CSV
// records Y. New wallet types (banks, gov, etc.) get included for free as
// long as they register in state.wallets.
export function offMarketInventoryFor(state, countryId, producibleId) {
  let total = 0;
  total += state.player?.inventoryByCountry?.[countryId]?.[producibleId] ?? 0;
  for (const ai of state.aiFarmers ?? []) {
    total += ai.inventoryByCountry?.[countryId]?.[producibleId] ?? 0;
  }
  for (const exp of state.exporters ?? []) {
    total += exp.inventoryByCountry?.[countryId]?.[producibleId] ?? 0;
  }
  return total;
}

// Sum trade flows in the last `days` from src→dst. If `producibleId` is null,
// sums across all producibles. Used by the World view to render arrow widths.
export function tradeFlowVolume(state, src, dst, producibleId = null, days = 30) {
  const flows = state.tradeFlows;
  if (!flows || flows.length === 0) return 0;
  const cutoff = state.time.totalDays - days;
  let sum = 0;
  for (let i = flows.length - 1; i >= 0; i--) {
    const f = flows[i];
    if (f.day < cutoff) break;
    if (f.src !== src || f.dst !== dst) continue;
    if (producibleId && f.pid !== producibleId) continue;
    sum += f.units;
  }
  return sum;
}

export { populationSpend } from './Population.js';

// =============================================================================
// Sellers route harvests through their local country
// =============================================================================
// Deposit a harvest into the wallet's per-country inventory. Goods physically
// live where they were produced — cross-country movement requires an exporter.
// Single source of truth for harvest landing — used by player manual harvest,
// player auto-harvest, AI farmer harvest. Vendido posterior via sellFromInventory.
export function harvestToInventory(state, ownerId, producibleId, units, countryId = PLAYER_COUNTRY_ID) {
  const wallet = walletOf(state, ownerId);
  if (!wallet) return 0;
  const inv = inventoryFor(wallet, countryId);
  inv[producibleId] = (inv[producibleId] || 0) + units;
  return units;
}

export function sellFromInventory(state, ownerId, producibleId, units, countryId = PLAYER_COUNTRY_ID) {
  const wallet = walletOf(state, ownerId);
  if (!wallet) return { ok: false, reason: 'No wallet' };
  const inv = inventoryFor(wallet, countryId);
  const have = inv[producibleId] || 0;
  const sell = Math.min(Math.floor(units), have);
  if (sell <= 0) return { ok: false, reason: 'Nothing to sell here' };
  const price = state.market.prices?.[countryId]?.[producibleId] || 0;
  if (price <= 0) return { ok: false, reason: 'No market price' };
  const r = executeTransaction(state, {
    sellerId: ownerId,
    buyerId: 'foreign',
    productId: producibleId,
    units: sell,
    unitPrice: price,
    countryOfTransaction: countryId,
    sellerCountryId: countryId,
    type: 'b2b',
  });
  if (!r.ok) return { ok: false, reason: r.reason };
  inv[producibleId] = have - sell;
  const country = state.countries[countryId];
  if (country) country.supplyToday[producibleId] = (country.supplyToday[producibleId] || 0) + sell;
  return { ok: true, units: sell, revenue: r.netToSeller, price };
}

export function buyFromGlobal(state, ownerId, producibleId, units, countryId = PLAYER_COUNTRY_ID) {
  const wallet = walletOf(state, ownerId);
  if (!wallet) return { ok: false, reason: 'Wallet missing' };
  const stock = state.market.inventory?.[countryId]?.[producibleId] || 0;
  const buy = Math.min(Math.floor(units), stock);
  if (buy <= 0) return { ok: false, reason: 'Out of stock' };
  const price = state.market.prices?.[countryId]?.[producibleId] || 0;
  const isImport = ownerId !== 'foreign' && countryId !== PLAYER_COUNTRY_ID;
  const r = executeTransaction(state, {
    sellerId: 'foreign',
    buyerId: ownerId,
    productId: producibleId,
    units: buy,
    unitPrice: price,
    countryOfTransaction: countryId,
    sellerCountryId: countryId,
    type: isImport ? 'import' : 'sale',
  });
  if (!r.ok) return { ok: false, reason: r.reason };
  state.market.inventory[countryId][producibleId] -= buy;
  const inv = inventoryFor(wallet, countryId);
  inv[producibleId] = (inv[producibleId] || 0) + buy;
  return { ok: true, units: buy, cost: r.grossRevenue + r.taxPaid + r.transportPaid, price };
}

// =============================================================================
// Yearly tick — population growth scales consumption per country
// =============================================================================
export function tickCountriesYearly(state) {
  for (const cid of COUNTRY_IDS) {
    const reg = COUNTRIES[cid];
    const c = state.countries[cid];
    const noise = (Math.random() * 2 - 1) * 0.005;
    c.population *= (1 + (reg.populationGrowth ?? 0) + noise);
    const popRatio = c.population / reg.population;
    for (const pid of PRODUCIBLE_IDS) {
      c.consumption[pid] = (reg.consumption[pid] || 0) * popRatio;
    }
  }
  recomputeTargetStocks(state);
}

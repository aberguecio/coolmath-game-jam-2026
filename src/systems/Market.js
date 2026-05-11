// Market — per-country prices, supply/demand resolution, cross-country trade,
// transactions with taxes + wages, population spending.
//
// This module is the "money rails" of the simulation. Every monetary movement
// runs through executeTransaction to guarantee taxes/wages/ledger consistency.

import { MARKET, ECONOMY_DEFAULTS, WAGES } from '../data/tunables.js';
import { PRODUCIBLES, PRODUCIBLE_IDS } from '../data/producibles.js';
import { COUNTRIES, COUNTRY_IDS, PLAYER_COUNTRY_ID } from '../data/countries.js';
import { transportCost } from '../data/distances.js';
import { tickPriceIndex } from './PriceIndex.js';
import { executeTransaction, walletOf } from './Transactions.js';
import {
  tickProductionDecisions, effectiveProduction,
} from './Production.js';

export { executeTransaction } from './Transactions.js';
export {
  effectiveProductionFor, elasticityFor, elasticityTargetFor,
} from './Production.js';

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
      consumption: { ...c.consumption },
      production: { ...c.domesticProduction },
      supplyToday: {},
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
function totalDailyDemand(state, producibleId) {
  let total = 0;
  for (const cid of COUNTRY_IDS) total += state.countries[cid].consumption[producibleId] || 0;
  return total;
}

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
  m.dailyConsumption = {};
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
  for (const pid of PRODUCIBLE_IDS) m.dailyConsumption[pid] = 0;

  // Per-country: resolve local supply/demand, update local inventory.
  for (const cid of COUNTRY_IDS) {
    const c = state.countries[cid];
    for (const pid of PRODUCIBLE_IDS) {
      const prefMod = c.preferenceModifiers?.[pid] ?? 1;
      const supply = effectiveProduction(state, c, pid) + (c.supplyToday[pid] || 0);
      const demand = (c.consumption[pid] || 0) * prefMod;
      const net = supply - demand;
      const tradeBalance = -net;

      if (net > 0) {
        m.inventory[cid][pid] = (m.inventory[cid][pid] || 0) + net;
      } else if (net < 0) {
        const want = -net;
        const have = m.inventory[cid][pid] || 0;
        const taken = Math.min(want, have);
        m.inventory[cid][pid] = have - taken;
        m.dailyConsumption[pid] += taken;
      }
      const prev = c.tradeBalanceEMA[pid] ?? 0;
      c.tradeBalanceEMA[pid] = prev * 0.85 + tradeBalance * 0.15;
    }
    c.supplyToday = {};
  }

  // Cross-country arbitrage — if a country's price > another's price + transport, ship units.
  // Limited per pair per day so prices don't fully equalize instantly.
  for (const pid of PRODUCIBLE_IDS) {
    for (const dst of COUNTRY_IDS) {
      const dstPrice = m.prices[dst][pid];
      const dstInv = m.inventory[dst][pid] || 0;
      const dstTarget = m.targetStock[dst][pid] || 50;
      // Only refuse to import when fully stocked. The inner loop already
      // requires `delivered < dstPrice`, so we don't import unless there's a
      // real price gap.
      if (dstInv >= dstTarget) continue;
      // Find cheapest source (foreign + transport) under dstPrice.
      let bestSrc = null, bestDelivered = Infinity;
      for (const src of COUNTRY_IDS) {
        if (src === dst) continue;
        const srcInv = m.inventory[src][pid] || 0;
        if (srcInv <= 0) continue;
        const srcPrice = m.prices[src][pid];
        const tCost = transportCost(src, dst, 1);
        const delivered = srcPrice + tCost;
        if (delivered < dstPrice && delivered < bestDelivered) {
          bestSrc = src; bestDelivered = delivered;
        }
      }
      if (bestSrc) {
        const maxUnits = Math.min(
          m.inventory[bestSrc][pid] * 0.10,                  // up to 10% of source per day
          (dstTarget - dstInv) * 0.7,                        // close 70% of the gap
        );
        const units = Math.max(0, Math.floor(maxUnits));
        if (units > 0) {
          m.inventory[bestSrc][pid] -= units;
          m.inventory[dst][pid]    += units;
          // Record the transfer so the World view can render directional flows.
          if (!state.tradeFlows) state.tradeFlows = [];
          state.tradeFlows.push({
            day: state.time.totalDays,
            src: bestSrc, dst, pid, units,
          });
        }
      }
    }
  }

  // Per-country price update via stock gap. Also applies saturation pressure: when
  // a country's market has been unable to absorb production, local price drifts down
  // gradually (proportional to consecutive saturated days, capped).
  for (const cid of COUNTRY_IDS) {
    const c = state.countries[cid];
    for (const pid of PRODUCIBLE_IDS) {
      const target = m.targetStock[cid][pid] || 50;
      const inv = m.inventory[cid][pid] || 0;
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
}

// =============================================================================
// Public selectors
// =============================================================================
export function priceOf(state, producibleId, countryId = PLAYER_COUNTRY_ID) {
  return Math.round(state.market.prices?.[countryId]?.[producibleId] || 0);
}

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

export function inventoryOf(state, ownerId, producibleId) {
  const wallet = walletOf(state, ownerId);
  return wallet?.inventory?.[producibleId] ?? 0;
}

export function marketInventoryOf(state, producibleId, countryId = PLAYER_COUNTRY_ID) {
  return state.market.inventory?.[countryId]?.[producibleId] ?? 0;
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
export function sellToMarket(state, producibleId, units, countryId = PLAYER_COUNTRY_ID) {
  const country = state.countries[countryId];
  if (country) {
    country.supplyToday[producibleId] = (country.supplyToday[producibleId] || 0) + units;
  }
  const price = state.market.prices?.[countryId]?.[producibleId] || 0;
  return Math.round(price * units);
}

export function harvestToInventory(state, ownerId, producibleId, units) {
  const wallet = walletOf(state, ownerId);
  if (!wallet) return 0;
  if (!wallet.inventory) wallet.inventory = {};
  wallet.inventory[producibleId] = (wallet.inventory[producibleId] || 0) + units;
  return units;
}

export function sellFromInventory(state, ownerId, producibleId, units, countryId = PLAYER_COUNTRY_ID) {
  const wallet = walletOf(state, ownerId);
  if (!wallet || !wallet.inventory) return { ok: false, reason: 'No inventory' };
  const have = wallet.inventory[producibleId] || 0;
  const sell = Math.min(Math.floor(units), have);
  if (sell <= 0) return { ok: false, reason: 'Nothing to sell' };
  const price = state.market.prices?.[countryId]?.[producibleId] || 0;
  if (price <= 0) return { ok: false, reason: 'No market price' };
  // Player sells via the local market: 'b2b' (seller is a producer, buyer is the abstract market)
  const r = executeTransaction(state, {
    sellerId: ownerId,
    buyerId: 'foreign',                  // generic market sink
    productId: producibleId,
    units: sell,
    unitPrice: price,
    countryOfTransaction: countryId,
    sellerCountryId: countryId,
    type: 'b2b',
  });
  if (!r.ok) return { ok: false, reason: r.reason };
  wallet.inventory[producibleId] = have - sell;
  // Inject supply into country pool so price reacts on next tick
  const country = state.countries[countryId];
  if (country) country.supplyToday[producibleId] = (country.supplyToday[producibleId] || 0) + sell;
  return { ok: true, units: sell, revenue: r.netToSeller, price };
}

export function buyFromGlobal(state, ownerId, producibleId, units, countryId = PLAYER_COUNTRY_ID) {
  const wallet = walletOf(state, ownerId);
  if (!wallet) return { ok: false, reason: 'Wallet missing' };
  if (!wallet.inventory) wallet.inventory = {};
  const stock = state.market.inventory?.[countryId]?.[producibleId] || 0;
  const buy = Math.min(Math.floor(units), stock);
  if (buy <= 0) return { ok: false, reason: 'Out of stock' };
  const price = state.market.prices?.[countryId]?.[producibleId] || 0;
  // Buyer pays sale + tax via executeTransaction (player buying off market = sale)
  const sellerCountry = countryId;
  const isImport = ownerId !== 'foreign' && countryId !== PLAYER_COUNTRY_ID;
  const r = executeTransaction(state, {
    sellerId: 'foreign',
    buyerId: ownerId,
    productId: producibleId,
    units: buy,
    unitPrice: price,
    countryOfTransaction: countryId,
    sellerCountryId: sellerCountry,
    type: isImport ? 'import' : 'sale',
  });
  if (!r.ok) return { ok: false, reason: r.reason };
  state.market.inventory[countryId][producibleId] -= buy;
  wallet.inventory[producibleId] = (wallet.inventory[producibleId] || 0) + buy;
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
    c.dailyNutritionNeed = c.population * WAGES.dailyFoodCostPerCapita * 0.25;
  }
  recomputeTargetStocks(state);
}

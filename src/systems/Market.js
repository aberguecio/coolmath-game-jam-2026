// Market — per-country prices, supply/demand resolution, cross-country trade,
// transactions with taxes + wages, population spending.
//
// This module is the "money rails" of the simulation. Every monetary movement
// runs through executeTransaction to guarantee taxes/wages/ledger consistency.

import { MARKET, ECONOMY_DEFAULTS, WAGES } from '../data/tunables.js';
import { PRODUCIBLES, PRODUCIBLE_IDS, isFood, isTileGrowable } from '../data/producibles.js';
import { COUNTRIES, COUNTRY_IDS, PLAYER_COUNTRY_ID } from '../data/countries.js';
import { effectiveTaxRates } from '../data/taxRates.js';
import { distanceBetween, transportCost } from '../data/distances.js';

// =============================================================================
// Helpers — wallets & ledger
// =============================================================================
function walletOf(state, ownerId) {
  if (ownerId === 'player') return state.player;
  if (ownerId === 'population' || ownerId === 'treasury') return null;
  if (ownerId === 'foreign') return null;
  return state.aiFarmers?.find(a => a.id === ownerId) ?? null;
}

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
// Production elasticity (delay-line, per-country)
// =============================================================================
function plantingDecision(state, country, producibleId) {
  const def = PRODUCIBLES[producibleId];
  if (!def) return 1;
  const basePrice = marketParam(def, 'basePrice') || 1;
  const localPrice = state.market.prices[country.id]?.[producibleId] || basePrice;
  const ratio = localPrice / basePrice;
  const reg = COUNTRIES[country.id];
  const responsiveness = reg?.supplyResponsiveness ?? 1.0;
  const factor = 1 + (ratio - 1) * responsiveness;
  return Math.max(MARKET.elasticityMin, Math.min(MARKET.elasticityMax, factor));
}

function tickProductionDecisions(state) {
  for (const cid of COUNTRY_IDS) {
    const c = state.countries[cid];
    for (const pid of PRODUCIBLE_IDS) {
      const def = PRODUCIBLES[pid];
      // Processed producibles aren't farmed — no decision log meaningful.
      if (!isTileGrowable(pid)) continue;
      if (!c.decisionLog[pid]) c.decisionLog[pid] = [1.0];
      const log = c.decisionLog[pid];
      log.push(plantingDecision(state, c, pid));
      const maxLen = (def?.growthDays || 90) + 1;
      while (log.length > maxLen) log.shift();
    }
  }
}

function effectiveProduction(state, country, producibleId) {
  const base = country.production[producibleId] || 0;
  if (base <= 0) return 0;
  if (!isTileGrowable(producibleId)) return base; // processed: no elasticity, just baseline
  const log = country.decisionLog?.[producibleId];
  const scale = (log && log.length > 0) ? log[0] : 1.0;
  return base * scale;
}

// =============================================================================
// Daily market tick
// =============================================================================
export function tickMarket(state) {
  tickProductionDecisions(state);

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
      // Only import if local stock is below target (deficit pressure)
      if (dstInv > dstTarget * 0.8) continue;
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
          m.inventory[bestSrc][pid] * 0.05,                  // up to 5% of source per day
          (dstTarget - dstInv) * 0.5,                        // close half the gap
        );
        const units = Math.max(0, Math.floor(maxUnits));
        if (units > 0) {
          m.inventory[bestSrc][pid] -= units;
          m.inventory[dst][pid]    += units;
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
      if (m.history[cid][pid].length > 360) m.history[cid][pid].shift();
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

export function effectiveProductionFor(state, countryId, producibleId) {
  const c = state.countries[countryId];
  if (!c) return 0;
  return effectiveProduction(state, c, producibleId);
}

export function elasticityFor(state, countryId, producibleId) {
  const c = state.countries[countryId];
  if (!c) return 1;
  const log = c.decisionLog?.[producibleId];
  if (!log || log.length === 0) return 1;
  return log[0];
}

export function elasticityTargetFor(state, countryId, producibleId) {
  const c = state.countries[countryId];
  if (!c) return 1;
  return plantingDecision(state, c, producibleId);
}

// =============================================================================
// Inflation: price index per country, EMA of weighted food + materials basket
// =============================================================================
const INDEX_WEIGHTS = { food: 0.70, material: 0.30 };
const PRICE_INDEX_HALFLIFE_DAYS = 60;
const PRICE_INDEX_ALPHA = 1 - Math.pow(0.5, 1 / PRICE_INDEX_HALFLIFE_DAYS); // ~0.0115

export function tickPriceIndex(state) {
  for (const cid of COUNTRY_IDS) {
    const c = state.countries[cid];
    if (!c) continue;

    let foodNum = 0, foodDen = 0;
    let matNum = 0, matDen = 0;
    for (const pid of PRODUCIBLE_IDS) {
      const def = PRODUCIBLES[pid];
      if (!def) continue;
      const base = marketParam(def, 'basePrice') || 1;
      const localPrice = state.market.prices[cid][pid] || base;
      const ratio = localPrice / base;
      const cons = c.consumption[pid] || 0;
      if (def.commodityType === 'food') {
        const w = cons * (def.nutritionUnits || 1);
        foodNum += ratio * w;
        foodDen += w;
      } else {
        const w = Math.max(cons, 0.1);
        matNum += ratio * w;
        matDen += w;
      }
    }
    const foodComp = foodDen > 0 ? foodNum / foodDen : 1;
    const matComp = matDen > 0 ? matNum / matDen : 1;
    const basket = INDEX_WEIGHTS.food * foodComp + INDEX_WEIGHTS.material * matComp;
    c.priceIndex = (1 - PRICE_INDEX_ALPHA) * c.priceIndex + PRICE_INDEX_ALPHA * basket;
    c.priceIndexHistory.push(c.priceIndex);
    if (c.priceIndexHistory.length > 360) c.priceIndexHistory.shift();
  }
}

// Public selectors used by UI / other systems
export function priceIndexFor(state, countryId = PLAYER_COUNTRY_ID) {
  return state.countries?.[countryId]?.priceIndex ?? 1.0;
}
export function marketPoolFor(state, countryId = PLAYER_COUNTRY_ID) {
  return state.countries?.[countryId]?.marketPool ?? 0;
}

// Effective (inflation-adjusted) costs
export function effectiveSalary(state, cid, recipe) {
  return Math.round((recipe?.monthlySalary || 0) * priceIndexFor(state, cid));
}
export function effectiveBuildCost(state, cid, recipe) {
  return Math.round((recipe?.buildCost || 0) * priceIndexFor(state, cid));
}
export function effectivePlowCost(state, cid, baseCost) {
  return Math.round(baseCost * priceIndexFor(state, cid));
}
export function effectiveSeedCost(state, cid, def) {
  return Math.round((def?.seedCost || 0) * priceIndexFor(state, cid));
}
export function effectiveBaseRural(state, cid, basePrice) {
  return basePrice * priceIndexFor(state, cid);
}
export function effectiveSurveyCost(state, cid, baseCost) {
  return Math.round(baseCost * priceIndexFor(state, cid));
}

// Total money supply across all entities — for diagnostics. Should be near-constant.
export function totalMoneySupply(state) {
  let total = 0;
  if (state.player) total += state.player.cash || 0;
  if (state.aiFarmers) for (const a of state.aiFarmers) total += a.cash || 0;
  for (const cid of COUNTRY_IDS) {
    const c = state.countries[cid];
    if (!c) continue;
    total += (c.wageFund || 0) + (c.treasury || 0) + (c.marketPool || 0);
  }
  return total;
}

// =============================================================================
// executeTransaction — single chokepoint for all monetary movement
// =============================================================================
//
// types:
//   'sale'  retail (population buys from market)         — sale tax
//   'b2b'   company-to-company / industry buys input    — b2b tax
//   'import' cross-country arrival                       — import tax (stacks on source sale)
//
// sellerId / buyerId may be: 'player' | aiId | 'population' | 'treasury' | 'foreign'
//
// Returns explicitly { ok, reason?, grossRevenue, taxPaid, wagePaid, transportPaid, netToSeller }.
export function executeTransaction(state, params) {
  const {
    sellerId, buyerId,
    productId, units, unitPrice,
    countryOfTransaction,
    type = 'sale',
    sellerCountryId,
  } = params;

  if (!Number.isFinite(units) || units <= 0) {
    return { ok: false, reason: 'units<=0' };
  }
  if (!Number.isFinite(unitPrice) || unitPrice <= 0) {
    return { ok: false, reason: 'unitPrice<=0' };
  }
  if (!PRODUCIBLES[productId]) {
    return { ok: false, reason: 'unknown product' };
  }
  if (!state.countries[countryOfTransaction]) {
    return { ok: false, reason: 'unknown country' };
  }

  const def = PRODUCIBLES[productId];
  const grossRevenue = unitPrice * units;
  const rates = effectiveTaxRates(state, countryOfTransaction);
  const rate = rates[type] ?? rates.sale ?? 0;
  const taxPaid = grossRevenue * rate;
  const tCost = (sellerCountryId && sellerCountryId !== countryOfTransaction)
    ? transportCost(sellerCountryId, countryOfTransaction, units)
    : 0;
  const totalCost = grossRevenue + taxPaid + tCost;

  // Verify buyer can pay (skip for population/treasury — they have country pools).
  const buyerWallet = walletOf(state, buyerId);
  if (buyerWallet && buyerWallet.cash < totalCost) {
    return { ok: false, reason: 'buyer cash insufficient' };
  }
  // For population: check country.wageFund. For treasury: check treasury balance (negative ok).
  if (buyerId === 'population') {
    const c = state.countries[countryOfTransaction];
    if (!c || c.wageFund < totalCost) return { ok: false, reason: 'wageFund insufficient' };
  }

  // Wage portion is computed up-front — only flows when seller is a real producer.
  const sellerWallet = walletOf(state, sellerId);
  const isRealSeller = !!sellerWallet;
  const isRealBuyer = !!buyerWallet;
  const wagePortion = (isRealSeller && (type === 'sale' || type === 'b2b'))
    ? (def.wagePortion ?? 0.20) : 0;
  const wagePaid = grossRevenue * wagePortion;
  const netToSeller = grossRevenue - wagePaid;
  const sellerCountry = sellerCountryId || countryOfTransaction;

  // Routing is determined by who is real and who is virtual. The marketPool of the
  // appropriate country is the counter-party for every 'foreign' role. wageFund pays
  // for population. Money is conserved per the table in the plan.
  const txCountry = state.countries[countryOfTransaction];
  const sellerCountryRuntime = state.countries[sellerCountry];

  // Verify funds before mutating.
  if (isRealBuyer) {
    if (buyerWallet.cash < totalCost) return { ok: false, reason: 'buyer cash insufficient' };
  } else if (buyerId === 'population') {
    if (txCountry.wageFund < totalCost) return { ok: false, reason: 'wageFund insufficient' };
  } else if (buyerId === 'treasury') {
    // Treasury is allowed to go negative via crisis path; no precheck.
  } else if (buyerId === 'foreign') {
    // marketPool of the seller-country buys (it absorbs production).
    // Need enough to pay seller and wages.
    if (sellerCountryRuntime.marketPool < (netToSeller + wagePaid)) {
      // Saturation: bump counter, return failure so caller skips the sale.
      sellerCountryRuntime.saturatedDays[productId] =
        (sellerCountryRuntime.saturatedDays[productId] || 0) + 1;
      return { ok: false, reason: 'marketPool dry (saturated)' };
    }
  }

  // === Mutate ===
  // Reset saturation on success.
  if (sellerCountryRuntime?.saturatedDays?.[productId]) {
    sellerCountryRuntime.saturatedDays[productId] = 0;
  }

  // 1. Pull cash from buyer side.
  if (isRealBuyer) {
    buyerWallet.cash -= totalCost;
  } else if (buyerId === 'population') {
    txCountry.wageFund -= totalCost;
  } else if (buyerId === 'treasury') {
    txCountry.treasury -= totalCost;
  } else if (buyerId === 'foreign') {
    // marketPool[sellerCountry] is the buyer absorbing production
    sellerCountryRuntime.marketPool -= (netToSeller + wagePaid + taxPaid);
  }

  // 2. Tax flows to the country where the transaction occurred.
  txCountry.treasury += taxPaid;

  // 3. Wages flow into seller's country wageFund (only when real producer).
  if (isRealSeller && wagePaid > 0) {
    sellerCountryRuntime.wageFund += wagePaid;
  }

  // 4. Pay the seller side.
  if (isRealSeller) {
    sellerWallet.cash += netToSeller;
  } else if (sellerId === 'foreign') {
    // marketPool[txCountry] receives the cash for goods it just delivered.
    txCountry.marketPool += grossRevenue;
  }
  // (population/treasury never sell; their branches above are no-ops.)

  // 5. Ledger
  if (!state.ledger) state.ledger = [];
  state.ledger.push({
    day: state.time.totalDays,
    type, productId, units, unitPrice,
    sellerId, buyerId,
    countryOfTransaction, sellerCountryId: sellerCountry,
    grossRevenue, taxPaid, wagePaid, transportPaid: tCost, netToSeller,
  });
  if (state.ledger.length > 200) state.ledger.shift();

  return {
    ok: true,
    grossRevenue, taxPaid, wagePaid, transportPaid: tCost, netToSeller,
  };
}

// =============================================================================
// Population spending — affordability-driven, with substitution cascade
// =============================================================================
export function populationSpend(state) {
  for (const cid of COUNTRY_IDS) {
    const c = state.countries[cid];
    const reg = COUNTRIES[cid];
    const m = state.market;
    if (!reg || !c) continue;

    // Reset daily nutrition tally
    c.dailyNutritionConsumed = 0;

    // Build a sorted list of food producibles by preference × nutritionUnits / price.
    const candidates = [];
    for (const pid of PRODUCIBLE_IDS) {
      if (!isFood(pid)) continue;
      const prefBase = reg.preferences?.[pid] ?? 0;
      // Crisis preference compression: premium foods fade
      const crush = c.fiscalCrisis?.preferenceCrush ?? 0;
      const nutrition = PRODUCIBLES[pid].nutritionUnits ?? 0.5;
      const isPremium = nutrition < 0.7;
      const prefMod = c.preferenceModifiers?.[pid] ?? 1;
      const pref = prefBase * prefMod * (isPremium ? Math.max(0.2, 1 - crush) : 1 + crush * 0.5);
      if (pref <= 0) continue;
      const price = m.prices[cid][pid];
      const score = pref * nutrition / Math.max(0.5, price);
      candidates.push({ pid, pref, price, nutrition, score });
    }
    candidates.sort((a, b) => b.score - a.score);

    let budget = c.wageFund;
    const totalPref = candidates.reduce((s, x) => s + x.pref, 0) || 1;

    for (const cand of candidates) {
      if (budget <= 0) break;
      const inv = m.inventory[cid][cand.pid] || 0;
      if (inv <= 0) continue;
      // Allocate share of budget by preference weight
      const allocate = budget * (cand.pref / totalPref);
      const rates = effectiveTaxRates(state, cid);
      const unitTotal = cand.price * (1 + rates.sale);
      const wantUnits = allocate / unitTotal;
      const buyUnits = Math.min(wantUnits, inv);
      if (buyUnits <= 0) continue;
      // Atomic transaction
      const r = executeTransaction(state, {
        sellerId: 'foreign',                 // population buys from the country market pool
        buyerId: 'population',
        productId: cand.pid,
        units: buyUnits,
        unitPrice: cand.price,
        countryOfTransaction: cid,
        sellerCountryId: cid,
        type: 'sale',
      });
      if (!r.ok) continue;
      m.inventory[cid][cand.pid] -= buyUnits;
      c.dailyNutritionConsumed += buyUnits * cand.nutrition;
      budget -= (r.grossRevenue + r.taxPaid);
    }

    // Welfare top-up: if wageFund below floor, treasury fills the gap
    const floor = reg.population * WAGES.dailyFoodCostPerCapita * WAGES.wageFundFloorDays;
    if (c.wageFund < floor) {
      const gap = floor - c.wageFund;
      c.wageFund += gap;
      c.treasury -= gap;
    }
  }
}

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

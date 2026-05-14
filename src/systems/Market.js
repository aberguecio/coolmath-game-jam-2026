// Market — per-country prices, supply/demand resolution, cross-country trade,
// transactions with taxes + wages, population spending.
//
// This module is the "money rails" of the simulation. Every monetary movement
// runs through executeTransaction to guarantee taxes/wages/ledger consistency.

import { MARKET, ECONOMY_DEFAULTS, WAGES } from '../data/tunables.js';
import { PRODUCIBLES, PRODUCIBLE_IDS, isFood } from '../data/producibles.js';
import { COUNTRIES, COUNTRY_IDS, PLAYER_COUNTRY_ID } from '../data/countries.js';
import { tickPriceIndex } from './PriceIndex.js';
import { executeTransaction, walletOf, walletCountryFor } from './Transactions.js';
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
      consumption: { ...c.consumption },     // seed inicial del consumptionHistory + peso del basket de priceIndex + escalado por eventos/yearly. Ya NO drena marketStock (la limpieza lo sacó).
      // === Flow counters ==========================================================
      // Toda escritura pasa por _recordSupply/_recordConsumption.
      consumptionHistory: {},                // ring 90d: compras reales por pid (alimenta target dinámico)
      supplyHistory: {},                     // ring 90d: ventas reales por pid
      // Acumuladores del día actual — rotados a sus _History al inicio de cada tickMarket.
      supplyToday: {},
      consumptionDay: {},
      preferenceModifiers: {},
      tradeBalanceEMA: {},
      decisionLog: {},
      // === Money loop ============================================================
      marketPool: 0,                    // wholesale market cash balance — closes loop
      // === Inflation tracking ====================================================
      priceIndex: 1.0,                  // EMA of basket vs basePrice; starts at 1
      priceIndexHistory: [1.0],         // 360-day rolling
    };
    for (const pid of PRODUCIBLE_IDS) {
      runtime[id].tradeBalanceEMA[pid] = 0;
      runtime[id].decisionLog[pid] = [1.0];
      // Seed consumptionHistory SÓLO para items que la población realmente
      // compra (food). Minerales y procesados arrancan en 0 — su demanda real
      // viene cuando una industria los consume vía buyFromGlobal y eso
      // dispara _recordConsumption orgánicamente. Sin esto, los minerales
      // tenían un fantasma de demanda baseline que les hacía subir el precio
      // aunque nadie los compre nunca.
      const seed = isFood(pid) ? (c.consumption[pid] || 0) : 0;
      runtime[id].consumptionHistory[pid] = new Array(90).fill(seed);
      runtime[id].supplyHistory[pid] = new Array(90).fill(0);
    }
  }
  return runtime;
}

// =============================================================================
// Counter writes — single source of truth para "una venta/compra ocurrió hoy"
// =============================================================================
// Cualquier escritura a supplyToday/consumptionDay desde el motor pasa por acá.
function _recordSupply(country, pid, units) {
  if (!country || units <= 0) return;
  country.supplyToday = country.supplyToday || {};
  country.supplyToday[pid] = (country.supplyToday[pid] || 0) + units;
}

function _recordConsumption(country, pid, units) {
  if (!country || units <= 0) return;
  country.consumptionDay = country.consumptionDay || {};
  country.consumptionDay[pid] = (country.consumptionDay[pid] || 0) + units;
}

// Exposed wrapper para callers fuera de Market.js (Population.js lo usa).
export function recordConsumption(country, producibleId, units) {
  _recordConsumption(country, producibleId, units);
}

// =============================================================================
// Per-country market initialization
// =============================================================================
// Target dinámico: 30 días del promedio diario observado en los últimos 90.
// Sin floor — si nadie compró steel en 90 días, target=0 y el item se vuelve
// precio-libre (la fórmula del gap lo maneja explícitamente).
export function recomputeTargetStocks(state) {
  const m = state.market;
  for (const cid of COUNTRY_IDS) {
    if (!m.targetStock[cid]) m.targetStock[cid] = {};
    const c = state.countries[cid];
    for (const pid of PRODUCIBLE_IDS) {
      const hist = c?.consumptionHistory?.[pid];
      let avgDaily = 0;
      if (hist && hist.length > 0) {
        let sum = 0;
        for (const v of hist) sum += v;
        avgDaily = sum / hist.length;
      }
      m.targetStock[cid][pid] = Math.round(avgDaily * MARKET.stockBufferDays);
    }
  }
}

// Pares (acumulador-del-día → ring de 90 días) que tickMarket rota en cada tick.
// Para agregar un nuevo counter, una línea más.
const ROTATE_PAIRS = [
  ['supplyToday',    'supplyHistory'],
  ['consumptionDay', 'consumptionHistory'],
];

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
  // Inventory inicial: la góndola arranca con suficiente comida para que la
  // población sobreviva 1 MES completo aunque la producción agraria todavía
  // no haya rendido nada. Sin esto, los crops tardan 35-90+ días en madurar
  // y la población pasa hambre durante semanas hasta la primera cosecha.
  //
  // Reparto: el total de nutrición necesaria (pop × nutritionPerCapita × 30)
  // se distribuye entre los foods proporcional a la preferencia del país,
  // luego se convierte a unidades dividiendo por nutritionUnits de cada food.
  //
  // Mineras e industrias parten en 0 — sus góndolas se llenan cuando alguien
  // construye una mina/fábrica y empieza a vender.
  for (const cid of COUNTRY_IDS) {
    const reg = COUNTRIES[cid];
    const c = state.countries[cid];
    const prefs = reg?.preferences || {};
    let prefSum = 0;
    for (const pid of PRODUCIBLE_IDS) {
      const def = PRODUCIBLES[pid];
      if (def?.commodityType !== 'food') continue;
      if ((PRODUCIBLES[pid]?.nutritionUnits || 0) <= 0) continue;
      if ((prefs[pid] || 0) > 0) prefSum += prefs[pid];
    }
    const survivalNutritionMonth = c.population * WAGES.nutritionPerCapita * 30;

    for (const pid of PRODUCIBLE_IDS) {
      const def = PRODUCIBLES[pid];
      const isFoodWithPref = def?.commodityType === 'food' &&
                              (def?.nutritionUnits || 0) > 0 &&
                              (prefs[pid] || 0) > 0;
      if (isFoodWithPref && prefSum > 0) {
        const share = prefs[pid] / prefSum;
        const nutritionForThisFood = survivalNutritionMonth * share;
        const units = nutritionForThisFood / def.nutritionUnits;
        m.inventory[cid][pid] = Math.round(units);
      } else {
        // Minerales, industriales, foods sin preferencia → góndola vacía.
        m.inventory[cid][pid] = 0;
      }
    }
  }
}

// =============================================================================
// Daily market tick
// =============================================================================
export function tickMarket(state) {
  tickProductionDecisions(state);

  const m = state.market;
  // Capturar supplyToday y consumptionDay del día anterior ANTES de que la
  // rotación los borre. Estos valores se pasan a recordMarketSnapshot al final
  // del tick para que la serie snapshot.supplyDay / snapshot.consumptionDay
  // tenga los flujos del día anterior (no ceros). Sin esto, los charts de
  // Flows mostrarían siempre 0.
  const prevSupplyToday = {};
  const prevConsumptionDay = {};
  for (const cid of COUNTRY_IDS) {
    const c = state.countries[cid];
    prevSupplyToday[cid] = { ...(c.supplyToday || {}) };
    prevConsumptionDay[cid] = { ...(c.consumptionDay || {}) };
  }
  // Rotar los 2 counters _Today → _History (90 días) y resetear.
  // Tabla declarativa: agregar un par nuevo es una línea más.
  for (const cid of COUNTRY_IDS) {
    const c = state.countries[cid];
    for (const [todayKey, histKey] of ROTATE_PAIRS) {
      if (!c[histKey]) c[histKey] = {};
      if (!c[todayKey]) c[todayKey] = {};
      for (const pid of PRODUCIBLE_IDS) {
        if (!c[histKey][pid]) c[histKey][pid] = [];
        c[histKey][pid].push(c[todayKey][pid] || 0);
        if (c[histKey][pid].length > 90) c[histKey][pid].shift();
        c[todayKey][pid] = 0;
      }
    }
  }
  // Recomputar target stocks usando la history actualizada. O(países × pids)
  // por día — barato y mantiene el target alineado al flujo observado.
  recomputeTargetStocks(state);

  // tradeBalanceEMA — la UI del modal del país lo lee. Refleja la pulsación
  // diaria de oferta real: positivo cuando hubo ventas hoy (smoothed). Las
  // unidades de supply YA están en m.inventory porque sellFromInventory y
  // writeOffToMarket las trasvasan atómicamente — supplyToday acá es puro
  // signal para la UI/tracking, no un pipeline de movimiento de stock.
  for (const cid of COUNTRY_IDS) {
    const c = state.countries[cid];
    for (const pid of PRODUCIBLE_IDS) {
      const supply = c.supplyToday[pid] || 0;
      const prev = c.tradeBalanceEMA[pid] ?? 0;
      c.tradeBalanceEMA[pid] = prev * 0.85 + (-supply) * 0.15;
    }
  }

  // Per-country price update via stock gap.
  //   target > 0  → gap = (target − inv) / target en [−∞, 1]
  //   target = 0  → gap = −1 siempre (no hay consumidor observado → el ítem
  //                 no tiene demanda real, el precio decae a tasa máxima
  //                 hasta absoluteMinPrice). Aplica exista o no exista stock:
  //                 sin compradores el precio carece de significado económico
  //                 y debe colapsar al piso del modelo.
  for (const cid of COUNTRY_IDS) {
    for (const pid of PRODUCIBLE_IDS) {
      const target = m.targetStock[cid][pid] || 0;
      const inv = m.inventory[cid][pid] || 0;
      const gap = target > 0 ? (target - inv) / target : -1;
      const noise = (Math.random() * 2 - 1) * MARKET.noiseAmp;
      const newPrice = m.prices[cid][pid] * (1 + gap * MARKET.responsiveness + noise);
      m.prices[cid][pid] = Math.max(MARKET.absoluteMinPrice, newPrice);
      m.history[cid][pid].push(m.prices[cid][pid]);
      // History is unbounded — push is O(1) and memory cost is small (one
      // float per producible × country × day). A 50-year game ≈ 10MB.
    }
  }

  // Inflation index update (after prices settle for the day).
  tickPriceIndex(state);

  // Record the day's market snapshot for the debug CSV export y los stock
  // charts. price, marketStock y priceIndex se leen del state actual (ya
  // settled). supplyDay y consumptionDay se pasan como override desde los
  // counters que capturamos antes de la rotación — sin eso quedarían en 0.
  recordMarketSnapshot(state, prevSupplyToday, prevConsumptionDay);

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
// wallet — player and AI farmers. Used by:
//   - the Market modal "Off" column
//   - the MarketHistory snapshot recorder (one source of truth)
export function offMarketInventoryFor(state, countryId, producibleId) {
  let total = 0;
  total += state.player?.inventoryByCountry?.[countryId]?.[producibleId] ?? 0;
  for (const ai of state.aiFarmers ?? []) {
    total += ai.inventoryByCountry?.[countryId]?.[producibleId] ?? 0;
  }
  return total;
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

// opts.unitPrice  → override del precio spot
export function sellFromInventory(state, ownerId, producibleId, units, countryId = PLAYER_COUNTRY_ID, opts = {}) {
  const wallet = walletOf(state, ownerId);
  if (!wallet) return { ok: false, reason: 'No wallet' };
  const inv = inventoryFor(wallet, countryId);
  const have = inv[producibleId] || 0;
  const sell = Math.min(Math.floor(units), have);
  if (sell <= 0) return { ok: false, reason: 'Nothing to sell here' };
  const price = opts.unitPrice ?? state.market.prices?.[countryId]?.[producibleId] ?? 0;
  if (price <= 0) return { ok: false, reason: 'No market price' };
  const r = executeTransaction(state, {
    sellerId: ownerId,
    buyerId: 'foreign',
    productId: producibleId,
    units: sell,
    unitPrice: price,
    countryOfTransaction: countryId,
    type: 'b2b',
  });
  if (!r.ok) return { ok: false, reason: r.reason };
  // Transferencia atómica de stock: del wallet del vendedor a la góndola del
  // país. Toda la venta es UNA sola operación — no hay pipeline diferido
  // (supplyToday → marketStock vía tickMarket) que podría romperse por orden
  // de operaciones. SRP: sellFromInventory es responsable de todo lo que es
  // "una venta" (plata + stock + tracking).
  inv[producibleId] = have - sell;
  if (!state.market.inventory[countryId]) state.market.inventory[countryId] = {};
  state.market.inventory[countryId][producibleId] =
    (state.market.inventory[countryId][producibleId] || 0) + sell;
  _recordSupply(state.countries[countryId], producibleId, sell);
  return { ok: true, units: sell, revenue: r.netToSeller, price };
}

export function buyFromGlobal(state, ownerId, producibleId, units, countryId = PLAYER_COUNTRY_ID) {
  const wallet = walletOf(state, ownerId);
  if (!wallet) return { ok: false, reason: 'Wallet missing' };
  const stock = state.market.inventory?.[countryId]?.[producibleId] || 0;
  const buy = Math.min(Math.floor(units), stock);
  if (buy <= 0) return { ok: false, reason: 'Out of stock' };
  const price = state.market.prices?.[countryId]?.[producibleId] || 0;
  const r = executeTransaction(state, {
    sellerId: 'foreign',
    buyerId: ownerId,
    productId: producibleId,
    units: buy,
    unitPrice: price,
    countryOfTransaction: countryId,
    type: 'sale',
  });
  if (!r.ok) return { ok: false, reason: r.reason };
  state.market.inventory[countryId][producibleId] -= buy;
  _recordConsumption(state.countries[countryId], producibleId, buy);
  const inv = inventoryFor(wallet, countryId);
  inv[producibleId] = (inv[producibleId] || 0) + buy;
  return { ok: true, units: buy, cost: r.grossRevenue + r.taxPaid + r.transportPaid, price };
}

// =============================================================================
// Write-off: mover stock owner → marketStock SIN intercambio de dinero
// =============================================================================
// Mismo rail que sellFromInventory pero sin executeTransaction. Conservación de
// stock: las unidades salen del wallet, entran a la góndola. Conservación de
// dinero: cero movimiento (el seller eats the loss).
export function writeOffToMarket(state, ownerId, producibleId, units, countryId) {
  const wallet = walletOf(state, ownerId);
  if (!wallet) return { ok: false, reason: 'No wallet' };
  const inv = inventoryFor(wallet, countryId);
  const have = inv[producibleId] || 0;
  const sell = Math.min(Math.floor(units), have);
  if (sell <= 0) return { ok: false, reason: 'Nothing to write off' };
  inv[producibleId] = have - sell;
  if (!state.market.inventory[countryId]) state.market.inventory[countryId] = {};
  state.market.inventory[countryId][producibleId] =
    (state.market.inventory[countryId][producibleId] || 0) + sell;
  _recordSupply(state.countries[countryId], producibleId, sell);
  return { ok: true, units: sell };
}

// =============================================================================
// Yearly tick — population growth driven by nutrition acquired
// =============================================================================
// Reglas (en lenguaje humano):
//  - Si en promedio la población consigue al menos la nutrición de "vivir bien"
//    (pop × NUTRITION_PER_CAPITA × WELL_BEING_FACTOR), CRECE al ritmo base
//    (reg.populationGrowth, p. ej. 1%/año).
//  - Si consigue al menos la "supervivencia" (pop × NUTRITION_PER_CAPITA) pero
//    no llega al "vivir bien", se MANTIENE (interpola linealmente entre cero y
//    crecimiento base según qué tan cerca está del wellbeing).
//  - Si NI siquiera llega a supervivencia, DECRECE proporcional al déficit
//    (hasta -5% / año en hambruna total).
//
// La nutrición consumida se calcula desde el consumptionHistory de los últimos
// 90 días (sumando units × nutritionUnits de cada food). Es un proxy razonable
// del estado nutricional al cierre del año.
export function tickCountriesYearly(state) {
  for (const cid of COUNTRY_IDS) {
    const reg = COUNTRIES[cid];
    const c = state.countries[cid];

    // Promedio diario de nutrición consumida en los últimos 90 días
    let nutritionDailyAvg = 0;
    for (const pid of PRODUCIBLE_IDS) {
      const def = PRODUCIBLES[pid];
      const nutri = def?.nutritionUnits || 0;
      if (nutri <= 0) continue;
      const hist = c.consumptionHistory?.[pid] || [];
      const sum = hist.reduce((s, x) => s + x, 0);
      nutritionDailyAvg += (sum / Math.max(1, hist.length)) * nutri;
    }

    const survivalDaily = c.population * WAGES.nutritionPerCapita;
    const wellBeingDaily = survivalDaily * WAGES.wellBeingFactor;
    const baseGrowth = reg.populationGrowth ?? 0.01;

    let growthRate;
    if (nutritionDailyAvg >= wellBeingDaily) {
      // Sobran calorías → crecimiento pleno
      growthRate = baseGrowth;
    } else if (nutritionDailyAvg >= survivalDaily) {
      // Entre supervivencia y vivir-bien → interpolación lineal a cero
      const span = wellBeingDaily - survivalDaily;
      const headroom = nutritionDailyAvg - survivalDaily;
      growthRate = baseGrowth * (span > 0 ? headroom / span : 0);
    } else {
      // Hambruna → decrecimiento proporcional al déficit (hasta -5%/año)
      const deficitRatio = survivalDaily > 0 ? nutritionDailyAvg / survivalDaily : 1;
      growthRate = -0.05 * (1 - deficitRatio);
    }

    const noise = (Math.random() * 2 - 1) * 0.005;
    c.population = Math.max(1, c.population * (1 + growthRate + noise));
    const popRatio = c.population / reg.population;
    for (const pid of PRODUCIBLE_IDS) {
      c.consumption[pid] = (reg.consumption[pid] || 0) * popRatio;
    }
    // No llamamos recomputeTargetStocks acá — corre diaria desde tickMarket
    // ahora que el target depende del consumptionHistory dinámico.
  }
}

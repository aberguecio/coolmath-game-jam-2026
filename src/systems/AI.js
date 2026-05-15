import { AI } from '../data/tunables.js';
import { PRODUCIBLES, PRODUCIBLE_LIST } from '../data/producibles.js';
import { applyForLoan } from './Bank.js';
import { tilePrice, pushLog, pushAIDecision } from '../state/GameState.js';
import { aiTryOffer, tickOffers } from './Trade.js';
import { lockTypeForCategory } from './Farming.js';
import {
  effectiveSetupCost, effectivePlowCost, effectiveHarvestCost,
} from './Inflation.js';
import { plantTile, plowTile } from './Farming.js';
import { expectedPriceAt } from './Forecast.js';
import { aiTrySellInventory } from './AISales.js';

// Generate AI farmers for ONE country. Each farmer claims tiles in that country's map.
// AI ids are country-prefixed to avoid clashes across maps (e.g. `home_ai0`, `usa_ai0`).
export function createAIFarmersForCountry(state, countryId) {
  const farmers = [];
  const map = state.maps[countryId];
  if (!map) return farmers;
  const taken = new Set(
    map.tiles.filter(t => t.owner !== 'wild').map(t => t.id),
  );
  const candidateOrder = map.tiles
    .filter(t => t.owner === 'wild')
    .map(t => t.id)
    .sort((a, b) => {
      const ta = map.tiles[a];
      const tb = map.tiles[b];
      const distA = ta.x + ta.y;
      const distB = tb.x + tb.y;
      return (tb.quality + distB / 30) - (ta.quality + distA / 30);
    });

  let pick = 0;
  for (let i = 0; i < AI.count; i++) {
    const id = `${countryId}_ai${i}`;
    const owned = [];
    for (let j = 0; j < AI.startTilesPerAI; j++) {
      while (pick < candidateOrder.length && taken.has(candidateOrder[pick])) pick++;
      if (pick < candidateOrder.length) {
        const tid = candidateOrder[pick++];
        taken.add(tid);
        owned.push(tid);
        map.tiles[tid].owner = id;
      }
    }
    farmers.push({
      id,
      countryId,
      name: AI.names[i] || `AI ${i + 1}`,
      color: AI.colors[i % AI.colors.length],
      cash: AI.startCash,
      ownedTileIds: owned,
      cooldown: i * 2,
      // Per-country inventory. AI farmers only ever transact in their home
      // country, but the schema mirrors the player so every wallet shares one
      // code path (SRP for inventory access — see inventoryFor in Market.js).
      inventoryByCountry: { [countryId]: {} },
      // Fracción del inventario que el AI conserva en su wallet en vez de
      // listar al mercado. Default 0 = lista todo. Hook para personalidades
      // futuras: un "hoarder" podría tener 0.5 (guarda mitad esperando precios
      // mejores), un "trader" cero, un "small-scale farmer" 0.2, etc.
      keepFraction: 0,
    });
  }
  return farmers;
}

// Unified venture picker: scores every plant / mine option this AI could commit
// to ON THIS TILE, returns the one with the highest monthly margin. Filters by
// lockType, surveyed mineral, and the AI's available cash.
//
// Margin is "expected monthly cash flow" so crops and mines are comparable.
function aiPickBestVenture(state, ai, tile) {
  const cid = ai.countryId;
  let best = null;
  let bestMargin = -Infinity;

  for (const def of PRODUCIBLE_LIST) {
    const wantLock = lockTypeForCategory(def.category);
    if (tile.lockType && wantLock && tile.lockType !== wantLock) continue;

    const setupCost = effectiveSetupCost(state, cid, def)
      + (def.requiresPlow ? effectivePlowCost(state, cid) : 0);
    if (ai.cash < setupCost) continue;

    // Look-ahead pricing: for a wheat field that won't harvest for 90 days,
    // the relevant price is the EXPECTED price 90 days out, not today's spot.
    // expectedPriceAt also discounts for pipeline glut from other farmers.
    const horizon = def.growthDays || 30;
    const priceFuture = expectedPriceAt(state, cid, def.id, horizon);
    if (priceFuture <= 0) continue;
    const revPerCycle = priceFuture * def.yieldUnits;
    const harvestCost = effectiveHarvestCost(state, cid, def);

    let cyclesPerMonth;
    if (def.perennial) {
      cyclesPerMonth = 30 / def.perennial.regrowDays;
    } else {
      cyclesPerMonth = 30 / def.growthDays;
    }
    const recurringMonthlyCost = 0;

    const monthlyMargin = (revPerCycle - harvestCost) * cyclesPerMonth - recurringMonthlyCost;
    if (monthlyMargin > bestMargin) {
      bestMargin = monthlyMargin;
      best = { type: 'plant', def, setupCost, monthlyMargin };
    }
  }

  return best;
}

function aiTryHarvestAndPlant(state, ai) {
  const map = state.maps[ai.countryId];
  if (!map) return;
  for (const tid of ai.ownedTileIds) {
    const tile = map.tiles[tid];
    if (!tile || tile.owner !== ai.id) continue;
    if (tile.state !== 'fallow') continue;
    const choice = aiPickBestVenture(state, ai, tile);
    if (!choice) continue;
    // Skip net-negative ventures — don't dig a hole.
    if (choice.monthlyMargin <= 0) continue;

    if (choice.type === 'plant') {
      // Plow first if required (same flow as player). Both calls route cash
      // through the unified payLaborAndCommodity helper in Farming.js.
      if (choice.def.requiresPlow && tile.state === 'fallow') {
        const rp = plowTile(state, tile, ai.id);
        if (!rp.ok) continue;
      }
      const rPlant = plantTile(state, tile, choice.def.id, ai.id);
      if (rPlant.ok) {
        pushAIDecision(state, {
          companyId: ai.id, recipeId: choice.def.id, action: 'planted',
          reason: `monthly margin ~$${Math.round(choice.monthlyMargin)}`,
        });
      }
    }
  }
  // Sync ownedTileIds against actual ownership (in case of foreclosure).
  ai.ownedTileIds = map.tiles.filter(t => t.owner === ai.id).map(t => t.id);
}

function aiTryBuyLand(state, ai) {
  if (Math.random() > AI.buyTileChance) return;
  // AI only shops in its own country's map.
  const map = state.maps[ai.countryId];
  if (!map) return;
  let best = null;
  let bestVal = -Infinity;
  for (const t of map.tiles) {
    if (t.owner !== 'wild') continue;
    const price = tilePrice(t, state);
    if (ai.cash < price) continue;
    const val = t.quality * 1000 - price * 0.0005;
    if (val > bestVal) {
      bestVal = val;
      best = t;
    }
  }
  if (best) {
    ai.cash -= tilePrice(best, state);
    best.owner = ai.id;
    ai.ownedTileIds.push(best.id);
  }
}

function aiTryLoan(state, ai) {
  if (ai.cash >= AI.loanThreshold) return;
  if (ai.ownedTileIds.length < 1) return;
  const r = applyForLoan(state, 'workingCapital', AI.loanAmount, { borrowerId: ai.id });
  if (r.ok) pushLog(state, `${ai.name} took a working capital loan.`);
}

export function tickAI(state) {
  // Daily: AI may roll an offer on a player tile (independent of the decision cooldown).
  for (const ai of state.aiFarmers) aiTryOffer(state, ai);
  // Daily: expire stale offers
  tickOffers(state);

  for (const ai of state.aiFarmers) {
    ai.cooldown -= 1;
    if (ai.cooldown > 0) continue;
    ai.cooldown = AI.decisionEveryDays;
    aiTryLoan(state, ai);
    aiTryHarvestAndPlant(state, ai);
    aiTryBuyLand(state, ai);
  }
}

// Weekly hook: drip-sell harvested inventory. Run cada 7 días para que la
// góndola se reabastezca con más frecuencia (antes era mensual).
export function tickAIWeekly(state) {
  for (const ai of state.aiFarmers) {
    aiTrySellInventory(state, ai);       // drip-sell harvested crops
  }
}

// Monthly hook — kept as a no-op shell for future re-introduction.
export function tickAIMonthly(_state) {
}

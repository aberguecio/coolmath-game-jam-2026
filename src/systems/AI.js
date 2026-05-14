import { AI, LAND_ACTIONS } from '../data/tunables.js';
import { PRODUCIBLES, PRODUCIBLE_LIST } from '../data/producibles.js';
import { INDUSTRIES } from '../data/industries.js';
import { applyForLoan } from './Bank.js';
import { tilePrice, pushLog, isHaloTile, pushAIDecision } from '../state/GameState.js';
import { aiTryOffer, tickOffers } from './Trade.js';
import { canMineHere } from './Mining.js';
import { lockTypeForCategory } from './Farming.js';
import {
  buildIndustry, aiTryBuildIndustry, aiTryCloseIndustry, aiTryReopenIndustry,
  aiTopUpIndustryInputs, aiSellIndustryOutputs,
} from './Industries.js';
import { priceMA } from './Market.js';
import {
  effectiveSetupCost, effectivePlowCost, effectiveHarvestCost,
  effectiveMonthlyOpCost, effectiveBuildCost, effectiveSalary,
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
    });
  }
  return farmers;
}

// Unified venture picker: scores every plant / mine / build option this AI
// could commit to ON THIS TILE, returns the one with the highest monthly
// margin. Filters by lockType, halo membership, surveyed mineral, and the
// AI's available cash. Replaces the old price-only `pickBestProducible` that
// ignored harvest cost and ongoing labor — the AI was planting at a loss
// because of that, driving food shortages → priceIndex spike → salary spike.
//
// Margin is "expected monthly cash flow" so a $50/mo crop and a $300/mo
// industry are directly comparable.
function aiPickBestVenture(state, ai, tile) {
  const cid = ai.countryId;
  const isHalo = isHaloTile(state, tile);
  let best = null;
  let bestMargin = -Infinity;

  // === Crops + minerals ===
  for (const def of PRODUCIBLE_LIST) {
    if (def.category === 'processed') continue;
    if (def.category === 'mining' && !canMineHere(tile, def)) continue;
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

    let cyclesPerMonth, recurringMonthlyCost;
    if (def.category === 'mining') {
      // Each "cycle" is the regrowDays after first growth — recurring extraction.
      cyclesPerMonth = 30 / (def.perennial?.regrowDays || def.growthDays);
      recurringMonthlyCost = effectiveMonthlyOpCost(state, cid, def);
    } else if (def.perennial) {
      cyclesPerMonth = 30 / def.perennial.regrowDays;
      recurringMonthlyCost = 0;
    } else {
      cyclesPerMonth = 30 / def.growthDays;
      recurringMonthlyCost = 0;
    }

    const monthlyMargin = (revPerCycle - harvestCost) * cyclesPerMonth - recurringMonthlyCost;
    if (monthlyMargin > bestMargin) {
      bestMargin = monthlyMargin;
      best = { type: 'plant', def, setupCost, monthlyMargin };
    }
  }

  // === Industries (only on halo tiles, not locked to crop/mining) ===
  if (isHalo && (!tile.lockType || tile.lockType === 'industry')) {
    for (const recipe of Object.values(INDUSTRIES)) {
      const buildCost = effectiveBuildCost(state, cid, recipe);
      if (ai.cash < buildCost) continue;
      let inputCost = 0, outputRev = 0;
      for (const [pid, qty] of Object.entries(recipe.inputs)) {
        inputCost += priceMA(state, pid, cid, 30) * qty;
      }
      for (const [pid, qty] of Object.entries(recipe.outputs)) {
        outputRev += priceMA(state, pid, cid, 30) * qty;
      }
      const cyclesPerMonth = 30 / recipe.cycleDays;
      const salary = effectiveSalary(state, cid, recipe);
      const monthlyMargin = (outputRev - inputCost) * cyclesPerMonth - salary;
      if (monthlyMargin > bestMargin) {
        bestMargin = monthlyMargin;
        best = { type: 'build', recipe, setupCost: buildCost, monthlyMargin };
      }
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
    if (tile.industryId) continue;          // industry tiles already produce

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
    } else if (choice.type === 'build') {
      const r = buildIndustry(state, ai.id, tile, choice.recipe.id);
      if (r.ok) {
        pushAIDecision(state, {
          companyId: ai.id, recipeId: choice.recipe.id, action: 'built',
          reason: `monthly margin ~$${Math.round(choice.monthlyMargin)} (own tile)`,
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
    aiTryBuildIndustry(state, ai);   // ROI-driven, uses 30-day MA prices
  }
}

// Weekly hook: drip-sell harvested inventory + industry outputs. Run cada 7
// días para que la góndola se reabastezca con más frecuencia (antes era
// mensual, lo cual dejaba al off-market acumulándose entre rotaciones).
export function tickAIWeekly(state) {
  for (const ai of state.aiFarmers) {
    aiTrySellInventory(state, ai);       // drip-sell harvested crops/minerals
    aiSellIndustryOutputs(state, ai);    // industry outputs (separate flow)
  }
}

// Monthly hook: AI prunes unprofitable industries, reopens recovered ones,
// tops up inputs. Las ventas se mudaron a tickAIWeekly.
export function tickAIMonthly(state) {
  for (const ai of state.aiFarmers) {
    aiTopUpIndustryInputs(state, ai);
    aiTryCloseIndustry(state, ai);
    aiTryReopenIndustry(state, ai);      // recover when margin turns positive again
  }
}

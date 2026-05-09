import { AI, LAND_ACTIONS } from '../data/tunables.js';
import { PRODUCIBLES, PRODUCIBLE_LIST } from '../data/producibles.js';
import { applyForLoan } from './Bank.js';
import { tilePrice, pushLog } from '../state/GameState.js';
import { aiTryOffer, tickOffers } from './Trade.js';
import {
  aiTryBuildIndustry, aiTryCloseIndustry, aiTryReopenIndustry,
  aiTopUpIndustryInputs, aiSellIndustryOutputs,
} from './Industries.js';

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
    });
  }
  return farmers;
}

function pickBestProducible(state, countryId = 'home') {
  let best = null;
  let bestScore = -Infinity;
  for (const def of PRODUCIBLE_LIST) {
    // AIs only farm tile-growable producibles, not industry outputs.
    if (def.category === 'processed') continue;
    const price = state.market.prices?.[countryId]?.[def.id] ?? 0;
    const expectedRevenue = price * def.yieldUnits;
    const score = (expectedRevenue - def.seedCost) / (def.growthDays || 1);
    if (score > bestScore) {
      bestScore = score;
      best = def;
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
    // Industry tiles are not farmed — they host a factory that consumes inputs.
    if (tile.industryId) continue;

    // Harvesting is now auto-handled in tickFarming — AI only schedules new plantings.
    if (tile.state === 'fallow') {
      const choice = pickBestProducible(state, ai.countryId);
      const plowCost = LAND_ACTIONS.plow.cost;
      const totalSetup = choice.seedCost + (choice.requiresPlow ? plowCost : 0);
      if (choice && ai.cash >= totalSetup) {
        ai.cash -= totalSetup;
        tile.state = 'planted';
        tile.crop = choice.id;
        tile.growth = 0;
        tile.plantedDay = state.time.totalDays;
        tile.ageDays = 0;
      }
    }
  }
  // Sync ownedTileIds against actual ownership (in case of foreclosure)
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

// Monthly hook: AI prunes unprofitable industries, reopens recovered ones,
// tops up inputs, and sells outputs.
export function tickAIMonthly(state) {
  for (const ai of state.aiFarmers) {
    aiSellIndustryOutputs(state, ai);    // first sell stock so cash is up to buy inputs
    aiTopUpIndustryInputs(state, ai);
    aiTryCloseIndustry(state, ai);
    aiTryReopenIndustry(state, ai);      // recover when margin turns positive again
  }
}

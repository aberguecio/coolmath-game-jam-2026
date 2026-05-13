// IndustryAI — AI decisions about industries: build new, top up inputs,
// sell finished outputs, reopen profitable closed industries, and close
// chronically unprofitable ones.
//
// Build/close/reopen all run off priceMA(state, pid, country, days). Build and
// reopen pay through wallet cash; close just flips status. Reopen has a lower
// ROI bar and discounted cost vs fresh build because the facility is sunk.

import { INDUSTRIES } from '../data/industries.js';
import { INDUSTRY, AI as AI_TUN } from '../data/tunables.js';
import { pushLog, pushAIDecision, getHaloTileIds } from '../state/GameState.js';
import { priceMA, inventoryFor, buyFromGlobal, sellFromInventory } from './Market.js';
import { effectiveSalary, effectiveBuildCost } from './Inflation.js';
import { applyForLoan } from './Bank.js';
import { buildIndustry } from './Industries.js';

// Returns ROI (monthly margin / reopenCost) for a recipe in `cid`, plus the
// monthly margin and the per-cycle cost/revenue used by the calculation.
function reopenROI(state, cid, recipe, reopenCost) {
  const lookback = INDUSTRY.aiReopenLookbackDays;
  let inputCost = 0, outputRev = 0;
  for (const [pid, qty] of Object.entries(recipe.inputs)) {
    inputCost += priceMA(state, pid, cid, lookback) * qty;
  }
  for (const [pid, qty] of Object.entries(recipe.outputs)) {
    outputRev += priceMA(state, pid, cid, lookback) * qty;
  }
  const cyclesPerMonth = 30 / recipe.cycleDays;
  const monthlyMargin = (outputRev - inputCost) * cyclesPerMonth - effectiveSalary(state, cid, recipe);
  return { roi: monthlyMargin / Math.max(1, reopenCost), monthlyMargin, lookback };
}

const REOPEN_COOLDOWN_DAYS = 60;

// Daily-ish: consider building one new industry on a halo tile.
export function aiTryBuildIndustry(state, ai) {
  if (Math.random() > 0.20) return;
  const halo = getHaloTileIds(state, ai.countryId).map(id => state.maps[ai.countryId].tiles[id]);
  const wildHalo = halo.filter(t => t && t.owner === 'wild');
  if (wildHalo.length === 0) return;
  if (!ai.cash || ai.cash < 8000) return;

  const lookback = INDUSTRY.aiPriceLookbackDays;
  let best = null, bestRoi = -Infinity, bestReason = '';
  for (const recipe of Object.values(INDUSTRIES)) {
    if (ai.cash < effectiveBuildCost(state, ai.countryId, recipe)) continue;
    let inputCost = 0, outputRev = 0;
    for (const [pid, qty] of Object.entries(recipe.inputs)) {
      inputCost += priceMA(state, pid, ai.countryId, lookback) * qty;
    }
    for (const [pid, qty] of Object.entries(recipe.outputs)) {
      outputRev += priceMA(state, pid, ai.countryId, lookback) * qty;
    }
    const cyclesPerMonth = 30 / recipe.cycleDays;
    const monthlyMargin = (outputRev - inputCost) * cyclesPerMonth - effectiveSalary(state, ai.countryId, recipe);
    const roi = monthlyMargin / Math.max(1, effectiveBuildCost(state, ai.countryId, recipe));
    pushAIDecision(state, {
      companyId: ai.id, recipeId: recipe.id,
      action: 'considered',
      reason: `30d ROI ${(roi * 100).toFixed(1)}% (margin $${Math.round(monthlyMargin)}/mo)`,
    });
    if (roi > bestRoi) { bestRoi = roi; best = recipe; bestReason = `ROI ${(roi * 100).toFixed(1)}%`; }
  }

  if (!best || bestRoi < INDUSTRY.aiBuildRoiThreshold) return;
  const tile = wildHalo[0];
  const r = buildIndustry(state, ai.id, tile, best.id);
  if (r.ok) {
    pushAIDecision(state, {
      companyId: ai.id, recipeId: best.id, action: 'built', reason: bestReason,
    });
    pushLog(state, `${ai.name} started building ${best.name} in ${ai.countryId}.`);
  }
}

// Monthly: AI tops up industry inputs from local market (target = 10 cycles).
// Uses the same buyFromGlobal rail as the player — single code path.
export function aiTopUpIndustryInputs(state, ai) {
  const owned = state.industries.filter(
    i => i.ownerId === ai.id && (i.status === 'operational' || i.status === 'idle'),
  );
  if (owned.length === 0) return;
  const cid = ai.countryId;
  const inv = inventoryFor(ai, cid);
  for (const ind of owned) {
    const recipe = INDUSTRIES[ind.recipeId];
    if (!recipe) continue;
    for (const [pid, qty] of Object.entries(recipe.inputs)) {
      const have = inv[pid] || 0;
      const target = qty * 10;
      if (have >= target) continue;
      const need = target - have;
      const stock = state.market.inventory?.[cid]?.[pid] || 0;
      if (stock <= 0) continue;
      const price = state.market.prices?.[cid]?.[pid] || 0;
      if (price <= 0) continue;
      const buy = Math.floor(Math.min(need, stock, ai.cash / price));
      if (buy <= 0) continue;
      buyFromGlobal(state, ai.id, pid, buy, cid);
    }
  }
}

// Monthly: AI sells finished output stock back to the local market.
// Keeps a safety buffer of 5 cycles' worth so the next production tick has
// something to fall back on if a sale temporarily fails. Routes through the
// same sellFromInventory rail as the player.
export function aiSellIndustryOutputs(state, ai) {
  const cid = ai.countryId;
  const inv = inventoryFor(ai, cid);
  for (const ind of state.industries) {
    if (ind.ownerId !== ai.id) continue;
    if (ind.status === 'closed' || ind.status === 'building') continue;
    const recipe = INDUSTRIES[ind.recipeId];
    if (!recipe) continue;
    for (const pid of Object.keys(recipe.outputs)) {
      const have = inv[pid] || 0;
      const sell = Math.max(0, Math.floor(have - recipe.outputs[pid] * 5));
      if (sell <= 0) continue;
      // Try the normal sale at spot. The mayorista (marketPool) pays the AI.
      const r = sellFromInventory(state, ai.id, pid, sell, cid);
      if (r.ok) continue;
      // Sale failed — almost always because the marketPool is dry for an
      // industrial output that has no real consumer (steel/cable/jewelry).
      // Without intervention, the stock stays frozen in off-market forever,
      // marketStock=0 → gap=1 every day → spot price compounds upward
      // unbounded (the hyperinflation bug we reproduced live).
      //
      // Fix: write-off. AI dumps the units onto the shelf at zero payment.
      // The mayorista technically "got it for free" — la industria se traga
      // la pérdida porque no encuentra comprador real. This is what makes
      // marketStock actually grow when there's no demand. Once it grows past
      // target, the gap formula turns negative and price falls toward
      // absoluteMinPrice. Monthly margin of the industry collapses,
      // aiTryCloseIndustry shuts it down. Conservation safe: no cash created
      // or destroyed — pure stock movement.
      if (have >= sell) {
        inv[pid] = have - sell;
        if (!state.market.inventory[cid]) state.market.inventory[cid] = {};
        state.market.inventory[cid][pid] = (state.market.inventory[cid][pid] || 0) + sell;
      }
    }
  }
}

// Monthly: re-open closed industries when short-term margin turns profitable.
// Pays reopenCostFactor × buildCost (sunk facility, just restart capital).
// If the AI is cash-poor but the math says profitable, fund the reopen with
// a working-capital loan instead of skipping forever.
export function aiTryReopenIndustry(state, ai) {
  const closed = state.industries.filter(i => i.ownerId === ai.id && i.status === 'closed' && !i.foreclosed);
  for (const ind of closed) {
    const recipe = INDUSTRIES[ind.recipeId];
    if (!recipe) continue;
    if (ind.closedOnDay != null && state.time.totalDays - ind.closedOnDay < REOPEN_COOLDOWN_DAYS) continue;
    const buildCost = effectiveBuildCost(state, ai.countryId, recipe);
    const reopenCost = Math.round(buildCost * INDUSTRY.reopenCostFactor);
    const { roi } = reopenROI(state, ai.countryId, recipe, reopenCost);
    if (roi < INDUSTRY.aiReopenRoiThreshold) continue;

    // Bug fix: a cash-poor AI used to be locked out of reopens forever, even
    // with obviously profitable margins. Take a working-capital loan instead.
    if (ai.cash < reopenCost) {
      const loan = applyForLoan(state, 'workingCapital', AI_TUN.loanAmount, { borrowerId: ai.id });
      if (!loan.ok) continue;
    }

    ai.cash -= reopenCost;
    ind.status = 'building';
    ind.startBuildDay = state.time.totalDays;
    ind.operationalDay = null;
    ind.lastCycleDay = null;
    pushAIDecision(state, {
      companyId: ai.id, recipeId: recipe.id, action: 'reopened',
      reason: `${INDUSTRY.aiReopenLookbackDays}d ROI ${(roi * 100).toFixed(1)}% — cost $${reopenCost}`,
    });
    pushLog(state, `${ai.name} reopened ${recipe.name} (margin recovered, $${reopenCost}).`);
  }
}

// Monthly: close any industry whose 90-day MA margin is too negative.
export function aiTryCloseIndustry(state, ai) {
  const owned = state.industries.filter(i => i.ownerId === ai.id && i.status !== 'closed' && i.status !== 'building');
  for (const ind of owned) {
    const recipe = INDUSTRIES[ind.recipeId];
    if (!recipe) continue;
    const lookback = INDUSTRY.aiCloseMarginLookbackDays;
    let inputCost = 0, outputRev = 0;
    for (const [pid, qty] of Object.entries(recipe.inputs)) {
      inputCost += priceMA(state, pid, ai.countryId, lookback) * qty;
    }
    for (const [pid, qty] of Object.entries(recipe.outputs)) {
      outputRev += priceMA(state, pid, ai.countryId, lookback) * qty;
    }
    const cyclesPerMonth = 30 / recipe.cycleDays;
    const salaryEff = effectiveSalary(state, ai.countryId, recipe);
    const monthlyMargin = (outputRev - inputCost) * cyclesPerMonth - salaryEff;
    if (monthlyMargin < -salaryEff * 0.5) {
      pushAIDecision(state, {
        companyId: ai.id, recipeId: recipe.id, action: 'closed',
        reason: `90d margin $${Math.round(monthlyMargin)}/mo`,
      });
      ind.status = 'closed';
      ind.closedOnDay = state.time.totalDays;
      pushLog(state, `${ai.name} closed ${recipe.name} (90d margin negative).`);
    }
  }
}

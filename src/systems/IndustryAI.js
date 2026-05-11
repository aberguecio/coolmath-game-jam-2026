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
import { priceMA } from './Market.js';
import { executeTransaction } from './Transactions.js';
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
export function aiTopUpIndustryInputs(state, ai) {
  const owned = state.industries.filter(
    i => i.ownerId === ai.id && (i.status === 'operational' || i.status === 'idle'),
  );
  if (owned.length === 0) return;
  if (!ai.inventory) ai.inventory = {};
  const cid = ai.countryId;
  for (const ind of owned) {
    const recipe = INDUSTRIES[ind.recipeId];
    if (!recipe) continue;
    for (const [pid, qty] of Object.entries(recipe.inputs)) {
      const have = ai.inventory[pid] || 0;
      const target = qty * 10;
      if (have >= target) continue;
      const need = target - have;
      const stock = state.market.inventory?.[cid]?.[pid] || 0;
      if (stock <= 0) continue;
      const price = state.market.prices?.[cid]?.[pid] || 0;
      if (price <= 0) continue;
      const affordable = ai.cash / price;
      const buy = Math.floor(Math.min(need, stock, affordable));
      if (buy <= 0) continue;
      const r = executeTransaction(state, {
        sellerId: 'foreign', buyerId: ai.id,
        productId: pid, units: buy, unitPrice: price,
        countryOfTransaction: cid, sellerCountryId: cid, type: 'b2b',
      });
      if (r.ok) {
        state.market.inventory[cid][pid] -= buy;
        ai.inventory[pid] = have + buy;
      }
    }
  }
}

// Monthly: AI sells finished output stock back to the local market.
export function aiSellIndustryOutputs(state, ai) {
  if (!ai.inventory) return;
  for (const ind of state.industries) {
    if (ind.ownerId !== ai.id) continue;
    if (ind.status === 'closed' || ind.status === 'building') continue;
    const recipe = INDUSTRIES[ind.recipeId];
    if (!recipe) continue;
    const cid = ai.countryId;
    for (const pid of Object.keys(recipe.outputs)) {
      const have = ai.inventory[pid] || 0;
      const sell = Math.max(0, Math.floor(have - recipe.outputs[pid] * 5));
      if (sell <= 0) continue;
      const price = state.market.prices?.[cid]?.[pid] || 0;
      if (price <= 0) continue;
      const r = executeTransaction(state, {
        sellerId: ai.id, buyerId: 'foreign',
        productId: pid, units: sell, unitPrice: price,
        countryOfTransaction: cid, sellerCountryId: cid, type: 'b2b',
      });
      if (r.ok) {
        ai.inventory[pid] -= sell;
        const country = state.countries[cid];
        if (country) country.supplyToday[pid] = (country.supplyToday[pid] || 0) + sell;
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

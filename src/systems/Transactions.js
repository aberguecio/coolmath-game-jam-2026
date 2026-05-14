// Transactions — the single chokepoint for all monetary movement.
//
// Every flow of cash between players, AI, country pools, or population goes
// through executeTransaction. That guarantees taxes/wages/ledger consistency,
// and lets the closed-loop economy stay conserved. Buyer or seller may be
// 'foreign' (= the country marketPool acts as counter-party) so production has
// somewhere to go and consumption has somewhere to come from.
//
// types:
//   'sale'   retail (population buys from market)        — sale tax
//   'b2b'    company-to-company / industry buys input    — b2b tax
//   'import' cross-country arrival                       — import tax
//
// sellerId / buyerId may be: 'player' | aiId | 'population' | 'treasury' | 'foreign'
//
// Returns explicitly { ok, reason?, grossRevenue, taxPaid, wagePaid, transportPaid, netToSeller }.

import { PRODUCIBLES } from '../data/producibles.js';
import { effectiveTaxRates } from '../data/taxRates.js';
import { transportCost } from '../data/distances.js';
import { PLAYER_COUNTRY_ID } from '../data/countries.js';
import { logEvent } from '../state/GameState.js';

export function walletOf(state, ownerId) {
  if (ownerId === 'player') return state.player;
  if (ownerId === 'population' || ownerId === 'treasury') return null;
  if (ownerId === 'foreign') return null;
  // Registry lookup — any actor type that registered itself in state.wallets
  // (AI farmers, future actors) is reachable through this single call.
  // Falls back to aiFarmers scan for any legacy caller that pre-dates
  // the registry init.
  return state.wallets?.[ownerId]
    ?? state.aiFarmers?.find(a => a.id === ownerId)
    ?? null;
}

// Single source of truth: "¿en qué país vive el wallet?". Lo usan los helpers
// canónicos para categorizar transacciones como local vs cross-country.
// AI farmer usa `countryId`, exporter usa `homeCountryId`, player es PLAYER.
// Sistema actors (population, treasury, foreign) no tienen país asignado.
export function walletCountryFor(state, ownerId) {
  if (ownerId === 'player') return PLAYER_COUNTRY_ID;
  if (ownerId === 'population' || ownerId === 'treasury' || ownerId === 'foreign') return null;
  const w = state.wallets?.[ownerId] ?? state.aiFarmers?.find(a => a.id === ownerId);
  if (!w) return null;
  return w.countryId ?? w.homeCountryId ?? null;
}

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

  const grossRevenue = unitPrice * units;
  const rates = effectiveTaxRates(state, countryOfTransaction);
  const rate = rates[type] ?? rates.sale ?? 0;
  const taxPaid = grossRevenue * rate;
  const tCost = (sellerCountryId && sellerCountryId !== countryOfTransaction)
    ? transportCost(sellerCountryId, countryOfTransaction, units)
    : 0;
  const totalCost = grossRevenue + taxPaid + tCost;

  const buyerWallet = walletOf(state, buyerId);
  const sellerWallet = walletOf(state, sellerId);
  const isRealBuyer = !!buyerWallet;
  const isRealSeller = !!sellerWallet;

  // Sales no longer route any wage portion — wages now flow exclusively from
  // the venture's explicit production cost (harvestCost / monthlyOpCost /
  // monthlySalary), paid by the owner directly into wageFund.
  const wagePaid = 0;
  const netToSeller = grossRevenue;
  const sellerCountry = sellerCountryId || countryOfTransaction;

  const txCountry = state.countries[countryOfTransaction];
  const sellerCountryRuntime = state.countries[sellerCountry];

  // === Pre-check: buyer must be solvent before any mutation.
  if (isRealBuyer) {
    if (buyerWallet.cash < totalCost) return { ok: false, reason: 'buyer cash insufficient' };
  } else if (buyerId === 'population') {
    if (txCountry.wageFund < totalCost) return { ok: false, reason: 'wageFund insufficient' };
  } else if (buyerId === 'treasury') {
    // Treasury is allowed to go negative via crisis path; no precheck.
  } else if (buyerId === 'foreign') {
    // marketPool of the seller-country must cover everything that will leave
    // it: seller payment, wages → wageFund, and tax → treasury.
    if (sellerCountryRuntime.marketPool < (netToSeller + wagePaid + taxPaid)) {
      return { ok: false, reason: 'marketPool dry' };
    }
  }

  // === Mutate ===
  // 1. Pull cash from buyer side.
  if (isRealBuyer) {
    buyerWallet.cash -= totalCost;
  } else if (buyerId === 'population') {
    txCountry.wageFund -= totalCost;
  } else if (buyerId === 'treasury') {
    txCountry.treasury -= totalCost;
  } else if (buyerId === 'foreign') {
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

  // Tier-4 transactional log. The "actor" is whichever side is a real wallet;
  // we prefer the buyer because that's usually the entity initiating the move
  // (population buying food, exporter buying cargo, AI topping up inputs).
  const actorId = isRealBuyer ? buyerId : (isRealSeller ? sellerId : null);
  logEvent(state, {
    tier: 4, category: `tx-${type}`,
    countryId: countryOfTransaction, actorId,
    summary: `${type} ${units}u ${productId} @ $${Math.round(unitPrice)} in ${countryOfTransaction}`,
    amount: Math.round(grossRevenue),
    meta: { sellerId, buyerId, units, unitPrice, taxPaid, transportPaid: tCost },
  });

  return {
    ok: true,
    grossRevenue, taxPaid, wagePaid, transportPaid: tCost, netToSeller,
  };
}

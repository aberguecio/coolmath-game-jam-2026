// Storage — every actor that holds inventory pays warehouse labor each month,
// per country where they hold goods. Charged as
//   `units(in cid) × STORAGE.unitWarehouseLabor × wageRate(cid)`
// and routed into that country's wageFund. Hoarding is costly: AI has a real
// reason to sell at fair prices rather than wait for impossible peaks. Player
// follows the same rule for consistency.
//
// SRP: this module ONLY computes/charges storage costs. It does not decide
// what to sell (AISales.js) and does not own the inventory (the wallets do).
//
// Per-country billing: a wallet that holds goods in three countries pays three
// separate bills, each into the local wageFund — goods physically sit
// somewhere, and warehouse workers are paid locally.

import { COUNTRY_IDS } from '../data/countries.js';
import { STORAGE, FISCAL_CRISIS } from '../data/tunables.js';
import { wageRateFor } from './Labor.js';
import { walletFor } from './Bank.js';
import { unitsInCountry } from './Market.js';

// What this wallet would owe THIS MONTH for its inventory in `cid`. Pure read.
export function storageBillFor(state, ownerId, cid) {
  const wallet = walletFor(state, ownerId);
  if (!wallet) return 0;
  const units = unitsInCountry(wallet, cid);
  if (units <= 0) return 0;
  return Math.round(units * STORAGE.unitWarehouseLabor * wageRateFor(state, cid));
}

// Charge a single wallet for its inventory in `cid`. Routes payment to the
// country's wageFund (or sinks the haircut fraction in fiscal crisis).
function chargeWallet(state, wallet, cid) {
  const bill = Math.round(
    unitsInCountry(wallet, cid) * STORAGE.unitWarehouseLabor * wageRateFor(state, cid),
  );
  if (bill <= 0 || wallet.cash < bill) return;
  const country = state.countries[cid];
  if (!country) return;
  const haircut = country.fiscalCrisis?.active ? FISCAL_CRISIS.wageHaircutFraction : 0;
  wallet.cash -= bill;
  country.wageFund += bill * (1 - haircut);
}

// Monthly tick. Charges every wallet for inventory it holds, in every country.
export function tickStorageCost(state) {
  for (const cid of COUNTRY_IDS) {
    // Player — may hold inventory anywhere they've produced/traded.
    chargeWallet(state, state.player, cid);

    // AI farmers — bill them in their home country (the only place they store).
    for (const ai of state.aiFarmers || []) {
      if (ai.countryId !== cid) continue;
      chargeWallet(state, ai, cid);
    }
  }
}

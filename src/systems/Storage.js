// Storage — every actor that holds inventory pays warehouse labor each month.
// Charged as `units × STORAGE.unitWarehouseLabor × wageRate(cid)` and routed
// into the country's wageFund (the warehouse workers being paid). This makes
// hoarding costly: AI has a real reason to sell at fair prices rather than
// wait for impossible peaks. Player follows the same rule for consistency.
//
// SRP: this module ONLY computes/charges storage costs. It does not decide
// what to sell (AISales.js) and does not own the inventory (the wallets do).

import { COUNTRY_IDS } from '../data/countries.js';
import { STORAGE, FISCAL_CRISIS } from '../data/tunables.js';
import { wageRateFor } from './Labor.js';
import { walletFor } from './Bank.js';

function inventoryUnitsOf(wallet) {
  if (!wallet?.inventory) return 0;
  let total = 0;
  for (const qty of Object.values(wallet.inventory)) total += Math.max(0, qty);
  return total;
}

// What this wallet would owe THIS MONTH at the country's current wageRate.
// Pure read — useful for UI preview and budget planning.
export function storageBillFor(state, ownerId, cid) {
  const wallet = walletFor(state, ownerId);
  if (!wallet) return 0;
  const units = inventoryUnitsOf(wallet);
  if (units <= 0) return 0;
  return Math.round(units * STORAGE.unitWarehouseLabor * wageRateFor(state, cid));
}

// Monthly tick. Charges every wallet for inventory it holds in its home country.
// (Cross-country inventory storage is out of scope until exporters land.)
export function tickStorageCost(state) {
  for (const cid of COUNTRY_IDS) {
    const country = state.countries[cid];
    if (!country) continue;
    const haircut = country.fiscalCrisis?.active ? FISCAL_CRISIS.wageHaircutFraction : 0;

    // Player — assumed to store inventory in their home country.
    if (cid === 'home') {
      const playerBill = storageBillFor(state, 'player', cid);
      if (playerBill > 0 && state.player.cash >= playerBill) {
        state.player.cash -= playerBill;
        country.wageFund += playerBill * (1 - haircut);
      }
    }

    // AI farmers in this country
    for (const ai of state.aiFarmers || []) {
      if (ai.countryId !== cid) continue;
      const bill = storageBillFor(state, ai.id, cid);
      if (bill > 0 && ai.cash >= bill) {
        ai.cash -= bill;
        country.wageFund += bill * (1 - haircut);
      }
    }
  }
}

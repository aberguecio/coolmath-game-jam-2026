// Exporters — trader actors that physically move goods between towns. They
// buy in the source town's market, ship for `etaDaysPerDistance × distance`
// in-game days (their cash is at risk while in transit), then sell in the
// destination town. Replaces the old instant cross-country arbitrage with
// agent-driven flows.
//
// SRP: this module owns the lifecycle (create, ship, advance time, settle).
// Decision logic — which trips to start — lives in `ExporterAI.js`.

import { EXPORTERS } from '../data/tunables.js';
import { EXPORTER_NAMES, EXPORTER_COLORS } from '../data/exporters.js';
import { transportCost, distanceBetween } from '../data/distances.js';
import { COUNTRY_IDS, COUNTRIES } from '../data/countries.js';
import { pushLog, registerWallet, unregisterWallet } from '../state/GameState.js';
import { buyFromGlobal, sellFromInventory, writeOffToMarket, inventoryFor } from './Market.js';

let _nextId = 1;
function nextExporterId(homeCountryId) {
  return `${homeCountryId}_exp${_nextId++}`;
}

// Create an exporter actor and register its wallet in the central registry.
export function createExporter(state, {
  ownerId = null,                  // 'player' or AI id; null = independent AI exporter
  homeCountryId,
  name,
  color,
  capital,
}) {
  const id = nextExporterId(homeCountryId);
  const exporter = {
    id,
    ownerId: ownerId ?? id,        // self-owned by default for AI exporters
    homeCountryId,
    name: name ?? id,
    color: color ?? 0x88c8ff,
    cash: capital ?? EXPORTERS.baseCapital,
    inFlight: [],                  // [{ srcCid, dstCid, pid, units, etaDay, costPaid }]
    bankrupt: false,
    tripsCompleted: 0,
    pnl: 0,                        // cumulative profit (sale revenue − costPaid)
  };
  if (!state.exporters) state.exporters = [];
  state.exporters.push(exporter);
  registerWallet(state, exporter);
  return exporter;
}

// Plan = { srcCid, dstCid, pid, units }. Executes the BUY in source town,
// pays transport (sink), and records the cargo for in-transit. Returns
// { ok, reason? }.
export function exporterStartShipment(state, exporter, plan) {
  if (exporter.bankrupt) return { ok: false, reason: 'Exporter bankrupt' };
  const { srcCid, dstCid, pid, units } = plan;
  if (!srcCid || !dstCid || srcCid === dstCid) return { ok: false, reason: 'Bad route' };
  if (!Number.isFinite(units) || units <= 0) return { ok: false, reason: 'units<=0' };

  // Route guard: an exporter anchored to town X only handles routes where X
  // is either origin or destination. An Oakdale exporter does Oakdale↔X; a
  // Riverside exporter does Riverside↔X; etc. No third-party legs.
  if (srcCid !== exporter.homeCountryId && dstCid !== exporter.homeCountryId) {
    return { ok: false, reason: 'Route not anchored to exporter town' };
  }

  // Soft anti-overlap: while another same-town exporter currently has the
  // same pid in transit, skip — gives diversity at the moment of decision but
  // does NOT permanently lock a pid to any exporter. Once the sibling's cargo
  // settles, the pid is free again.
  for (const e of state.exporters || []) {
    if (e.id === exporter.id) continue;
    if (e.homeCountryId !== exporter.homeCountryId) continue;
    if (e.inFlight.some(c => c.pid === pid)) {
      return { ok: false, reason: `Pid ${pid} already in flight from sibling` };
    }
  }

  const srcStock = state.market.inventory?.[srcCid]?.[pid] || 0;
  if (srcStock < units) return { ok: false, reason: 'Src out of stock' };

  // BUY canónico en source vía buyFromGlobal. crossCountry=true → registra el
  // pickup como EXPORT en srcCid (el cargo va a salir del país). buyFromGlobal
  // se encarga de: cobrar al exporter wallet, descontar marketStock, escribir
  // counters totals + export component vía _recordConsumption.
  const r = buyFromGlobal(state, exporter.id, pid, units, srcCid, { crossCountry: true });
  if (!r.ok) return { ok: false, reason: r.reason };
  const srcPrice = r.price;

  // El cargo va a la cola inFlight, no al inventario regular del exporter.
  // Transferimos: las units pasaron del marketStock al exporter wallet via
  // buyFromGlobal — ahora salen del wallet y entran a inFlight. Conservación
  // de stock: marketStock−units → wallet+units → wallet−units → inFlight+units.
  const inv = inventoryFor(exporter, srcCid);
  inv[pid] = (inv[pid] || 0) - units;

  // Shipping fee — freight company. Sink (same convention as the old arbitrage).
  const tCost = transportCost(srcCid, dstCid, units);
  exporter.cash -= tCost;

  const dist = distanceBetween(srcCid, dstCid);
  const etaDay = state.time.totalDays + Math.max(1, Math.round(EXPORTERS.etaDaysPerDistance * dist));

  exporter.inFlight.push({
    srcCid, dstCid, pid, units, etaDay,
    costPaid: r.cost + tCost,
    srcPrice,
  });
  return { ok: true, etaDay };
}

// Settle a cargo on its arrival day. Always returns true: the cargo CANNOT
// stay in flight past etaDay, so there's no scenario where we accumulate
// historical entries with negative ETAs in the UI.
//
// Three outcomes, in priority order:
//   (1) Normal sale at market price succeeds  → exporter gets full revenue.
//   (2) marketPool is shallow but non-zero    → fire sale at pool-affordable
//                                               price, exporter eats the gap.
//   (3) Pool/price truly broken (=0)          → dump goods into dst market
//                                               inventory for free, exporter
//                                               books a full loss.
// In every case the goods physically arrive in `state.market.inventory[dst]`
// and the cargo is removed from inFlight by the caller.
function settleShipment(state, exporter, cargo) {
  const { dstCid, pid, units, costPaid, srcCid } = cargo;
  const dstCountry = state.countries[dstCid];
  if (!state.tradeFlows) state.tradeFlows = [];

  // 1) Cargo arrives → depositar en inventario regular del exporter.
  //    Las 3 rutas de venta abajo van a salir de este inventario y entrar
  //    a la góndola via el rail canónico (supplyToday → marketStock en
  //    el próximo tickMarket). 1-día de lag consistente con todo el motor.
  const inv = inventoryFor(exporter, dstCid);
  inv[pid] = (inv[pid] || 0) + units;

  // 2) Sale al precio spot del destino. crossCountry=true → registra como
  //    IMPORT en dstCid.
  let r = sellFromInventory(state, exporter.id, pid, units, dstCid, { crossCountry: true });
  let outcome = r.ok ? 'sold' : 'pending';
  let revenue = r.ok ? r.revenue : 0;

  // 3) Fallback fire-sale: precio que el pool destino puede pagar (20% slack
  //    para el tax overhead que executeTransaction agrega arriba).
  if (!r.ok) {
    const pool = dstCountry?.marketPool || 0;
    if (pool > 0) {
      const fireUnitPrice = Math.max(0.01, (pool * 0.8) / Math.max(1, units));
      r = sellFromInventory(state, exporter.id, pid, units, dstCid, {
        crossCountry: true, unitPrice: fireUnitPrice,
      });
      if (r.ok) { outcome = 'fire-sale'; revenue = r.revenue; }
    }
  }

  // 4) Last resort: pool roto. Write-off — exporter eats full loss pero las
  //    unidades entran igual a la góndola via supplyToday (mismo invariante).
  if (!r.ok) {
    const w = writeOffToMarket(state, exporter.id, pid, units, dstCid, { crossCountry: true });
    if (w.ok) { outcome = 'dumped'; revenue = 0; }
  }

  state.tradeFlows.push({
    day: state.time.totalDays,
    src: srcCid, dst: dstCid, pid, units,
  });

  exporter.tripsCompleted += 1;
  exporter.pnl += revenue - costPaid;

  if (exporter.ownerId === 'player') {
    const tag = outcome === 'fire-sale' ? ' [fire sale]'
      : outcome === 'dumped' ? ' [dumped — market broken]' : '';
    pushLog(state,
      `🚢 ${exporter.name}: ${units}u ${pid} ${srcCid}→${dstCid} got $${Math.round(revenue)}${tag} (cost $${Math.round(costPaid)})`);
  }
  return true;                            // cargo always clears
}

// Daily tick: advance every cargo, settle arrivals, mark bankrupt exporters.
// AI decisions (which trips to start) are dispatched separately by
// `aiExporterTryShipment` in ExporterAI.js — called from the same daily
// loop in scenes/Game.js after this function.
export function tickExporters(state) {
  if (!state.exporters || state.exporters.length === 0) return;
  for (const exp of state.exporters) {
    if (exp.bankrupt) continue;

    // Settle every cargo that has arrived. settleShipment guarantees clearance
    // (sale / fire-sale / dump) so the cargo is always removed from inFlight
    // the day it lands — no historical entries with negative ETAs.
    for (let i = exp.inFlight.length - 1; i >= 0; i--) {
      const cargo = exp.inFlight[i];
      if (cargo.etaDay > state.time.totalDays) continue;
      settleShipment(state, exp, cargo);
      exp.inFlight.splice(i, 1);
    }

    // Bankruptcy: out of cash AND nothing in transit to recover.
    if (exp.cash < 0 && exp.inFlight.length === 0 && !exp.bankrupt) {
      exp.bankrupt = true;
      pushLog(state, `🚢 ${exp.name} declared bankrupt.`);
      // Optional: unregister wallet so dead exporters stop appearing in lookups.
      // unregisterWallet(state, exp.id);   // kept for audit; UI marks bankrupt.
    }
  }
}

// Seed N AI exporters per town at world init. Called from WorldSeed.
export function seedExportersFor(state, countryId, count) {
  const startName = (state.exporters?.length || 0);
  for (let i = 0; i < count; i++) {
    const idx = (startName + i) % EXPORTER_NAMES.length;
    const cIdx = (startName + i) % EXPORTER_COLORS.length;
    createExporter(state, {
      ownerId: null,
      homeCountryId: countryId,
      name: `${EXPORTER_NAMES[idx]} (${COUNTRIES[countryId]?.name ?? countryId})`,
      color: EXPORTER_COLORS[cIdx],
      capital: EXPORTERS.baseCapital,
    });
  }
}

// Loop — runner headless de sesiones.
//
// El Loop controla el reloj; el Driver sólo decide acciones intra-día. Un bot
// no puede "saltarse" un día ni correr dos ticks por iteración por construcción.
//
// Orden por día (espejo de scenes/Game.js update() para que humano y headless
// tengan el mismo determinismo):
//   1. observe(state) → snapshot
//   2. driver.decide(obs, PlayerActions) → Action[]
//   3. apply cada acción
//   4. advance one day (Clock-equivalente)
//   5. tickEvents → Farming → Industries → Market → Population → AI
//      → Exporters (+ AI exporter shipments) → (monthly) salaries, mining ops,
//      storage, labor, loans, fiscalCrisis, AI monthly → (yearly) city, countries
//   6. drain fxQueue (no-op consumer headless)
//   7. onTick callback (TraceLog enchufa acá)

import * as PlayerActions from './PlayerActions.js';
import { observe } from './Observation.js';
import { bootHeadlessState, advanceOneDay } from './Boot.js';

import { tickEvents } from '../systems/Events.js';
import { tickFarming } from '../systems/Farming.js';
import { tickFiscalCrisis } from '../systems/FiscalCrisis.js';
import { tickMarket, populationSpend, tickCountriesYearly } from '../systems/Market.js';
import { tickAI, tickAIWeekly, tickAIMonthly } from '../systems/AI.js';
import { tickExporters } from '../systems/Exporters.js';
import { aiExporterTryShipment } from '../systems/ExporterAI.js';
import { tickMiningOps } from '../systems/Mining.js';
import { tickStorageCost } from '../systems/Storage.js';
import { tickLaborMarket } from '../systems/Labor.js';
import { tickLoans } from '../systems/Bank.js';
import { tickCityYearly } from '../systems/City.js';

export function runSession({ driver, days = 365, state = null, onTick = null }) {
  if (!state) state = bootHeadlessState();

  for (let i = 0; i < days; i++) {
    // 1. Snapshot what the bot sees BEFORE acting.
    const obs = observe(state);

    // 2. Bot decides intra-day actions.
    let acts = [];
    try {
      acts = driver.decide?.(obs, PlayerActions) ?? [];
    } catch (err) {
      acts = [];
      console.error(`driver threw on day ${state.time.totalDays}:`, err);
    }
    if (!Array.isArray(acts)) acts = [];

    // 3. Apply each action. Per-action failures don't kill the loop.
    const results = [];
    for (const a of acts) results.push(PlayerActions.apply(state, a));

    // 4. Advance the clock by exactly one day.
    const events = advanceOneDay(state);

    // 5. Same tick order as scenes/Game.js update().
    if (events.day) {
      tickEvents(state);
      tickFarming(state);
      tickMarket(state);
      populationSpend(state);
      tickAI(state);
      tickExporters(state);
      for (const exp of state.exporters || []) {
        if (!exp.bankrupt && exp.ownerId !== 'player') {
          aiExporterTryShipment(state, exp);
        }
      }
      if (state.time.totalDays % 7 === 0) tickAIWeekly(state);
    }
    if (events.month) {
      tickMiningOps(state);
      tickStorageCost(state);
      tickLaborMarket(state);
      tickLoans(state);
      tickFiscalCrisis(state);
      tickAIMonthly(state);
    }
    if (events.year) {
      tickCityYearly(state);
      tickCountriesYearly(state);
    }

    // 6. Drain visual FX queue (no Phaser consumer in headless).
    if (state.fxQueue) state.fxQueue.length = 0;

    // 7. Trace hook.
    onTick?.({ state, obs, acts, results, events, day: state.time.totalDays });

    if (state.player.bankrupt) break;
  }

  return state;
}

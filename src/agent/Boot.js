// Boot — initialization headless del state, sin Phaser.
//
// `createInitialState` ya existía como función pura. Acá sólo encadenamos los
// mismos pasos que la scene de Phaser hace en `Game.create()` para que el
// motor headless arranque idéntico:
//
//   state = createInitialState();
//   initAIFarmers(state);
//   seedIndustries(state);
//
// Si en algún momento un sistema empieza a depender de `localStorage` u otra
// API del browser fuera de los try/catch existentes, este archivo es el lugar
// donde se va a notar primero (la primera corrida bajo node va a explotar).
// La función `loadTutorialState` ya tiene try/catch que devuelve un default
// cuando localStorage no existe, así que el boot bajo node funciona limpio.

import { createInitialState, initAIFarmers } from '../state/GameState.js';
import { seedIndustries } from '../systems/WorldSeed.js';

export function bootHeadlessState() {
  const state = createInitialState();
  initAIFarmers(state);
  seedIndustries(state);
  return state;
}

// Avance determinístico de un día. Bypassa el accumulator de Clock.js — no nos
// importa el delta-time real, queremos un tick por iteración del loop. Devuelve
// los mismos flags que tickClock para que las dos rutas (browser y headless)
// disparen las mismas ramas (events.day / events.month / events.year).
//
// Se replica acá la transición de calendario en vez de reusar Clock.tickClock
// porque tickClock está atado al accumulator de delta-time. Mantener esto en
// sync con Clock.js si el calendario cambia (días/mes, meses/año).
import { TIME } from '../data/tunables.js';

export function advanceOneDay(state) {
  const events = { day: true, month: false, year: false, daysAdvanced: 1 };
  state.time.totalDays += 1;
  state.time.day += 1;
  if (state.time.day > TIME.daysPerMonth) {
    state.time.day = 1;
    state.time.month += 1;
    events.month = true;
    if (state.time.month > TIME.monthsPerYear) {
      state.time.month = 1;
      state.time.year += 1;
      events.year = true;
    }
  }
  return events;
}

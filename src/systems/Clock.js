import { TIME } from '../data/tunables.js';

// Avanza el tiempo. Devuelve eventos: dayChanged, monthChanged, yearChanged.
export function tickClock(state, deltaMs) {
  const events = { day: false, month: false, year: false, daysAdvanced: 0 };
  if (state.time.paused) return events;

  const speed = TIME.speeds[state.time.speedIdx] ?? 1;
  if (speed === 0) return events;

  state.time.accumulator += deltaMs * speed;

  while (state.time.accumulator >= TIME.msPerDay) {
    state.time.accumulator -= TIME.msPerDay;
    state.time.day += 1;
    state.time.totalDays += 1;
    events.day = true;
    events.daysAdvanced += 1;

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
  }
  return events;
}

export function setSpeed(state, idx) {
  state.time.speedIdx = Math.max(0, Math.min(TIME.speeds.length - 1, idx));
  state.time.paused = TIME.speeds[state.time.speedIdx] === 0;
}

export function togglePause(state) {
  state.time.paused = !state.time.paused;
}

export function formatDate(state) {
  const t = state.time;
  return `${String(t.day).padStart(2, '0')}/${String(t.month).padStart(2, '0')}/${t.year}`;
}

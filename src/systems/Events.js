import { EVENTS } from '../data/tunables.js';
import { EVENT_TYPES, EVENT_TYPE_LIST } from '../data/eventTypes.js';
import { pushLog, logEvent } from '../state/GameState.js';

// Effect handlers — keyed by effectId from eventTypes.js.
// Adding a new effectId = add a handler here. Adding a new event type using an existing effectId
// requires zero code changes.
//
// Each handler may implement:
//   onApply(state, params, event)    — at trigger time
//   onRemove(state, params, event)   — at expiry
//   growthMultiplier(params)         — read each tick by Farming.js (optional)
const effectHandlers = {
  growthPenalty: {
    growthMultiplier: (params) => params.multiplier,
  },
  instantTileLoss: {
    onApply(state, params) {
      let playerLoss = 0;
      const playerTiles = [];
      // Pest/frost hits planted tiles in EVERY country.
      const allTilesArr = [];
      for (const cid of Object.keys(state.maps || {})) {
        for (const t of state.maps[cid].tiles) allTilesArr.push(t);
      }
      for (const tile of allTilesArr) {
        if (tile.state !== 'planted') continue;
        if (Math.random() < (params.lossChance ?? 0)) {
          if (tile.owner === 'player') {
            playerLoss += 1;
            playerTiles.push(`(${tile.x},${tile.y})`);
          }
          tile.state = 'fallow';
          tile.crop = null;
          tile.growth = 0;
        }
      }
      if (playerLoss > 0) {
        const where = playerTiles.length <= 3 ? ` ${playerTiles.join(' ')}` : '';
        pushLog(state, `⚠ Lost ${playerLoss} planted tile${playerLoss > 1 ? 's' : ''}${where}`);
      }
    },
  },
  modifyPreference: {
    onApply(state, params, event) {
      const c = state.countries?.[params.country];
      if (!c) return;
      c.preferenceModifiers = c.preferenceModifiers || {};
      const prev = c.preferenceModifiers[params.producibleId] ?? 1;
      event._prevModifier = prev;
      c.preferenceModifiers[params.producibleId] = prev * (params.factor ?? 1);
    },
    onRemove(state, params, event) {
      const c = state.countries?.[params.country];
      if (!c) return;
      c.preferenceModifiers[params.producibleId] = event._prevModifier ?? 1;
    },
  },
  // Population shock — drops/raises population by `factor` for the duration.
  // Demand scales with population in tickCountriesYearly so this directly bites trade.
  gdpShock: {
    onApply(state, params, event) {
      const c = state.countries?.[params.country];
      if (!c) return;
      const f = params.factor ?? 1;
      event._appliedFactor = f;       // remember exactly what we multiplied by
      c.population *= f;
      for (const pid of Object.keys(c.consumption)) c.consumption[pid] *= f;
    },
    onRemove(state, params, event) {
      const c = state.countries?.[params.country];
      if (!c) return;
      // Reverse the exact factor we applied — safe even when events overlap.
      const f = event._appliedFactor ?? (params.factor ?? 1);
      if (!f) return;
      c.population /= f;
      for (const pid of Object.keys(c.consumption)) c.consumption[pid] /= f;
    },
  },
};

export function tickEvents(state) {
  state.activeEvents = state.activeEvents.filter(e => {
    e.daysRemaining -= 1;
    if (e.daysRemaining <= 0) {
      const def = EVENT_TYPES[e.type];
      if (def) effectHandlers[def.effectId]?.onRemove?.(state, def.params, e);
      const label = def?.label ?? e.type;
      const country = def?.params?.country ?? null;
      pushLog(state, `Ended: ${label}`);
      logEvent(state, {
        tier: 1, category: 'world-event-end',
        countryId: country, summary: `Ended: ${label}`,
        meta: { type: e.type, appliedDay: e.appliedDay ?? null },
      });
      return false;
    }
    return true;
  });

  if (state.activeEvents.length < EVENTS.maxConcurrent && Math.random() < EVENTS.dailyChance) {
    const def = rollEventType();
    const event = { type: def.id, daysRemaining: def.duration, appliedDay: state.time.totalDays };
    effectHandlers[def.effectId]?.onApply?.(state, def.params, event);
    state.activeEvents.push(event);
    pushLog(state, `EVENT: ${def.label}`);
    logEvent(state, {
      tier: 1, category: 'world-event-start',
      countryId: def.params?.country ?? null,
      summary: `EVENT: ${def.label}`,
      meta: { type: def.id, duration: def.duration },
    });
  }
}

function rollEventType() {
  const total = EVENT_TYPE_LIST.reduce((s, d) => s + d.weight, 0);
  let r = Math.random() * total;
  for (const d of EVENT_TYPE_LIST) {
    if (r < d.weight) return d;
    r -= d.weight;
  }
  return EVENT_TYPE_LIST[0];
}

export function growthMultiplier(state) {
  let m = 1;
  for (const e of state.activeEvents) {
    const def = EVENT_TYPES[e.type];
    const handler = effectHandlers[def?.effectId];
    if (handler?.growthMultiplier) m *= handler.growthMultiplier(def.params);
  }
  return m;
}


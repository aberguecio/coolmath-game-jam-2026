// Event types registry. Adding a new event type = one entry here.
// If `effectId` already has a handler in src/systems/Events.js, no code changes needed.
// Otherwise, add the handler in the same map.
//
// Schema:
//   id              unique key
//   label           display label
//   weight          probability weight when rolling a new event
//   duration        days the event lasts (1 for instant)
//   effectId        key into the effectHandlers map in Events.js
//   params          arbitrary payload passed to the handler

export const EVENT_TYPES = {
  drought: {
    id: 'drought',
    label: 'Drought',
    weight: 2,
    duration: 60,
    effectId: 'growthPenalty',
    params: { multiplier: 0.4 },
  },
  pest: {
    id: 'pest',
    label: 'Pest outbreak',
    weight: 1,
    duration: 1,
    effectId: 'instantTileLoss',
    params: { lossChance: 0.15 },     // per-tile chance of being wiped
  },
  frost: {
    id: 'frost',
    label: 'Frost',
    weight: 1,
    duration: 1,
    effectId: 'instantTileLoss',
    params: { lossChance: 0.25 },
  },
};

export const EVENT_TYPE_LIST = Object.values(EVENT_TYPES);

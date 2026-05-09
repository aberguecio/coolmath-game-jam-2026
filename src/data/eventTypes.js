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
  chinaTariffApple: {
    id: 'chinaTariffApple',
    label: 'China apple tariff',
    weight: 1,
    duration: 90,
    effectId: 'modifyPreference',
    params: { country: 'china', producibleId: 'apple', factor: 0.4 },
  },
  euWheatBoom: {
    id: 'euWheatBoom',
    label: 'EU wheat demand surge',
    weight: 1,
    duration: 60,
    effectId: 'modifyPreference',
    params: { country: 'germany', producibleId: 'wheat', factor: 1.6 },
  },
  brazilCornShortage: {
    id: 'brazilCornShortage',
    label: 'Brazil corn shortage',
    weight: 1,
    duration: 45,
    effectId: 'modifyPreference',
    params: { country: 'brazil', producibleId: 'corn', factor: 1.8 },
  },
  usaRecession: {
    id: 'usaRecession',
    label: 'US recession',
    weight: 1,
    duration: 120,
    effectId: 'gdpShock',
    params: { country: 'usa', factor: 0.92 },
  },
};

export const EVENT_TYPE_LIST = Object.values(EVENT_TYPES);

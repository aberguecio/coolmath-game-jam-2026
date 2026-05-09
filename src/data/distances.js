// Symmetric distance graph between countries. Drives transport cost on cross-country sales.
// Adding a country = add one row + matching cells in every other row. The validator at boot
// (GameState.validateRegistries) refuses to start if the matrix isn't symmetric and total.

export const DISTANCES = {
  home:    { home: 0, usa: 4,  china: 9, brazil: 5, germany: 7 },
  usa:     { home: 4, usa: 0,  china: 8, brazil: 5, germany: 5 },
  china:   { home: 9, usa: 8,  china: 0, brazil: 11, germany: 6 },
  brazil:  { home: 5, usa: 5,  china: 11, brazil: 0, germany: 7 },
  germany: { home: 7, usa: 5,  china: 6, brazil: 7, germany: 0 },
};

export const TRANSPORT = {
  // $ per unit per distance step. Tunable, low so transport is significant but not dominant.
  perUnitPerDistance: 0.6,
};

export function distanceBetween(fromCid, toCid) {
  return DISTANCES[fromCid]?.[toCid] ?? 0;
}

export function transportCost(fromCid, toCid, units, unitPrice = 0) {
  if (fromCid === toCid) return 0;
  return distanceBetween(fromCid, toCid) * TRANSPORT.perUnitPerDistance * units;
}

import { CITY, MAP } from '../data/tunables.js';
import { pushLog } from '../state/GameState.js';

export function distanceToCity(tile, city) {
  const dx = tile.x - city.x;
  const dy = tile.y - city.y;
  return Math.sqrt(dx * dx + dy * dy);
}

export function cityRadius(city) {
  // Crece logarítmicamente con la población
  const popRatio = Math.max(1, city.population / CITY.startPopulation);
  return CITY.baseRadius + Math.log(popRatio) * CITY.radiusPerLogPop;
}

export function isInsideHalo(tile, city) {
  return distanceToCity(tile, city) <= cityRadius(city);
}

// Yearly growth for every country's city.
export function tickCityYearly(state) {
  const cities = state.cities || {};
  for (const cid of Object.keys(cities)) {
    const c = cities[cid];
    c.population = Math.round(c.population * (1 + CITY.yearlyGrowth));
  }
  // Only log home city growth (the player cares about their own).
  const home = cities.home;
  if (home) pushLog(state, `Home city grew to ${home.population.toLocaleString()} pop. Halo: ${cityRadius(home).toFixed(1)} tiles.`);
}

export function lotePrice(tile, city) {
  const r = cityRadius(city);
  const d = distanceToCity(tile, city);
  if (d > r) return 0;
  const proximity = 1 - d / r;                       // 0 borde, 1 centro
  const popMult = Math.max(1, city.population / CITY.startPopulation);
  const mult = 1 + proximity * (CITY.loteMaxMultiplier - 1);
  return Math.round(CITY.loteBasePrice * mult * Math.sqrt(popMult));
}

// Estado inicial expuesto para que GameState lo importe.
export function createCityState() {
  return {
    x: CITY.x,
    y: CITY.y,
    population: CITY.startPopulation,
  };
}

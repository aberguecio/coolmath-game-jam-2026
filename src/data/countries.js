// Town registry. Single-town configuration — only 'home' exists.
// Multi-country can be re-introduced by adding entries to COUNTRIES;
// all loops operate over COUNTRY_IDS so no structural refactor is needed.
//
// Per-town fields:
//   taxRatesId             references TAX_RATES bracket
//   supplyResponsiveness   how aggressively producers pivot to prices
//   preferences            {pid → weight} food-preference shares for population spending

export const PLAYER_COUNTRY_ID = 'home';

// Baseline shared by every town. La oferta de bienes corre por agentes
// reales (AI farmers, AI miners). `consumption` queda como
// sizing-parameter para targetStock (góndola buffer) + peso del basket de
// priceIndex + escalado por crecimiento poblacional. NO drena la góndola.
const TOWN_BASELINE = {
  population: 1000,
  populationGrowth: 0.010,
  supplyResponsiveness: 2.0,
  taxRatesId: 'homeRates',
  consumption: {
    wheat: 8, corn: 6, apple: 2, potato: 6, cherry: 0.8,
    copper: 0.4, iron: 2.0, gold: 0.03,
  },
  preferences: {
    potato: 1.0, wheat: 1.1, corn: 0.9, apple: 0.7, cherry: 0.5,
  },
};

function makeTown(id, name, flagColor) {
  return { id, name, flagColor, ...TOWN_BASELINE };
}

export const COUNTRIES = {
  home: makeTown('home', 'Home', 0x6ee7b7),
};

export const COUNTRY_IDS = Object.keys(COUNTRIES);

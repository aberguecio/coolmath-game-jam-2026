// Town registry. The "country" abstraction is now treated as a town/village.
// All towns start with the same population (200), same baseline production,
// consumption, preferences, tax rates and growth — they only differ by name
// and flag colour. Differentiation emerges from random mineral deposits,
// player decisions, and AI behaviour, not from hardcoded asymmetries.
//
// Internal IDs (home/usa/china/brazil/germany) are KEPT so distances.js,
// taxRates.js, CITY_POSITIONS, validators and existing imports stay valid.
// Only the visible `name` changes.
//
// Per-town fields:
//   taxRatesId             references TAX_RATES bracket (all towns share homeRates)
//   supplyResponsiveness   how aggressively producers pivot to prices
//   preferences            {pid → weight} food-preference shares for population spending

export const PLAYER_COUNTRY_ID = 'home';

// Baseline shared by every town. La oferta de bienes corre por agentes
// reales (AI farmers, AI miners, AI industries). `consumption` queda como
// sizing-parameter para targetStock (góndola buffer) + peso del basket de
// priceIndex + escalado por crecimiento poblacional, NO drena la góndola.
const TOWN_BASELINE = {
  population: 1000,
  populationGrowth: 0.010,
  supplyResponsiveness: 2.0,
  taxRatesId: 'homeRates',
  consumption: {
    wheat: 8, corn: 6, apple: 2, potato: 6, cherry: 0.8,
    copper: 0.4, iron: 2.0, gold: 0.03,
    flour: 0.6, mechanicalPart: 1.2, electricalPart: 0.8,
  },
  preferences: {
    potato: 1.0, wheat: 1.1, corn: 0.9, apple: 0.7, cherry: 0.5,
    flour: 0.6,
  },
};

function makeTown(id, name, flagColor) {
  return { id, name, flagColor, ...TOWN_BASELINE };
}

export const COUNTRIES = {
  home:    makeTown('home',    'Home',      0x6ee7b7),
  usa:     makeTown('usa',     'Riverside', 0x4a7ec5),
  china:   makeTown('china',   'Oakdale',   0xc94a3a),
  brazil:  makeTown('brazil',  'Pinegrove', 0x4ca84c),
  germany: makeTown('germany', 'Hillcrest', 0xe8e6a0),
};

export const COUNTRY_IDS = Object.keys(COUNTRIES);

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
//   seededIndustries       industry recipe ids that exist already operational at start

export const PLAYER_COUNTRY_ID = 'home';

// Baseline shared by every town. Modelled on the old "Home" values.
const TOWN_BASELINE = {
  population: 2000,
  populationGrowth: 0.010,
  supplyResponsiveness: 2.0,
  taxRatesId: 'homeRates',
  domesticProduction: {
    wheat: 4, corn: 2, apple: 1, potato: 3, cherry: 0.4,
    copper: 0.1, iron: 0.6, gold: 0.01,
    flour: 0, juice: 0, jewelry: 0, steel: 0, cable: 0, pie: 0,
  },
  consumption: {
    wheat: 8, corn: 6, apple: 2, potato: 6, cherry: 0.8,
    copper: 0.4, iron: 2.0, gold: 0.03,
    flour: 0.6, juice: 0.5, jewelry: 0.05, steel: 1.2, cable: 0.8, pie: 0.4,
  },
  preferences: {
    potato: 1.0, wheat: 1.1, corn: 0.9, apple: 0.7, cherry: 0.5,
    flour: 0.6, juice: 0.5, pie: 0.7,
  },
};

function makeTown(id, name, flagColor, seededIndustries) {
  return { id, name, flagColor, ...TOWN_BASELINE, seededIndustries };
}

export const COUNTRIES = {
  home:    makeTown('home',    'Home',      0x6ee7b7, ['bakery']),
  usa:     makeTown('usa',     'Riverside', 0x4a7ec5, ['flourMill']),
  china:   makeTown('china',   'Oakdale',   0xc94a3a, ['juicePlant']),
  brazil:  makeTown('brazil',  'Pinegrove', 0x4ca84c, ['steelworks']),
  germany: makeTown('germany', 'Hillcrest', 0xe8e6a0, ['jewelryShop']),
};

export const COUNTRY_LIST = Object.values(COUNTRIES);
export const COUNTRY_IDS = Object.keys(COUNTRIES);

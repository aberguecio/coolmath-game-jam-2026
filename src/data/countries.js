// Country registry. Each country has population, daily domestic production, and daily
// consumption per producible. Adding a new country = one entry; the market simulator
// iterates COUNTRIES and the chart UI picks it up automatically.
//
// New economy fields (per the real-economic refactor):
//   taxRatesId             references TAX_RATES bracket
//   supplyResponsiveness   how aggressively producers pivot to prices
//   preferences            {pid → weight} food-preference shares for population spending
//   seededIndustries       industry recipe ids that exist already operational at start
//   treasurySeed           opening treasury (otherwise computed from population × default)

export const PLAYER_COUNTRY_ID = 'home';

export const COUNTRIES = {
  home: {
    id: 'home', name: 'Home', flagColor: 0x6ee7b7,
    population: 5,
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
    preferences: { potato: 1.0, wheat: 1.1, corn: 0.9, apple: 0.7, cherry: 0.5, flour: 0.6, juice: 0.5, pie: 0.7 },
    seededIndustries: ['bakery'],
  },

  usa: {
    id: 'usa', name: 'USA', flagColor: 0x4a7ec5,
    population: 330,
    populationGrowth: 0.005,
    supplyResponsiveness: 0.7,
    taxRatesId: 'usaRates',
    domesticProduction: {
      wheat: 240, corn: 320, apple: 12, potato: 130, cherry: 6,
      copper: 14, iron: 60, gold: 3,
      flour: 0, juice: 0, jewelry: 0, steel: 0, cable: 0, pie: 0,
    },
    consumption: {
      wheat: 130, corn: 230, apple: 32, potato: 130, cherry: 9,
      copper: 14, iron: 70, gold: 2.4,
      flour: 30, juice: 25, jewelry: 5, steel: 75, cable: 50, pie: 20,
    },
    preferences: { wheat: 1.0, corn: 1.4, apple: 0.8, potato: 0.9, cherry: 0.6, flour: 0.9, juice: 0.7, pie: 0.7 },
    seededIndustries: ['flourMill'],
  },

  china: {
    id: 'china', name: 'China', flagColor: 0xc94a3a,
    population: 1400,
    populationGrowth: 0.002,
    supplyResponsiveness: 0.6,
    taxRatesId: 'chinaRates',
    domesticProduction: {
      wheat: 130, corn: 320, apple: 650, potato: 340, cherry: 8,
      copper: 55, iron: 180, gold: 6,
      flour: 0, juice: 0, jewelry: 0, steel: 0, cable: 0, pie: 0,
    },
    consumption: {
      wheat: 210, corn: 330, apple: 600, potato: 310, cherry: 16,
      copper: 50, iron: 200, gold: 5.5,
      flour: 60, juice: 100, jewelry: 12, steel: 180, cable: 110, pie: 18,
    },
    preferences: { apple: 2.0, wheat: 1.2, corn: 0.8, potato: 1.0, cherry: 1.6, flour: 0.6, juice: 1.2, pie: 0.5 },
    seededIndustries: ['juicePlant'],
  },

  brazil: {
    id: 'brazil', name: 'Brazil', flagColor: 0x4ca84c,
    population: 215,
    populationGrowth: 0.008,
    supplyResponsiveness: 0.9,
    taxRatesId: 'brazilRates',
    domesticProduction: {
      wheat: 30, corn: 100, apple: 6, potato: 60, cherry: 16,
      copper: 5, iron: 100, gold: 0.6,
      flour: 0, juice: 0, jewelry: 0, steel: 0, cable: 0, pie: 0,
    },
    consumption: {
      wheat: 70, corn: 110, apple: 18, potato: 55, cherry: 5,
      copper: 4, iron: 35, gold: 0.4,
      flour: 18, juice: 14, jewelry: 2, steel: 40, cable: 18, pie: 6,
    },
    preferences: { corn: 1.5, wheat: 0.7, apple: 0.4, potato: 1.0, cherry: 1.0, flour: 0.8, juice: 0.9, pie: 0.5 },
    seededIndustries: ['steelworks'],
  },

  germany: {
    id: 'germany', name: 'Germany', flagColor: 0xe8e6a0,
    population: 84,
    populationGrowth: 0.002,
    supplyResponsiveness: 0.8,
    taxRatesId: 'germanyRates',
    domesticProduction: {
      wheat: 65, corn: 22, apple: 9, potato: 28, cherry: 2,
      copper: 1.5, iron: 10, gold: 0.4,
      flour: 0, juice: 0, jewelry: 0, steel: 0, cable: 0, pie: 0,
    },
    consumption: {
      wheat: 55, corn: 65, apple: 22, potato: 32, cherry: 5.5,
      copper: 9, iron: 45, gold: 1.1,
      flour: 12, juice: 8, jewelry: 4, steel: 50, cable: 30, pie: 5,
    },
    preferences: { wheat: 1.3, apple: 1.0, corn: 0.6, potato: 0.9, cherry: 0.8, flour: 1.0, juice: 0.7, pie: 0.6 },
    seededIndustries: ['jewelryShop'],
  },
};

export const COUNTRY_LIST = Object.values(COUNTRIES);
export const COUNTRY_IDS = Object.keys(COUNTRIES);

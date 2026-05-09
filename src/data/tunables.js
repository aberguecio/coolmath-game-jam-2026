// Tunables — every magic number that's not specific to one producible.
// Per-producible stats live in producibles.js; loan products in loanProducts.js;
// countries in countries.js; event types in eventTypes.js.

export const TIME = {
  daysPerMonth: 30,
  monthsPerYear: 12,
  msPerDay: 500,            // 0.5s real = 1 day in-game
  startYear: 2026,
  startMonth: 1,
  startDay: 1,
  // Speed multipliers and their UI labels — same index, length must match.
  speeds:       [0,    1,    2,    4,    8],
  speedLabels:  ['‖',  '×1', '×2', '×4', '×8'],
};

export const MAP = {
  cols: 15,
  rows: 15,
  tilePx: 36,
};

// Defaults the per-producible market stats fall back to when a key is omitted.
// Prices float freely now — supply elasticity (production responds to price)
// is what keeps the system from running away in either direction.
export const ECONOMY_DEFAULTS = {
  basePrice: 100,
};

// Stock/flow simulator parameters.
export const MARKET = {
  stockBufferDays: 30,        // target inventory = expected daily demand × this
  responsiveness: 0.04,       // how aggressively prices adjust to stock gap each day
  noiseAmp: 0.005,            // tiny daily noise so prices don't freeze flat
  // Elasticity bounds for supply response (production = base × clamped factor).
  // Stops a tiny country from producing 0 OR exploding to infinity in extreme conditions.
  elasticityMin: 0.05,
  elasticityMax: 4.0,
  // Production responds to prices via a pure delay tied to each commodity's growthDays:
  // the DECISION to ramp up is instant, but new supply only arrives `growthDays` later.
  // This produces a natural cobweb cycle (high price → plant a lot → harvest hits,
  // price crashes → less planted → growthDays later, supply tight, price recovers).
  // Hard sanity floor on price so we never divide by zero or go negative.
  absoluteMinPrice: 0.5,
};

// Foreclosure auction sale price as a fraction of current market value.
// Uniform random in [min, max] each time a tile is seized.
export const FORECLOSURE = {
  saleMin: 0.70,
  saleMax: 0.80,
};

// Surveying & mineral discovery
export const MINERALS = {
  surveyCost: 300,                 // cash to test a tile for minerals
  discoveryRadius: 3,              // tiles around a discovered mineral get a price boost
  discoveryBoost: 0.6,             // adds up to +60% to nearby tile prices, fades with distance
  maxBoom: 2.5,                    // hard cap on cumulative boom multiplier
};

// Land offers between actors (AI ↔ player).
export const OFFERS = {
  expirationDays: 30,
  // AI generates outgoing offers on player tiles
  aiOfferChancePerDay: 0.004,      // ~1 every 250 days per AI per tick
  aiOfferRange: { min: 0.85, max: 1.10 },   // multiplier on tile market value
  // Player counters an AI offer: accept_prob = baseCounter − markup
  baseCounterAccept: 0.80,         // chance with zero markup (ie. just accept the original)
  // Player offers to buy an AI tile:
  //   markup must be ≥ minMarkup; accept_prob ramps from base @ minMarkup to 1 @ alwaysMarkup
  buyMinMarkup: 0.10,
  buyAlwaysMarkup: 0.50,
  buyBaseAccept: 0.20,
  buyStep: 0.05,                   // UI stepper increments markup by this fraction
};

export const PLAYER_START = {
  cash: 0,                    // start broke — must take a loan
  // 1 free starter tile, placed in the center of the map.
  ownedTileIds: [Math.floor(MAP.rows / 2) * MAP.cols + Math.floor(MAP.cols / 2)],
};

export const TILE = {
  baseRuralPrice: 3000,
  qualityPriceFactor: 1500,
};

export const LAND_ACTIONS = {
  plow: { cost: 50, fromState: 'fallow', toState: 'plowed' },
};

export const CITY = {
  x: 13,
  y: 7,
  startPopulation: 5000,
  yearlyGrowth: 0.06,
  baseRadius: 2.5,
  radiusPerLogPop: 2.2,
  loteBasePrice: 12000,
  loteMaxMultiplier: 4,
};

export const AI = {
  count: 4,
  startCash: 6000,
  startTilesPerAI: 1,
  decisionEveryDays: 5,
  buyTileChance: 0.25,
  loanThreshold: 500,         // if cash drops below this, AI tries a working capital loan
  loanAmount: 5000,
  names: ['Old Pete', 'Sofia Co-op', 'North Ranch', 'Cabrera Bros.'],
  colors: [0xb24cae, 0x4ca6b2, 0xb27a3a, 0x6a4cb2],
};

// Top-level event scheduler. Per-event-type stats live in eventTypes.js.
export const EVENTS = {
  dailyChance: 0.012,
  maxConcurrent: 2,
};

// Wage / treasury / fiscal-crisis parameters. All numbers central so tuning is one edit.
export const WAGES = {
  // Estimated $/capita/day budget for food. Used to size wageFund/treasury seeds and the
  // welfare floor. Conservative — population spends MORE than this when food is abundant.
  dailyFoodCostPerCapita: 4,
  // wageFund seed = population × dailyFoodCostPerCapita × this
  wageFundSeedDays: 60,
  // treasury seed = population × dailyFoodCostPerCapita × this
  treasurySeedDays: 30,
  // If wageFund < populationCount × dailyFoodCostPerCapita × this → treasury tops up.
  wageFundFloorDays: 2,
  // Industries pay this per month-rollover; closed if owner can't pay.
  // (each industry's salary is in industries.js; this is just a tunable safety net.)
};

export const FISCAL_CRISIS = {
  triggerNegativeMonths: 3,    // negative treasury for this many months → crisis on
  recoveryPositiveMonths: 6,   // positive treasury for this many months → crisis off
  taxBumpPerMonth: 0.02,       // each crisis month: +0.02 to sale/b2b/import rates
  taxCapMultiplier: 2.0,       // crisis tax never exceeds 2× baseline
  preferenceCrushPerMonth: 0.05, // each crisis month: premium foods preferences shrink by this
  wageHaircutFraction: 0.10,   // industries' salary contribution to wageFund cut by this
};

// Cross-country logistics. Per-pair distances + per-unit shipping fee live in distances.js.

// Housing / city annexation: Section 9 of the plan — develop a halo tile (180d), list it for
// sale, the country's housing market buys when population pressure rises.
export const HOUSING = {
  developCost: 4000,
  developmentDays: 180,
  housingBase: 12000,            // base price of a developed lot
  proximityMaxBoost: 1.6,        // closer to city center → up to this multiplier
  scarcityFloor: 0.5,            // when many lots available, price never drops below this × base
  scarcityCeiling: 4.0,          // when very few lots, never exceeds this × base
};

// Stock holding for processed/raw inventory in industries (overflow buffer if needed).
export const INDUSTRY = {
  // ROI threshold for AI to build a new industry (per month, on buildCost).
  aiBuildRoiThreshold: 0.015,
  // AI uses this many days of moving-average prices for build/close decisions.
  aiPriceLookbackDays: 30,
  // Margin lookback before AI closes an industry.
  aiCloseMarginLookbackDays: 90,
};

// AI decision log buffer size (per company).
export const AI_DECISION_LOG_MAX = 20;


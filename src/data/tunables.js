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
  responsiveness: 0.01,       // max daily price change is ±1% (gap × responsiveness, gap ∈ [−1, 1])
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
  // labor in worker-months; cash cost = labor × wageRate(country)
  plow: { labor: 1, fromState: 'fallow', toState: 'plowed' },
};

// Farming behaviour tunables.
// - harvestGraceDays: days a mature annual sits unharvested before it rots
//   (perennials fall back to 'cosechado' instead — the plant survives, the
//   crop is lost). Stops mature tiles from blocking indefinitely.
// - harvestProfitMargin: autoHarvest only fires when the expected revenue is
//   at least this much × labor cost. 1.05 = needs ≥5% margin. Otherwise the
//   crop is skipped, increments tile.skipStreak, and risks rot if it never
//   becomes profitable.
// Storage — Sprint B. Holding inventory costs warehouse labor each month.
// Charged per unit stored × wageRate(country); flows to country wageFund.
// Creates an explicit cost of hoarding so AI prefers selling at fair prices
// over waiting for impossible peaks.
export const STORAGE = {
  unitWarehouseLabor: 0.02,      // worker-months per unit per month
};

export const FARMING = {
  harvestGraceDays: 30,
  harvestProfitMargin: 1.05,
  // Workers tending a crop tile while in cultivation (planted/mature/cosechado).
  // Uniform across all crops so a wheat field and a manzano demand the same
  // sustained labor — harvest spikes themselves are paid as cash cost, not
  // counted in the labor-market demand.
  tileTendingLabor: 1,
};


export const CITY = {
  x: 13,
  y: 7,
  startPopulation: 1000,       // matches town population — the city IS the town's urban core
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
  // === Inventory / sale strategy (Sprint B) ============================
  // AI stops dump-selling harvests. Output goes to ai.inventory and is
  // drained gradually when the spot price is close enough to the MA60.
  sellThreshold: 0.85,           // sell only when currentPrice ≥ MA60 × this
  sellRate: 0.15,                // 15% of stock sold per monthly attempt
  inventoryCapDays: 30,          // hard cap = N days of local consumption; dump if exceeded
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
  // === Labor market (Sprint A) — wageRate emerges from supply/demand ===
  // No clamps: if wageRate runs away, the feedback loop is broken (eg. labour
  // demand growing without industries closing in response). Find the open
  // loop, don't paper it over with a cap.
  baseWage: 50,                  // $/mes/worker at neutral tightness × neutral priceIndex
  // workersPerPopUnit: fraction of `country.population` that's working-age.
  // 0.5 = half the citizens are in the labour force. With pop=2000, each town
  // starts with 1000 workers — comfortable margin over the ~190-worker
  // demand from seeded ventures.
  workersPerPopUnit: 0.5,
  emaHalfLifeDays: 60,           // smoothing window for wageRate EMA (friction, not a cap)
  // === Nutrition target (Sprint X — dynamic consumption) ====================
  // Each person needs this much "nutrition units" per day to survive. Foods
  // contribute via their `nutritionUnits` field. populationSpend stops buying
  // once acquired nutrition reaches population × NUTRITION_PER_CAPITA × WELL_BEING_FACTOR.
  // If budget can't cover this, hunger is implicit (less consumed → target drops).
  nutritionPerCapita: 0.1,
  wellBeingFactor: 1.2,           // +20% over survival when they can afford it
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



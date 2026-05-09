// Single registry for everything that flows through the economy: raw farm/mine output AND
// processed industry output. Adding a producible = one entry; no code changes elsewhere.
//
// Schema:
//   id, name, color
//   category         'annual_crop' | 'perennial_crop' | 'mining' | 'processed'
//   commodityType    'food' | 'material' (drives population consumption rules)
//   processStage     'raw' | 'processed' | 'final'
//   nutritionUnits   (food only) caloric value per unit; 0 for materials
//   wagePortion      fraction of every sale that becomes worker wages (0.10–0.40)
//
//   Tile-grown producibles only (skip for processed factory outputs):
//     actionVerb, seedCost, requiresPlow,
//     growthDays, growthCurve { base, qualitySlope },
//     yieldUnits, yieldCurve { base, qualitySlope },
//     perennial: null | { regrowDays, lifespanDays },
//     patches?: mineral patch config
//
//   market           { basePrice, ...optional overrides }

export const PRODUCIBLES = {
  // === RAW CROPS (food) =========================================================
  wheat: {
    id: 'wheat', name: 'Wheat', color: 0xe8c46b,
    category: 'annual_crop',
    commodityType: 'food', processStage: 'raw',
    nutritionUnits: 1.2, wagePortion: 0.35,
    seedCost: 200, requiresPlow: true,
    growthDays: 90,
    growthCurve: { base: 0.7, qualitySlope: 0.6 },
    yieldUnits: 5,
    yieldCurve: { base: 0.6, qualitySlope: 0.6 },
    perennial: null,
    consumption: { nutritionWeight: 1.2 },
    market: { basePrice: 80 },
  },

  corn: {
    id: 'corn', name: 'Corn', color: 0xf5d147,
    category: 'annual_crop',
    commodityType: 'food', processStage: 'raw',
    nutritionUnits: 1.0, wagePortion: 0.35,
    seedCost: 400, requiresPlow: true,
    growthDays: 150,
    growthCurve: { base: 0.7, qualitySlope: 0.6 },
    yieldUnits: 7,
    yieldCurve: { base: 0.6, qualitySlope: 0.6 },
    perennial: null,
    consumption: { nutritionWeight: 1.0 },
    market: { basePrice: 130 },
  },

  potato: {
    id: 'potato', name: 'Potato', color: 0xa07a4a,
    category: 'annual_crop',
    commodityType: 'food', processStage: 'raw',
    nutritionUnits: 1.1, wagePortion: 0.35,
    seedCost: 250, requiresPlow: true,
    growthDays: 70,
    growthCurve: { base: 0.8, qualitySlope: 0.5 },
    yieldUnits: 8,
    yieldCurve: { base: 0.7, qualitySlope: 0.5 },
    perennial: null,
    consumption: { nutritionWeight: 1.1 },
    market: { basePrice: 50 },
  },

  apple: {
    id: 'apple', name: 'Apple Tree', color: 0xd14b3a,
    category: 'perennial_crop',
    commodityType: 'food', processStage: 'raw',
    nutritionUnits: 0.7, wagePortion: 0.30,
    seedCost: 2000, requiresPlow: true,
    growthDays: 730,
    growthCurve: { base: 0.7, qualitySlope: 0.6 },
    yieldUnits: 22,
    yieldCurve: { base: 0.6, qualitySlope: 0.6 },
    perennial: { regrowDays: 365, lifespanDays: 365 * 12 },
    consumption: { nutritionWeight: 0.6 },
    market: { basePrice: 120 },
  },

  cherry: {
    id: 'cherry', name: 'Cherry Tree', color: 0xc73654,
    category: 'perennial_crop',
    commodityType: 'food', processStage: 'raw',
    nutritionUnits: 0.5, wagePortion: 0.30,
    seedCost: 2800, requiresPlow: true,
    growthDays: 1095,
    growthCurve: { base: 0.6, qualitySlope: 0.8 },
    yieldUnits: 16,
    yieldCurve: { base: 0.5, qualitySlope: 0.8 },
    perennial: { regrowDays: 365, lifespanDays: 365 * 10 },
    consumption: { nutritionWeight: 0.5 },
    market: { basePrice: 220 },
  },

  // === RAW MINERALS (material) ==================================================
  copper: {
    id: 'copper', name: 'Copper', color: 0xc97f3a,
    category: 'mining',
    commodityType: 'material', processStage: 'raw',
    nutritionUnits: 0, wagePortion: 0.10,
    actionVerb: 'Mine',
    seedCost: 4000, requiresPlow: false,
    growthDays: 270,
    growthCurve: { base: 0.8, qualitySlope: 0.4 },
    yieldUnits: 1,
    yieldCurve: { base: 0.4, qualitySlope: 1.0 },
    perennial: { regrowDays: 30, lifespanDays: 365 * 30 },
    consumption: { nutritionWeight: 0.0 },
    market: { basePrice: 250 },
    patches: { count: 2, sizePerPatch: 12, richness: { min: 0.4, max: 0.9 } },
  },

  iron: {
    id: 'iron', name: 'Iron', color: 0x6e6e75,
    category: 'mining',
    commodityType: 'material', processStage: 'raw',
    nutritionUnits: 0, wagePortion: 0.10,
    actionVerb: 'Mine',
    seedCost: 2500, requiresPlow: false,
    growthDays: 180,
    growthCurve: { base: 0.85, qualitySlope: 0.3 },
    yieldUnits: 2,
    yieldCurve: { base: 0.5, qualitySlope: 0.8 },
    perennial: { regrowDays: 30, lifespanDays: 365 * 40 },
    consumption: { nutritionWeight: 0.0 },
    market: { basePrice: 90 },
    patches: { count: 3, sizePerPatch: 12, richness: { min: 0.5, max: 1.0 } },
  },

  gold: {
    id: 'gold', name: 'Gold', color: 0xffd942,
    category: 'mining',
    commodityType: 'material', processStage: 'raw',
    nutritionUnits: 0, wagePortion: 0.08,
    actionVerb: 'Mine',
    seedCost: 9000, requiresPlow: false,
    growthDays: 365,
    growthCurve: { base: 0.5, qualitySlope: 0.9 },
    yieldUnits: 1,
    yieldCurve: { base: 0.5, qualitySlope: 0.8 },
    perennial: { regrowDays: 30, lifespanDays: 365 * 50 },
    consumption: { nutritionWeight: 0.0 },
    market: { basePrice: 600 },
    patches: { count: 1, sizePerPatch: 12, richness: { min: 0.3, max: 1.0 } },
  },

  // === PROCESSED — outputs of industries ========================================
  // No tile-grown stats; can only be created by an industry that lists this id as output.

  flour: {
    id: 'flour', name: 'Flour', color: 0xeec27a,
    category: 'processed',
    commodityType: 'food', processStage: 'processed',
    nutritionUnits: 0.9, wagePortion: 0.25,
    market: { basePrice: 120 },
  },

  juice: {
    id: 'juice', name: 'Apple Juice', color: 0xff8a4a,
    category: 'processed',
    commodityType: 'food', processStage: 'processed',
    nutritionUnits: 0.6, wagePortion: 0.25,
    market: { basePrice: 200 },
  },

  jewelry: {
    id: 'jewelry', name: 'Jewelry', color: 0xffe066,
    category: 'processed',
    commodityType: 'material', processStage: 'final',
    nutritionUnits: 0, wagePortion: 0.30,
    market: { basePrice: 1200 },
  },

  steel: {
    id: 'steel', name: 'Steel', color: 0x9da0a6,
    category: 'processed',
    commodityType: 'material', processStage: 'processed',
    nutritionUnits: 0, wagePortion: 0.25,
    market: { basePrice: 220 },
  },

  cable: {
    id: 'cable', name: 'Cable', color: 0xb86a3a,
    category: 'processed',
    commodityType: 'material', processStage: 'processed',
    nutritionUnits: 0, wagePortion: 0.25,
    market: { basePrice: 380 },
  },

  pie: {
    id: 'pie', name: 'Cherry Pie', color: 0xd14b8a,
    category: 'processed',
    commodityType: 'food', processStage: 'final',
    nutritionUnits: 1.4, wagePortion: 0.30,
    market: { basePrice: 280 },
  },
};

export const PRODUCIBLE_LIST = Object.values(PRODUCIBLES);
export const PRODUCIBLE_IDS = Object.keys(PRODUCIBLES);

// Helpers used across systems and the IndustryModal.
export function isFood(producibleId) {
  return PRODUCIBLES[producibleId]?.commodityType === 'food';
}
export function isRaw(producibleId) {
  return PRODUCIBLES[producibleId]?.processStage === 'raw';
}
export function isProcessed(producibleId) {
  const p = PRODUCIBLES[producibleId];
  return p && (p.processStage === 'processed' || p.processStage === 'final');
}
// Tile-buildable producibles only (excludes processed-only outputs).
export function isTileGrowable(producibleId) {
  const p = PRODUCIBLES[producibleId];
  return p && p.category !== 'processed';
}

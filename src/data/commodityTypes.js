// Commodity classification — drives consumption rules, taxes, and recipe eligibility.
// Adding a new type or stage = one entry; producibles reference these by id.

export const COMMODITY_TYPES = {
  food:     { id: 'food',     label: 'Food',     consumedByPopulation: true,  taxable: true },
  material: { id: 'material', label: 'Material', consumedByPopulation: false, taxable: true },
};

export const PROCESS_STAGES = {
  raw:       { id: 'raw',       stage: 0, label: 'Raw' },
  processed: { id: 'processed', stage: 1, label: 'Processed' },
  final:     { id: 'final',     stage: 2, label: 'Final' },
};

export const COMMODITY_TYPE_IDS = Object.keys(COMMODITY_TYPES);
export const PROCESS_STAGE_IDS = Object.keys(PROCESS_STAGES);

// Industry / recipe registry. Each entry is a buildable factory: takes input commodities,
// produces output commodities each cycle, and employs `workforce` workers whose monthly
// salary is `workforce × wageRate(country)` (Sprint A). Build cost paid upfront;
// ~90 days until operational.
//
// Adding a recipe = one entry. Inputs/outputs reference producibles by id; the load-time
// validator errors if any reference is missing.

export const INDUSTRIES = {
  flourMill: {
    id: 'flourMill',
    name: 'Flour Mill',
    color: 0xeec27a,
    inputs:  { corn: 3 },
    outputs: { flour: 1 },
    cycleDays: 7,
    workforce: 16,
    buildCost: 6000,
    buildDays: 90,
  },
  mechanicalPartFactory: {
    id: 'mechanicalPartFactory',
    name: 'Mechanical Parts Factory',
    color: 0x8a8a92,
    inputs:  { iron: 4 },
    outputs: { mechanicalPart: 1 },
    cycleDays: 10,
    workforce: 30,
    buildCost: 9000,
    buildDays: 90,
  },
  electricalPartFactory: {
    id: 'electricalPartFactory',
    name: 'Electrical Parts Factory',
    color: 0xb86a3a,
    inputs:  { copper: 2 },
    outputs: { electricalPart: 1 },
    cycleDays: 10,
    workforce: 28,
    buildCost: 8500,
    buildDays: 90,
  },
};

export const INDUSTRY_IDS = Object.keys(INDUSTRIES);

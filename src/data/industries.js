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
    cycleDays: 7,             // produces every N days when inputs available
    workforce: 16,            // workers × wageRate = monthly salary (was monthlySalary: 800)
    buildCost: 6000,
    buildDays: 90,
  },
  juicePlant: {
    id: 'juicePlant',
    name: 'Juice Plant',
    color: 0xff8a4a,
    inputs:  { apple: 4 },
    outputs: { juice: 1 },
    cycleDays: 7,
    workforce: 24,
    buildCost: 8000,
    buildDays: 90,
  },
  jewelryShop: {
    id: 'jewelryShop',
    name: 'Jewelry Workshop',
    color: 0xffd942,
    inputs:  { gold: 1 },
    outputs: { jewelry: 1 },
    cycleDays: 14,
    workforce: 50,
    buildCost: 14000,
    buildDays: 90,
  },
  steelworks: {
    id: 'steelworks',
    name: 'Steelworks',
    color: 0x8a8a92,
    inputs:  { iron: 4 },
    outputs: { steel: 1 },
    cycleDays: 10,
    workforce: 30,
    buildCost: 9000,
    buildDays: 90,
  },
  cableFactory: {
    id: 'cableFactory',
    name: 'Cable Factory',
    color: 0xb86a3a,
    inputs:  { copper: 2 },
    outputs: { cable: 1 },
    cycleDays: 10,
    workforce: 28,
    buildCost: 8500,
    buildDays: 90,
  },
  bakery: {
    id: 'bakery',
    name: 'Bakery (Pies)',
    color: 0xd14b8a,
    inputs:  { flour: 1, cherry: 1 },
    outputs: { pie: 1 },
    cycleDays: 5,
    workforce: 36,
    buildCost: 10000,
    buildDays: 90,
  },
};

export const INDUSTRY_IDS = Object.keys(INDUSTRIES);

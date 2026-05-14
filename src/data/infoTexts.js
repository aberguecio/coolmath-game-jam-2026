// Centralized explanations for every gameplay concept. Any UI element with an ℹ icon
// references one of these by key. Adding a new topic = one entry; touch nothing else.

export const INFO_TEXTS = {
  'wage-fund': {
    title: 'Wage Fund',
    body: 'Money the population has to spend on food. Refilled when companies pay salaries (35% of every production sale + monthly industry salaries). Drained daily by purchases. Government welfare tops it up if it falls too low.',
  },
  'treasury': {
    title: 'Treasury',
    body: 'Government cash. Filled by sale, B2B, and import taxes. Drained by welfare top-ups (covering wage-fund gap) and food deficit emergency buys. Can go negative — sustained negative = fiscal crisis with mechanical consequences.',
  },
  'fiscal-crisis': {
    title: 'Fiscal Crisis',
    body: 'Triggered when treasury < 0 for 3 consecutive months. Effects per crisis-month: tax rates rise (+0.02 sale/b2b/import each, capped 2× baseline), preferences compress (population shifts toward staples), industry salaries cut 10%. Recovers after 6 months of positive treasury.',
  },
  'price-local': {
    title: 'Local Price',
    body: 'Price within this country. Driven by local supply (production + harvests + imports) vs local demand (food + industry inputs + exports). Foreign sellers pay transport on top of their home price + import tax.',
  },
  'transport': {
    title: 'Transport Cost',
    body: 'Distance between country pairs × per-unit shipping fee. Local sale = $0. Cross-country sale: buyer pays source-country price + transport. Transport money is currently a sink (future: collected by a Logistics company).',
  },
  'tax-sale': {
    title: 'Sale Tax',
    body: 'Percent of every retail transaction (population buying food, player selling final goods to market). Paid by the buyer; goes straight to the country treasury. Different per country. Rises during fiscal crisis.',
  },
  'tax-b2b': {
    title: 'B2B Tax',
    body: 'Tax on company-to-company transactions: industries buying inputs, mortgages clearing, tile flips. Lower than retail tax in most countries.',
  },
  'tax-import': {
    title: 'Import Tax',
    body: 'Extra tax applied when goods cross a border into this country. Stacks on top of source-country sale tax. High import taxes protect domestic producers but raise local prices.',
  },
  'wage-portion': {
    title: 'Wage Portion',
    body: 'Fraction of every sale that becomes worker wages, flowing into the seller-country wage fund. Per producible (raw food ~35%, final goods ~25%). Configured in producibles.js.',
  },
  'industry-build': {
    title: 'Build Industry',
    body: 'Pay buildCost upfront. Tile is locked in "building" state for 90 days. When operational, every cycleDays the industry consumes inputs from your inventory and produces outputs. Every month it pays monthlySalary from your cash to the country wage fund — even if no production happened that cycle (idle).',
  },
  'industry-status': {
    title: 'Industry Status',
    body: 'building — countdown to operational · operational — producing if inputs available · idle — waiting for inputs but still paying salary · closed — not running, no salary, can be reopened by paying buildCost again.',
  },
  'halo': {
    title: 'Urban Halo',
    body: 'The 8 tiles immediately adjacent to any city tile. Industries can ONLY be built on halo tiles. Developing residential lots also requires halo. As the city annexes new tiles (via housing-market sales), the halo extends further out.',
  },
  'developed-tile': {
    title: 'Developed Tile',
    body: 'A halo tile you developed (paid setup, waited 180 days). Can be listed for sale to the city housing market. Sale price tracks population vs available developed tiles — high pop + low supply = expensive. When sold, the city annexes the tile and the halo extends.',
  },
  'preferences': {
    title: 'Food Preferences',
    body: 'How much each country wants each food. Population buys in preference order. If a preferred food is unaffordable, demand cascades to cheaper alternatives until budget runs out.',
  },
  'elasticity': {
    title: 'Supply Elasticity (delayed)',
    body: 'Producers respond to today\'s prices, but the actual harvest is delayed by the producible\'s growthDays. High prices today → more planted today → harvest arrives growthDays later. Cobweb cycles emerge naturally — no smoothing.',
  },
  'recipe': {
    title: 'Industry Recipe',
    body: 'inputs → outputs ratio, cycle frequency, monthly salary, build cost, build days. Inputs come from owner inventory; outputs go to owner inventory. Salary is paid monthly regardless of production.',
  },
  'company': {
    title: 'Company',
    body: 'Generic actor: cash + inventory + tiles + industries + loans. Player and AIs are both companies playing by the same rules. Bankrupt companies have their tiles foreclosed; their industries close.',
  },
  'population-spend': {
    title: 'Population Spending',
    body: 'Each day, the country wage fund buys food in preference order, capped by affordability. Cheap substitutes cover unmet premium demand. Sale tax on every purchase goes to treasury.',
  },
  'ai-decision': {
    title: 'AI Decision Log',
    body: 'AIs evaluate building/closing industries using 30-day moving-average prices (not spot) — this prevents impulsive reactions to short-term spikes. Every consideration is logged here so you can see why an AI did or didn\'t act.',
  },
};


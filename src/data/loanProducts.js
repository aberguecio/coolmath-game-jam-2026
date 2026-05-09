// Helper used by per-product eligibility/maxPrincipal: scans every country's map for
// tiles owned by the borrower. Keeps each product entry map-agnostic.
function ownedTilesAcrossMaps(state, ownerId) {
  const out = [];
  const maps = state.maps || {};
  for (const cid of Object.keys(maps)) {
    for (const t of maps[cid].tiles) {
      if (t.owner === ownerId) out.push(t);
    }
  }
  return out;
}

// Loan product registry. Adding a new product = one entry here. Bank.js & UI iterate this list.
//
// Schema:
//   id, name                     identity
//   description                  long-form text shown in the info popover
//   annualRate, termMonths       pricing
//   minPrincipal, step           UI stepper bounds; minPrincipal also enforced at apply
//   maxPrincipal                 absolute or (state, opts) => number
//   downPaymentRatio             fraction required upfront (0..1)
//   collateral                   'none' | 'tile' | 'portfolio' (informational)
//   seizureRule                  'none' | 'fixed' | 'bestFirst' (how foreclosure picks tiles)
//   paymentPriority              integer; lower = paid first when monthly payments are charged
//   strikesUntilForeclosure      missed payments before default trigger
//   defaultBehavior              'discharge' | 'foreclose'
//   cooldownMonths               (only for 'discharge') months before borrower can re-apply
//   eligibility(state, opts)     predicate → { ok, reason? }
//   showInBankMenu               when false, product is only offered from contextual flows
//                                (e.g. landFinance via the tile-purchase UI). Default true.

export const LOAN_PRODUCTS = {
  // === LAND MORTGAGE — secured by ONE tile, lowest rate ===========================
  landFinance: {
    id: 'landFinance',
    name: 'Land Mortgage',
    annualRate: 0.07,
    termMonths: 60,
    minPrincipal: 1000,
    step: 1000,
    maxPrincipal: 100000,
    collateral: 'tile',
    seizureRule: 'fixed',
    paymentPriority: 1,
    downPaymentRatio: 0.30,
    strikesUntilForeclosure: 3,
    defaultBehavior: 'foreclose',
    showInBankMenu: false,           // offered from the tile-purchase UI instead
    description: [
      'Hipoteca de terreno — Land Mortgage',
      '',
      'Loan to buy ONE specific tile. The tile itself is the collateral.',
      '• Lowest rate (7% APR) — best collateral for the bank.',
      '• 30% down payment required upfront.',
      '• Term: 60 months.',
      '• Max 1 mortgage per tile.',
      '',
      'On default: bank seizes ONLY this tile and sells at 70–80% of market.',
      'Sale waterfall: pay off this loan; surplus → your cash; shortfall → bank loss.',
    ].join('\n'),
    eligibility: (state, opts = {}) => {
      if (opts.collateralTileId == null) return { ok: false, reason: 'Tile required' };
      const existing = (state.loans ?? []).filter(
        l => l.productId === 'landFinance' && l.balance > 0
          && (l.collateralTileIds ?? []).includes(opts.collateralTileId),
      );
      if (existing.length > 0) return { ok: false, reason: 'Tile already mortgaged' };
      return { ok: true };
    },
  },

  // === GENERAL MORTGAGE — secured by portfolio, mid rate ==========================
  mortgage: {
    id: 'mortgage',
    name: 'General Mortgage',
    annualRate: 0.11,
    termMonths: 120,
    minPrincipal: 5000,
    step: 1000,
    maxPrincipal: (state, opts = {}) => {
      const borrowerId = opts.borrowerId ?? 'player';
      const tiles = ownedTilesAcrossMaps(state, borrowerId);
      const equity = tiles.reduce((s, t) => s + 3000 + t.quality * 1500, 0);
      const debt = (state.loans ?? [])
        .filter(l => l.borrowerId === borrowerId && !l.foreclosed && l.balance > 0)
        .reduce((s, l) => s + l.balance, 0);
      return Math.max(5000, Math.floor(equity * 0.6 - debt));
    },
    collateral: 'portfolio',
    seizureRule: 'bestFirst',
    paymentPriority: 2,
    downPaymentRatio: 0,
    strikesUntilForeclosure: 4,
    defaultBehavior: 'foreclose',
    description: [
      'Hipoteca general — General Mortgage',
      '',
      'Lump-sum loan backed by your entire farm portfolio.',
      '• Rate: 11% APR — between Land Mortgage and Working Capital.',
      '• Cap: equity × 60% − existing debt.',
      '• Term: 120 months. Requires 2+ owned tiles.',
      '',
      'On default: bank seizes tiles (best first) and sells each at 70–80% of market.',
      'Waterfall per tile: any active Land Mortgage on that tile gets paid FIRST,',
      'then the General Mortgage takes the residual. Process continues until covered.',
    ].join('\n'),
    eligibility: (state, opts = {}) => {
      const borrowerId = opts.borrowerId ?? 'player';
      const tiles = ownedTilesAcrossMaps(state, borrowerId).length;
      if (tiles < 2) return { ok: false, reason: 'Need 2+ owned tiles' };
      return { ok: true };
    },
  },

  // === WORKING CAPITAL — harvest-backed, highest rate, no land seizure =============
  workingCapital: {
    id: 'workingCapital',
    name: 'Working Capital',
    annualRate: 0.22,
    termMonths: 12,
    minPrincipal: 400,
    step: 400,
    maxPrincipal: (state, opts = {}) => {
      const borrowerId = opts.borrowerId ?? 'player';
      const tiles = ownedTilesAcrossMaps(state, borrowerId).length;
      const wcLoans = (state.loans ?? []).filter(
        l => l.borrowerId === borrowerId && l.productId === 'workingCapital'
          && l.balance > 0 && !l.foreclosed,
      );
      const remainingSlots = Math.max(0, tiles - wcLoans.length);
      return remainingSlots * 800;
    },
    collateral: 'none',
    seizureRule: 'none',
    paymentPriority: 0,                 // paid FIRST when cash is short
    downPaymentRatio: 0,
    strikesUntilForeclosure: 3,
    defaultBehavior: 'discharge',
    cooldownMonths: 12,
    description: [
      'Crédito de avío — Working Capital',
      '',
      'Operating cash for the year. Backed by your future harvest, not by land.',
      '• Highest rate (22% APR) — bank takes the most risk.',
      '• Cap: $800/year × tiles owned. Each WC consumes 1 slot per tile.',
      '• Term: 12 months.',
      '• Priority: this is paid BEFORE mortgages each month.',
      '',
      'On default: bank writes off the loss (no land seized).',
      'You cannot take a new Working Capital for 12 months after a default.',
    ].join('\n'),
    eligibility: (state, opts = {}) => {
      const borrowerId = opts.borrowerId ?? 'player';
      const tiles = ownedTilesAcrossMaps(state, borrowerId).length;
      if (tiles < 1) return { ok: false, reason: 'Need at least 1 owned tile' };
      if (borrowerId === 'player') {
        const cooldownDay = state.player.wcCooldownUntilDay ?? 0;
        if (cooldownDay > state.time.totalDays) {
          const days = cooldownDay - state.time.totalDays;
          return { ok: false, reason: `WC cooldown — ${days}d remaining` };
        }
      }
      const wcLoans = (state.loans ?? []).filter(
        l => l.borrowerId === borrowerId && l.productId === 'workingCapital'
          && l.balance > 0 && !l.foreclosed,
      );
      if (wcLoans.length >= tiles) return { ok: false, reason: 'All WC slots used (1 per tile)' };
      return { ok: true };
    },
  },
};

export const LOAN_PRODUCT_LIST = Object.values(LOAN_PRODUCTS);

export function resolveMaxPrincipal(product, state, opts = {}) {
  return typeof product.maxPrincipal === 'function'
    ? product.maxPrincipal(state, opts)
    : product.maxPrincipal;
}

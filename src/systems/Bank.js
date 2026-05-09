import { LOAN_PRODUCTS, LOAN_PRODUCT_LIST, resolveMaxPrincipal } from '../data/loanProducts.js';
import { FORECLOSURE, TIME } from '../data/tunables.js';
import { tilePrice, pushLog, pushFx } from '../state/GameState.js';

// =============================================================================
// Pure helpers
// =============================================================================

export function getProduct(productId) {
  return LOAN_PRODUCTS[productId];
}

export function eligibleProducts(state, opts = {}) {
  return LOAN_PRODUCT_LIST.filter(p => p.eligibility(state, opts).ok);
}

function computeMonthlyPayment(principal, annualRate, termMonths) {
  const r = annualRate / 12;
  if (r === 0) return principal / termMonths;
  return (principal * r) / (1 - Math.pow(1 + r, -termMonths));
}

export function quoteLoan(state, productId, principal, opts = {}) {
  const product = LOAN_PRODUCTS[productId];
  if (!product) return null;
  const max = resolveMaxPrincipal(product, state, opts);
  const safe = Math.max(product.minPrincipal, Math.min(principal, max));
  const downPayment = Math.round(safe * (product.downPaymentRatio ?? 0));
  const financed = safe - downPayment;
  const monthlyPayment = computeMonthlyPayment(financed, product.annualRate, product.termMonths);
  return {
    productId,
    productName: product.name,
    principal: safe,
    downPayment,
    financed,
    monthlyPayment,
    totalInterest: monthlyPayment * product.termMonths - financed,
    rate: product.annualRate,
    termMonths: product.termMonths,
    maxPrincipal: max,
    minPrincipal: product.minPrincipal,
  };
}

export function walletFor(state, borrowerId) {
  if (borrowerId === 'player') return state.player;
  return state.aiFarmers?.find(a => a.id === borrowerId) ?? null;
}

// =============================================================================
// Loan creation
// =============================================================================

export function applyForLoan(state, productId, principal, opts = {}) {
  const product = LOAN_PRODUCTS[productId];
  if (!product) return { ok: false, reason: 'Unknown product' };
  const elig = product.eligibility(state, opts);
  if (!elig.ok) return { ok: false, reason: elig.reason };
  const quote = quoteLoan(state, productId, principal, opts);
  if (!quote) return { ok: false, reason: 'Cannot price loan' };

  const borrowerId = opts.borrowerId ?? 'player';
  const wallet = walletFor(state, borrowerId);
  if (!wallet) return { ok: false, reason: 'Borrower not found' };
  if (wallet.cash < quote.downPayment) return { ok: false, reason: 'Not enough cash for down payment' };

  wallet.cash -= quote.downPayment;
  wallet.cash += quote.financed;

  const collateralTileIds = opts.collateralTileId != null ? [opts.collateralTileId] : [];

  const loan = {
    id: `loan_${state.loans.length + 1}_${state.time.totalDays}`,
    borrowerId,
    productId,
    principal: quote.principal,
    balance: quote.financed,
    rate: product.annualRate,
    termMonths: product.termMonths,
    monthsRemaining: product.termMonths,
    monthlyPayment: quote.monthlyPayment,
    collateralTileIds,
    missedPayments: 0,
    strikesUntilForeclosure: product.strikesUntilForeclosure,
    paymentPriority: product.paymentPriority ?? 99,
    foreclosed: false,
  };
  state.loans.push(loan);
  if (borrowerId === 'player') {
    pushLog(state, `Loan: ${product.name} +$${quote.financed} (cuota $${Math.round(quote.monthlyPayment)})`);
    pushFx(state, {
      type: 'coins',
      from: 'bank',
      to: 'cash',
      count: 6,
      value: quote.financed,
      color: 0xffd166,
    });
  }
  return { ok: true, loan };
}

// =============================================================================
// Monthly tick — charge in priority order, then trigger defaults
// =============================================================================

export function tickLoans(state) {
  // Group by borrower so each borrower's WC is paid before its mortgages.
  const byBorrower = new Map();
  for (const loan of state.loans) {
    if (loan.foreclosed || loan.balance <= 0) continue;
    if (!byBorrower.has(loan.borrowerId)) byBorrower.set(loan.borrowerId, []);
    byBorrower.get(loan.borrowerId).push(loan);
  }

  for (const [borrowerId, loans] of byBorrower) {
    const wallet = walletFor(state, borrowerId);
    if (!wallet) continue;
    loans.sort((a, b) => a.paymentPriority - b.paymentPriority);
    for (const loan of loans) chargeOneLoan(state, wallet, loan);
  }

  // Process foreclosures triggered this month
  const toForeclose = state.loans.filter(
    l => !l.foreclosed && l.missedPayments >= l.strikesUntilForeclosure,
  );
  for (const loan of toForeclose) handleDefault(state, loan);

  // Bankruptcy check (player only)
  const playerTiles = state.maps.home.tiles.filter(t => t.owner === 'player').length;
  const playerDebt = state.loans
    .filter(l => l.borrowerId === 'player' && !l.foreclosed && l.balance > 0).length;
  if (playerTiles === 0 && playerDebt > 0) {
    state.player.bankrupt = true;
    pushLog(state, 'BANKRUPT — no land remaining and active debt.');
  }

  // Drop fully-resolved loans (paid off OR foreclosed and discharged)
  state.loans = state.loans.filter(l => l.balance > 0 && !l.foreclosed);
}

function chargeOneLoan(state, wallet, loan) {
  const interest = loan.balance * (loan.rate / 12);
  const totalDue = Math.min(loan.monthlyPayment, loan.balance + interest);

  if (wallet.cash >= totalDue) {
    wallet.cash -= totalDue;
    loan.balance = Math.max(0, loan.balance - (totalDue - interest));
    loan.monthsRemaining = Math.max(0, loan.monthsRemaining - 1);
    loan.missedPayments = 0;
    if (loan.borrowerId === 'player') {
      pushFx(state, {
        type: 'coins',
        from: 'cash',
        to: 'bank',
        count: 4,
        value: Math.round(totalDue),
        color: 0xff7a7a,
      });
    }
  } else {
    loan.missedPayments += 1;
    loan.balance += interest;
    if (loan.borrowerId === 'player') {
      const def = LOAN_PRODUCTS[loan.productId];
      pushLog(state, `MISSED ${def.name} (${loan.missedPayments}/${loan.strikesUntilForeclosure})`);
    }
  }
}

// =============================================================================
// Default handling — dispatch by product.defaultBehavior
// =============================================================================

function handleDefault(state, loan) {
  const product = LOAN_PRODUCTS[loan.productId];
  if (product.defaultBehavior === 'discharge') {
    // No collateral. Bank writes off; borrower gets a cooldown.
    loan.balance = 0;
    loan.foreclosed = true;
    if (loan.borrowerId === 'player') {
      const months = product.cooldownMonths ?? 12;
      const cooldownDays = months * TIME.daysPerMonth;
      state.player.wcCooldownUntilDay = state.time.totalDays + cooldownDays;
      pushLog(state, `${product.name} written off. Cooldown ${months}mo.`);
    }
    return;
  }
  if (product.defaultBehavior === 'foreclose') {
    seizeAndSettle(state, loan);
    return;
  }
}

// =============================================================================
// Foreclosure with sale waterfall
// =============================================================================

function pickTileToSeize(state, loan) {
  const product = LOAN_PRODUCTS[loan.productId];

  if (product.seizureRule === 'fixed') {
    const id = (loan.collateralTileIds ?? [])[0];
    const tile = id != null ? state.maps.home.tiles[id] : null;
    return (tile && tile.owner === loan.borrowerId) ? tile : null;
  }

  if (product.seizureRule === 'bestFirst') {
    // Prefer best (most valuable) tile owned by borrower that isn't already seized this round.
    const candidates = state.maps.home.tiles
      .filter(t => t.owner === loan.borrowerId)
      .sort((a, b) => tilePrice(b, state) - tilePrice(a, state));
    return candidates[0] ?? null;
  }

  return null;
}

function seizeAndSettle(state, loan) {
  // Process iteratively for portfolio loans; once for fixed (one tile only).
  let safety = 0;
  const isPortfolio = LOAN_PRODUCTS[loan.productId].seizureRule === 'bestFirst';

  while (loan.balance > 0 && safety++ < 50) {
    const tile = pickTileToSeize(state, loan);
    if (!tile) break;

    // Sale price: random 70–80% of market value at the time of seizure.
    const market = tilePrice(tile, state);
    const pct = FORECLOSURE.saleMin + Math.random() * (FORECLOSURE.saleMax - FORECLOSURE.saleMin);
    let proceeds = Math.round(market * pct);

    // Waterfall: senior land mortgages on this tile get paid first.
    const senior = state.loans.filter(
      l => l !== loan && !l.foreclosed && l.balance > 0
        && l.productId === 'landFinance'
        && (l.collateralTileIds ?? []).includes(tile.id),
    );
    for (const sLoan of senior) {
      const pay = Math.min(sLoan.balance, proceeds);
      sLoan.balance -= pay;
      proceeds -= pay;
      if (sLoan.borrowerId === 'player') {
        pushLog(state, `Tile (${tile.x},${tile.y}) sale → $${pay} to ${LOAN_PRODUCTS[sLoan.productId].name}`);
      }
      if (sLoan.balance <= 0.5) sLoan.foreclosed = true;  // discharged in full
    }

    // Remainder applies to the foreclosing loan.
    const toThis = Math.min(loan.balance, proceeds);
    loan.balance -= toThis;
    proceeds -= toThis;

    // Surplus (rare with 70–80%, common after senior payoff) goes to the borrower.
    if (proceeds > 0) {
      const wallet = walletFor(state, loan.borrowerId);
      if (wallet) wallet.cash += proceeds;
      if (loan.borrowerId === 'player') {
        pushLog(state, `Tile (${tile.x},${tile.y}) seized $${market} sold $${market * pct | 0} → $${proceeds} surplus to you`);
      }
    } else if (loan.borrowerId === 'player') {
      pushLog(state, `Tile (${tile.x},${tile.y}) seized $${market} sold $${Math.round(market * pct)} → $${toThis} to ${LOAN_PRODUCTS[loan.productId].name}`);
    }

    // Tile reverts to wild
    tile.owner = 'wild';
    tile.state = 'fallow';
    tile.crop = null;
    tile.growth = 0;

    if (loan.borrowerId === 'player') {
      pushFx(state, { type: 'sfx', kind: 'foreclose' });
      pushFx(state, { type: 'bounceTile', tileId: tile.id, scale: 1.4 });
    }

    if (!isPortfolio) break;  // fixed rule: only one tile
  }

  // Discharge any unpaid balance — bank eats the loss
  if (loan.balance > 0 && loan.borrowerId === 'player') {
    pushLog(state, `${LOAN_PRODUCTS[loan.productId].name} shortfall $${Math.round(loan.balance)} written off.`);
  }
  loan.balance = 0;
  loan.foreclosed = true;
}

// =============================================================================
// Selectors used by HUD / UI
// =============================================================================

export function totalDebt(state, borrowerId = 'player') {
  return state.loans
    .filter(l => l.borrowerId === borrowerId && !l.foreclosed && l.balance > 0)
    .reduce((s, l) => s + l.balance, 0);
}

export function totalMonthlyPayment(state, borrowerId = 'player') {
  return state.loans
    .filter(l => l.borrowerId === borrowerId && !l.foreclosed && l.balance > 0)
    .reduce((s, l) => s + l.monthlyPayment, 0);
}

export function loansOf(state, borrowerId = 'player') {
  return state.loans.filter(l => l.borrowerId === borrowerId && !l.foreclosed && l.balance > 0);
}

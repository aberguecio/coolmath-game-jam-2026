// Per-country tax brackets. Each country in countries.js references one of these via `taxRatesId`.
// Adding a new bracket = one entry. Three categories of tax exist:
//   sale   — retail tax: population buying food / final goods.
//   b2b    — company-to-company tax: industries buying inputs, etc.
//   import — extra tax when goods cross the border into this country (stacks on source's sale).
//
// Crisis logic in tickFiscalCrisis adds a per-month bump on top of these baselines.

export const TAX_RATES = {
  default:      { sale: 0.10, b2b: 0.05, import: 0.07 },
  homeRates:    { sale: 0.08, b2b: 0.04, import: 0.05 },
  usaRates:     { sale: 0.10, b2b: 0.05, import: 0.07 },
  chinaRates:   { sale: 0.12, b2b: 0.06, import: 0.10 },
  brazilRates:  { sale: 0.15, b2b: 0.06, import: 0.06 },
  germanyRates: { sale: 0.20, b2b: 0.08, import: 0.05 },
};

export function getTaxRates(state, countryId) {
  const reg = state.countries?.[countryId];
  const id = reg?.taxRatesId ?? 'default';
  return TAX_RATES[id] ?? TAX_RATES.default;
}

// Effective rate including crisis bump. Returns plain object { sale, b2b, import }.
export function effectiveTaxRates(state, countryId) {
  const base = getTaxRates(state, countryId);
  const crisis = state.countries?.[countryId]?.fiscalCrisis;
  if (!crisis || !crisis.active) return { ...base };
  const bump = crisis.taxBump ?? 0;
  const cap = 2.0;
  return {
    sale:   Math.min(base.sale   * cap, base.sale   + bump),
    b2b:    Math.min(base.b2b    * cap, base.b2b    + bump),
    import: Math.min(base.import * cap, base.import + bump),
  };
}

// Compatibility shim — Economy.js was the old random-walk price model.
// The active engine is Market.js (stock/flow with country agents).
// Keep these re-exports so existing imports keep working.

export {
  marketParam,
  sellToMarket as sellCrop,
  sellToMarket,
  priceOf,
  priceTrend,
  initMarket,
  tickMarket as tickPrices,
} from './Market.js';

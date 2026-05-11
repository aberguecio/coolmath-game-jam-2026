// Tile offers — AI ↔ player buy/sell negotiation.
//
// Each tile holds at most one pending offer at a time:
//   tile.pendingOffer = {
//     fromId,            who wants to buy ('player' or 'aiX')
//     amount,            $ proposed
//     marketAtOffer,     market value at the time the offer was made (for delta UI)
//     expiresOnDay,      totalDays after which the offer auto-rejects
//     iteration,         how many times it's been countered (for UI)
//   }
//
// The current owner of the tile responds: accept, reject, or counter.

import { OFFERS } from '../data/tunables.js';
import { tilePrice, pushLog, pushFx } from '../state/GameState.js';
import { walletFor } from './Bank.js';

function rand(min, max) { return min + Math.random() * (max - min); }

// Probability AI accepts a counter on its own outstanding offer.
// markup is the fractional increase the player demanded over AI's last offer.
export function counterAcceptProbability(markup) {
  return Math.max(0, Math.min(1, OFFERS.baseCounterAccept - markup));
}

// Probability AI accepts a player's purchase offer on the AI's tile.
// markup is the fractional difference between offer and current market.
export function buyAcceptProbability(markup) {
  if (markup < OFFERS.buyMinMarkup) return 0;
  const span = OFFERS.buyAlwaysMarkup - OFFERS.buyMinMarkup;
  const ramp = (markup - OFFERS.buyMinMarkup) / span;
  return Math.max(0, Math.min(1, OFFERS.buyBaseAccept + ramp * (1 - OFFERS.buyBaseAccept)));
}

// Suggested starting offer for the player when initiating a purchase.
export function buyStartingAmount(tile, state) {
  return Math.round(tilePrice(tile, state) * (1 + OFFERS.buyMinMarkup));
}

// AI rolls an offer on a random player tile. Called from tickAI.
// Only same-country AIs offer to the player (player only owns home tiles).
export function aiTryOffer(state, ai) {
  if (Math.random() > OFFERS.aiOfferChancePerDay) return;
  if (ai.countryId !== 'home') return;
  const playerTiles = state.maps.home.tiles.filter(t => t.owner === 'player' && !t.pendingOffer);
  if (playerTiles.length === 0) return;
  const tile = playerTiles[Math.floor(Math.random() * playerTiles.length)];
  const market = tilePrice(tile, state);
  const mult = rand(OFFERS.aiOfferRange.min, OFFERS.aiOfferRange.max);
  const amount = Math.max(500, Math.round(market * mult));
  if (ai.cash < amount) return;
  tile.pendingOffer = {
    fromId: ai.id,
    amount,
    marketAtOffer: market,
    expiresOnDay: state.time.totalDays + OFFERS.expirationDays,
    iteration: 0,
  };
  pushLog(state, `${ai.name} offers $${amount} for tile (${tile.x},${tile.y})`);
  pushFx(state, { type: 'sfx', kind: 'offerIn' });
  pushFx(state, { type: 'bounceTile', tileId: tile.id, scale: 1.18 });
  pushFx(state, {
    type: 'popText', atTile: tile.id, text: `OFFER $${amount}`,
    color: '#6ee7b7', duration: 2400, rise: 30, fontSize: 12,
  });
}

// Daily housekeeping: expire stale offers across all maps.
export function tickOffers(state) {
  for (const cid of Object.keys(state.maps || {})) {
    for (const tile of state.maps[cid].tiles) {
      if (!tile.pendingOffer) continue;
      if (tile.pendingOffer.expiresOnDay <= state.time.totalDays) {
        tile.pendingOffer = null;
      }
    }
  }
}

// === Player accepts AI's offer on a player-owned tile =========================
export function acceptOffer(state, tile) {
  const offer = tile.pendingOffer;
  if (!offer) return { ok: false, reason: 'No offer' };
  return settleTransfer(state, tile, offer.fromId, 'player', offer.amount);
}

// === Player rejects an offer outright ========================================
export function rejectOffer(state, tile) {
  const offer = tile.pendingOffer;
  if (!offer) return { ok: false, reason: 'No offer' };
  pushLog(state, `Rejected offer for (${tile.x},${tile.y})`);
  tile.pendingOffer = null;
  return { ok: true };
}

// === Player counters an AI's offer ==========================================
// newAmount is the price the player is now asking. AI accepts probabilistically.
export function counterOffer(state, tile, newAmount) {
  const offer = tile.pendingOffer;
  if (!offer) return { ok: false, reason: 'No offer' };
  if (newAmount < offer.amount) return { ok: false, reason: 'Counter must exceed original' };
  const markup = (newAmount - offer.amount) / offer.amount;
  const prob = counterAcceptProbability(markup);
  const accepted = Math.random() < prob;
  const ai = state.aiFarmers.find(a => a.id === offer.fromId);
  const aiName = ai?.name ?? offer.fromId;
  if (accepted) {
    if (ai && ai.cash < newAmount) {
      tile.pendingOffer = null;
      pushLog(state, `${aiName} would pay but cannot afford counter — offer cancelled.`);
      return { ok: false, reason: 'AI cannot afford' };
    }
    pushLog(state, `${aiName} accepted counter $${newAmount}`);
    return settleTransfer(state, tile, offer.fromId, 'player', newAmount);
  }
  pushLog(state, `${aiName} rejected counter $${newAmount} (${(prob * 100).toFixed(0)}% odds)`);
  pushFx(state, { type: 'sfx', kind: 'reject' });
  pushFx(state, {
    type: 'popText', atTile: tile.id, text: 'Rejected', color: '#ff7a7a',
    duration: 1800, rise: 24, fontSize: 13,
  });
  tile.pendingOffer = null;
  return { ok: false, reason: 'Counter rejected' };
}

// === Player offers to buy an AI tile ========================================
export function makePurchaseOffer(state, tile, amount) {
  if (tile.owner === 'player' || tile.owner === 'wild') {
    return { ok: false, reason: 'Not an AI tile' };
  }
  const market = tilePrice(tile, state);
  const markup = (amount - market) / market;
  if (markup < OFFERS.buyMinMarkup - 1e-9) {
    return { ok: false, reason: `Must offer at least +${(OFFERS.buyMinMarkup * 100).toFixed(0)}% over market` };
  }
  if (state.player.cash < amount) return { ok: false, reason: 'Not enough cash' };
  const prob = buyAcceptProbability(markup);
  const accepted = Math.random() < prob;
  const ai = state.aiFarmers.find(a => a.id === tile.owner);
  const aiName = ai?.name ?? tile.owner;
  if (accepted) {
    pushLog(state, `${aiName} accepted your $${amount} offer for (${tile.x},${tile.y})`);
    pushFx(state, { type: 'sfx', kind: 'chime' });
    pushFx(state, {
      type: 'popText', atTile: tile.id, text: 'SOLD!', color: '#6ee7b7',
      duration: 2200, rise: 28, fontSize: 14,
    });
    return settleTransfer(state, tile, 'player', tile.owner, amount);
  }
  pushLog(state, `${aiName} rejected your $${amount} offer (${(prob * 100).toFixed(0)}% odds)`);
  pushFx(state, { type: 'sfx', kind: 'reject' });
  pushFx(state, {
    type: 'popText', atTile: tile.id, text: 'Rejected', color: '#ff7a7a',
    duration: 1800, rise: 24, fontSize: 13,
  });
  return { ok: false, reason: 'Rejected' };
}

// === Settlement: transfers cash and ownership ===============================
function settleTransfer(state, tile, buyerId, sellerId, amount) {
  const buyer = walletFor(state, buyerId);
  const seller = walletFor(state, sellerId);
  if (!buyer || !seller) return { ok: false, reason: 'Wallet missing' };
  if (buyer.cash < amount) return { ok: false, reason: 'Buyer cannot pay' };

  buyer.cash -= amount;
  seller.cash += amount;
  tile.owner = buyerId;
  tile.pendingOffer = null;
  // Industry on the tile transfers with the land — otherwise the prior owner
  // keeps collecting output revenue from a factory they no longer own.
  if (tile.industryId) {
    const ind = state.industries?.find(i => i.id === tile.industryId);
    if (ind) ind.ownerId = buyerId;
  }

  pushLog(state, `Tile (${tile.x},${tile.y}) sold for $${amount}`);
  // Coin trail follows the cash, from buyer's wallet to seller's wallet.
  if (buyerId === 'player') {
    pushFx(state, {
      type: 'coins', from: 'cash', to: { tileId: tile.id },
      count: 6, value: amount, color: 0xff7a7a,
    });
  } else if (sellerId === 'player') {
    pushFx(state, {
      type: 'coins', from: { tileId: tile.id }, to: 'cash',
      count: 6, value: amount, color: 0xffd166,
    });
  }
  pushFx(state, { type: 'bounceTile', tileId: tile.id, scale: 1.3 });
  return { ok: true, amount };
}

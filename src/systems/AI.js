import { AI } from '../data/tunables.js';
import { aiTryOffer, tickOffers } from './Trade.js';
import { aiTrySellInventory } from './AISales.js';
import { observeForActor } from '../agent/Observation.js';
import { decideFor } from '../agent/Brains.js';
import * as Actions from '../agent/Actions.js';

// Generate AI farmers for ONE country. Each farmer claims tiles in that country's map.
// AI ids are country-prefixed to avoid clashes across maps (e.g. `home_ai0`, `usa_ai0`).
export function createAIFarmersForCountry(state, countryId) {
  const farmers = [];
  const map = state.maps[countryId];
  if (!map) return farmers;
  const taken = new Set(
    map.tiles.filter(t => t.owner !== 'wild').map(t => t.id),
  );
  const candidateOrder = map.tiles
    .filter(t => t.owner === 'wild')
    .map(t => t.id)
    .sort((a, b) => {
      const ta = map.tiles[a];
      const tb = map.tiles[b];
      const distA = ta.x + ta.y;
      const distB = tb.x + tb.y;
      return (tb.quality + distB / 30) - (ta.quality + distA / 30);
    });

  let pick = 0;
  for (let i = 0; i < AI.count; i++) {
    const id = `${countryId}_ai${i}`;
    const owned = [];
    for (let j = 0; j < AI.startTilesPerAI; j++) {
      while (pick < candidateOrder.length && taken.has(candidateOrder[pick])) pick++;
      if (pick < candidateOrder.length) {
        const tid = candidateOrder[pick++];
        taken.add(tid);
        owned.push(tid);
        map.tiles[tid].owner = id;
      }
    }
    farmers.push({
      id,
      countryId,
      name: AI.names[i] || `AI ${i + 1}`,
      color: AI.colors[i % AI.colors.length],
      cash: AI.startCash,
      ownedTileIds: owned,
      cooldown: i * 2,
      // Per-country inventory. AI farmers only ever transact in their home
      // country, but the schema mirrors the player so every wallet shares one
      // code path (SRP for inventory access — see inventoryFor in Market.js).
      inventoryByCountry: { [countryId]: {} },
      // Fracción del inventario que el AI conserva en su wallet en vez de
      // listar al mercado. Default 0 = lista todo. Hook para personalidades
      // futuras: 'hoarder' podría tener 0.5, 'trader' cero, 'small-scale' 0.2.
      keepFraction: 0,
      // Brain pluggable. Default 'heuristic' replica la lógica histórica.
      // Otras opciones del registry (Brains.js): 'idle' (no hace nada).
      // Futuras personalidades se agregan al registry sin tocar el motor.
      brainType: 'heuristic',
      brainParams: {},   // config por-personalidad (risk tolerance, etc.)
      brainMemory: {},   // state persistente que el brain puede usar entre ticks
    });
  }
  return farmers;
}

// tickAI — itera cada AI farmer y delega la decisión a su brain (registrado en
// src/agent/Brains.js). El brain es una función pura (obs, actor) → actions[]
// que el motor aplica por el rail único de Actions.apply().
//
// Cooldown: cada `ai.cooldown <= 0` el AI piensa; reset a AI.decisionEveryDays.
// Trade.aiTryOffer e tickOffers se mantienen daily (decisión de oferta no pasa
// por brain por ahora — futura iteración puede mudarlas).
export function tickAI(state) {
  // Daily: AI puede tirar una oferta sobre un tile del player (decisión simple,
  // no pasa por el brain todavía).
  for (const ai of state.aiFarmers) aiTryOffer(state, ai);
  tickOffers(state);

  for (const ai of state.aiFarmers) {
    ai.cooldown -= 1;
    if (ai.cooldown > 0) continue;
    ai.cooldown = AI.decisionEveryDays;
    const obs = observeForActor(state, ai.id);
    const decide = decideFor(ai.brainType);
    const actions = decide(obs, ai);
    for (const a of actions) {
      Actions.apply(state, { ...a, ownerId: ai.id });
    }
    // Sync ownedTileIds contra ownership real (en caso de foreclosure que
    // cambia tile.owner sin pasar por el rail).
    const map = state.maps[ai.countryId];
    if (map) ai.ownedTileIds = map.tiles.filter(t => t.owner === ai.id).map(t => t.id);
  }
}

// Weekly hook: drip-sell harvested inventory. Run cada 7 días para que la
// góndola se reabastezca con más frecuencia (antes era mensual).
export function tickAIWeekly(state) {
  for (const ai of state.aiFarmers) {
    aiTrySellInventory(state, ai);       // drip-sell harvested crops
  }
}

// Monthly hook — kept as a no-op shell for future re-introduction.
export function tickAIMonthly(_state) {
}

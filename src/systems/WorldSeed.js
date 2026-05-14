// WorldSeed — boot inicial de producción agraria. 1 tile por crop, AI farmers
// round-robin. Idempotente contra HMR / re-init.

import { PRODUCIBLES } from '../data/producibles.js';
import { COUNTRY_IDS } from '../data/countries.js';

function pickWildTile(map) {
  for (const t of map.tiles) {
    if (t.owner === 'wild') return t;
  }
  return null;
}

export function seedStarterCrops(state) {
  if (state.starterSeeded) return;
  state.starterSeeded = true;
  for (const cid of COUNTRY_IDS) {
    const ais = state.aiFarmers.filter(a => a.countryId === cid);
    if (ais.length === 0) continue;
    let aiIdx = 0;
    const nextAi = () => ais[(aiIdx++) % ais.length];

    for (const def of Object.values(PRODUCIBLES)) {
      const tile = pickWildTile(state.maps[cid]);
      if (!tile) continue;

      const owner = nextAi();
      tile.owner = owner.id;
      tile.crop = def.id;
      tile.plantedDay = state.time.totalDays;
      tile.ageDays = 0;
      tile.lockType = 'crop';

      if (def.perennial) {
        tile.state = 'cosechado';
        tile.growth = 0;
        const regrow = def.perennial.regrowDays;
        tile.lastHarvestDay = state.time.totalDays - Math.floor(regrow * 0.7);
      } else {
        tile.state = 'planted';
        tile.growth = 0.5;
        tile.plantedDay = state.time.totalDays - Math.floor(def.growthDays / 2);
      }

      if (!owner.ownedTileIds.includes(tile.id)) owner.ownedTileIds.push(tile.id);
    }
  }
}

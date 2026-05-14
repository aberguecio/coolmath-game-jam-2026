// WorldSeed — generates day-zero starter production. Cada país arranca con
// agricultura activa (1 tile por crop, AI farmers round-robin) y exporters
// listos para tradear. Minas e industrias YA NO se siembran — deben
// construirse durante el juego. Los depósitos minerales en tiles wild siguen
// generándose en `generateMineralDeposits` (Mining.js) para que sean
// descubribles. Idempotente contra HMR / re-init.

import { PRODUCIBLES } from '../data/producibles.js';
import { COUNTRY_IDS } from '../data/countries.js';
import { EXPORTERS } from '../data/tunables.js';
import { seedExportersFor } from './Exporters.js';

function pickWildTileNot(map, predicate) {
  for (const t of map.tiles) {
    if (t.owner !== 'wild') continue;
    if (!predicate || predicate(t)) return t;
  }
  return null;
}

// Internal: hace el trabajo real. Se expone públicamente vía seedIndustries
// abajo (único nombre que los callers usan).
function seedStarterProduction(state) {
  if (state.starterSeeded) return;
  state.starterSeeded = true;
  for (const cid of COUNTRY_IDS) {
    const ais = state.aiFarmers.filter(a => a.countryId === cid);
    if (ais.length === 0) continue;
    let aiIdx = 0;
    const nextAi = () => ais[(aiIdx++) % ais.length];

    // === 1. Tile-grown producibles: 1 tile per CROP (food backbone). ===
    // Las mineras (`category === 'mining'`) y las industrias (sección 2) ya
    // NO se siembran al inicio — el juego arranca con sólo agricultura activa.
    // Los depósitos minerales en tiles wild SIGUEN generándose en
    // `generateMineralDeposits` (Mining.js), así que el player/AI puede
    // descubrirlos y armar minas durante el juego, pero al día 0 no hay
    // producción de minerales ni outputs industriales.
    for (const def of Object.values(PRODUCIBLES)) {
      if (def.category === 'processed') continue;
      if (def.category === 'mining') continue;

      const tile = pickWildTileNot(state.maps[cid], () => true);
      if (!tile) continue;

      const owner = nextAi();
      tile.owner = owner.id;
      tile.crop = def.id;
      tile.plantedDay = state.time.totalDays;
      tile.ageDays = 0;

      if (def.perennial) {
        tile.state = 'cosechado';
        tile.growth = 0;
        const regrow = def.perennial.regrowDays;
        tile.lastHarvestDay = state.time.totalDays - Math.floor(regrow * 0.7);
        tile.lockType = 'crop';
      } else {
        tile.state = 'planted';
        tile.growth = 0.5;
        tile.plantedDay = state.time.totalDays - Math.floor(def.growthDays / 2);
        tile.lockType = 'crop';
      }

      if (!owner.ownedTileIds.includes(tile.id)) owner.ownedTileIds.push(tile.id);
    }

    // === 2. Industrias seeded — DESACTIVADO ===
    // El juego ya no arranca con factorías operacionales. Las industrias deben
    // construirse durante el juego (AI vía aiTryBuildIndustry, player vía UI).

    // === 3. Seed AI exporters for this town (Sprint C) ===
    seedExportersFor(state, cid, EXPORTERS.perTownCount);
  }
}

// Backwards-callable name used historically.
export function seedIndustries(state) { return seedStarterProduction(state); }

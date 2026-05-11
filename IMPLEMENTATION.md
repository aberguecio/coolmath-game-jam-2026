# Plan de implementación — Sprints A / B / C

> Detalle por sprint, archivo por archivo, con módulos nuevos, signatures, y notas SOLID. Cada sprint es shippable por separado. Orden recomendado: A → B → C (ver `TODO.md` "Roadmap" para justificación de orden).

---

## Principios transversales

**SRP (single responsibility)**: cada módulo nuevo tiene un solo motivo de cambio. Ej. `Labor.js` cambia si cambia la economía laboral; nunca si cambia la fórmula de precios.

**OCP (open/closed)**: añadir un producible, industry, o exportadora nueva = una entrada en registry. Cero cambios en lógica.

**DIP (dependency inversion)**: los módulos de costos importan **getters abstractos** (`wageRateFor`, `priceIndexFor`), no los detalles internos del EMA. Quien cambie la fórmula del EMA toca un solo archivo.

**ISP (interface segregation)**: cada export es un verbo mínimo (`tickX`, `xFor`). Sin "god functions" que hagan 5 cosas.

**LSP (substitution)**: ventures (crops, mining, industry) cumplen el mismo contrato implícito → setupCost, productionCost, status machine. Cualquier código que itera ventures funciona uniforme.

---

## Refactor preparatorio (gratis, antes de A)

`Inflation.js` hoy hace dos cosas:
1. Mantiene el `priceIndex` EMA (state mutation).
2. Expone `effective*` helpers (pure facade).

Eso viola SRP. **Extraer `PriceIndex.js` antes de tocar otra cosa**, quedando:

| Archivo | Responsabilidad |
|---|---|
| `src/systems/PriceIndex.js` (nuevo) | `tickPriceIndex(state)`, `priceIndexFor(state, cid)` — owns the EMA |
| `src/systems/Inflation.js` | Solo helpers `effective*`, pure facade — depende de `priceIndexFor` |

Inflation.js queda sin state mutation. Esto deja Labor.js (Sprint A) limpio: importa `priceIndexFor` del módulo correcto, no de un facade.

**Cambios**: mover ~50 líneas de Inflation.js a PriceIndex.js, actualizar imports en Market.js (`tickPriceIndex`) y en Inflation.js (re-export o import).

---

## Sprint A — Mercado laboral

### A.1 Arquitectura de módulos

```
data/tunables.js      → WAGES.{baseWage, workAgeFraction, tightnessClamp}
data/producibles.js   → + harvestLabor, + monthlyLabor (deprecan harvestCost, monthlyOpCost)
data/industries.js    → + workforce (deprecan monthlySalary)
state/GameState.js    → country.{wageRate, wageRateHistory, laborDemand, laborSupply}
systems/Labor.js      → NUEVO: tickLaborMarket, wageRateFor, laborDemandFor, laborSupplyFor
systems/Inflation.js  → effective* helpers ahora consumen wageRateFor (DIP)
systems/PriceIndex.js → (del refactor preparatorio) sin cambios
scenes/Game.js        → country chart muestra labor, tile panel muestra wage market
```

Dependencias (acíclicas):
```
Labor      → PriceIndex (lee priceIndex para cost-of-living)
Inflation  → Labor + PriceIndex (facade pura)
Industries → Inflation
Farming    → Inflation
AI         → Inflation
Game.js    → Labor + Inflation (UI)
```

### A.2 `src/data/tunables.js`

Agregar al final:
```js
export const WAGES = {
  baseWage: 50,                  // $/mes por worker en condiciones neutras (tightness=1, priceIndex=1)
  workAgeFraction: 0.5,          // qué fracción de la population es PEA
  tightnessClamp: [0.4, 3.0],    // hard caps: wage no baja de 40%, no sube de 300%
  emaHalfLifeDays: 60,           // suavizado del wageRate (mismo orden que priceIndex)
  // El campo `WAGES.wageFundFloorDays` existente se mantiene
  ...existing fields...
};
```

### A.3 `src/data/producibles.js` — migración de unidades

Reemplazar campos por commodity. Calibración a baseWage=$50:

```js
wheat:  { ..., harvestLabor: 3,  /* deprecated harvestCost */ }
corn:   { ..., harvestLabor: 6 }
potato: { ..., harvestLabor: 3 }
apple:  { ..., harvestLabor: 16 }
cherry: { ..., harvestLabor: 21 }
copper: { ..., monthlyLabor: 1, /* deprecated monthlyOpCost */ }
iron:   { ..., monthlyLabor: 1 }
gold:   { ..., monthlyLabor: 1 }
```

Borrar `harvestCost` y `monthlyOpCost` o dejarlos comentados como referencia histórica. Validator en GameState.js puede chequear que crops tienen `harvestLabor`, minerals tienen `monthlyLabor`.

### A.4 `src/data/industries.js` — migración

```js
flourMill:     { ..., workforce: 16, /* was monthlySalary: 800 */ }
juicePlant:    { ..., workforce: 24 }
steelworks:    { ..., workforce: 30 }
cableFactory:  { ..., workforce: 28 }
bakery:        { ..., workforce: 36 }
jewelryShop:   { ..., workforce: 50 }
```

### A.5 `src/state/GameState.js` — estado del país

Dentro del seed loop de `createInitialState` (donde ya seteás `wageFund`, `treasury`, `marketPool`):

```js
c.wageRate = WAGES.baseWage;       // arranca neutral
c.wageRateHistory = [WAGES.baseWage];
c.laborDemand = 0;                  // se computa en primer tick
c.laborSupply = c.population * WAGES.workAgeFraction;
```

### A.6 `src/systems/Labor.js` — nuevo módulo (SRP foco)

API mínima y ortogonal (ISP):

```js
// Pure getters (sin mutar state).
export function laborSupplyFor(state, cid): number
export function laborDemandFor(state, cid): number
export function tightnessFor(state, cid): number     // clamp(demand/supply)
export function wageRateFor(state, cid): number       // valor cacheado en country.wageRate

// Single tick — owns the EMA mutation.
export function tickLaborMarket(state): void
```

Implementación de `laborDemandFor`: itera 3 fuentes (igual contrato LSP — todo es "labor unit"):

```js
function laborDemandFor(state, cid) {
  let total = 0;
  // 1. Industries operacionales
  for (const ind of state.industries) {
    if (ind.countryId !== cid) continue;
    if (ind.status === 'closed' || ind.status === 'building') continue;
    const recipe = INDUSTRIES[ind.recipeId];
    total += recipe?.workforce ?? 0;
  }
  // 2. Mining + cropping tiles (uniforme; cada def declara su labor)
  const map = state.maps?.[cid];
  if (map) {
    for (const tile of map.tiles) {
      if (!tile.crop || tile.industryId) continue;
      const def = PRODUCIBLES[tile.crop];
      if (!def || def.category === 'processed') continue;
      if (def.category === 'mining') {
        if (tile.miningStatus === 'closed') continue;
        total += def.monthlyLabor ?? 0;
      } else {
        // Crops: harvestLabor es por evento de cosecha. Convertir a equivalente
        // mensual usando cycles/month según el tipo.
        if (tile.state === 'fallow' || tile.state === 'plowed') continue;
        const cyclesPerMonth = def.perennial
          ? 30 / def.perennial.regrowDays
          : 30 / def.growthDays;
        total += (def.harvestLabor ?? 0) * cyclesPerMonth;
      }
    }
  }
  return total;
}
```

`tickLaborMarket(state)`: monthly. Computa demand/supply, target, EMA. Persiste history.

```js
export function tickLaborMarket(state) {
  const alpha = 1 - Math.pow(0.5, 1 / WAGES.emaHalfLifeDays);
  for (const cid of COUNTRY_IDS) {
    const c = state.countries[cid];
    if (!c) continue;
    const supply = (c.population || 0) * WAGES.workAgeFraction;
    const demand = laborDemandFor(state, cid);
    const raw = supply > 0 ? demand / supply : 1;
    const [lo, hi] = WAGES.tightnessClamp;
    const tightness = Math.max(lo, Math.min(hi, raw));
    const target = WAGES.baseWage * tightness * (priceIndexFor(state, cid) || 1);
    c.wageRate = (1 - alpha) * (c.wageRate ?? WAGES.baseWage) + alpha * target;
    c.laborDemand = demand;
    c.laborSupply = supply;
    c.wageRateHistory.push(c.wageRate);
    if (c.wageRateHistory.length > 360) c.wageRateHistory.shift();
  }
}
```

**OCP**: si mañana querés que survey workers cuenten como demanda, agregás un loop más en `laborDemandFor`. No tocás Inflation, no tocás Game.js.

### A.7 `src/systems/Inflation.js` — facade pura

Refactor para depender de wageRateFor (DIP):

```js
import { wageRateFor } from './Labor.js';
import { priceIndexFor } from './PriceIndex.js';

// Costos laborales — escalan con wageRate (market-driven)
export function effectiveSalary(state, cid, recipe) {
  return Math.round((recipe?.workforce ?? 0) * wageRateFor(state, cid));
}
export function effectiveHarvestCost(state, cid, def) {
  return Math.round((def?.harvestLabor ?? 0) * wageRateFor(state, cid));
}
export function effectiveMonthlyOpCost(state, cid, def) {
  return Math.round((def?.monthlyLabor ?? 0) * wageRateFor(state, cid));
}

// Costos de capital — siguen con priceIndex (no labor)
export function effectiveBuildCost(state, cid, recipe) {
  return Math.round((recipe?.buildCost ?? 0) * priceIndexFor(state, cid));
}
export function effectiveSeedCost(state, cid, def) {
  return Math.round((def?.seedCost ?? 0) * priceIndexFor(state, cid));
}
export function effectivePlowCost(state, cid, baseCost) {
  return Math.round(baseCost * priceIndexFor(state, cid));
}
export function effectiveSurveyCost(state, cid, baseCost) {
  return Math.round(baseCost * priceIndexFor(state, cid));
}
export function effectiveBaseRural(state, cid, basePrice) {
  return basePrice * priceIndexFor(state, cid);
}

// Re-export para conveniencia (no agrega responsabilidad)
export { priceIndexFor, wageRateFor };
```

Inflation queda sin lógica de cálculo, solo composición. SRP impecable.

### A.8 `src/scenes/Game.js` — hook + UI

**Game loop** — agregar al monthly tick (después de `tickIndustrySalaries`, antes de `tickAIMonthly`):
```js
tickLaborMarket(this.state);   // 8c: update labor market wage
```

**Country chart** — agregar líneas:
```
Labor: 1.2k jobs / 2.5k workforce (×0.48 tightness)
Wage:  $42/mo · sparkline
```

**Tile panel** para industries:
```
🏭 Flour Mill [operational]
   3× corn → 1× flour
   Salary: 16 workers × $50 = $800/mo (market)
```

### A.9 Verificación

1. **Cold start**: imprimir `state.countries[cid].wageRate` al iniciar → todos ≈ $50.
2. **Demand creciente**: build 5 industries en home → home.laborDemand sube → wageRate sube en EMA (60 días para llegar al target).
3. **Cap funciona**: forzar muchas industries → tightness clampa en 3.0 → wageRate ≤ $150/worker (3× baseWage).
4. **Salaries en log**: `Jewelry Workshop salary -$2500` al inicio (50 × $50), no se va a $5000/$10000 sin freno.
5. **Diferencial por país**: China population > Home population → wageRate(china) < wageRate(home). Verificable en country chart.

---

## Sprint B — Romper cobweb

### B.1 Arquitectura de módulos

```
data/tunables.js      → STORAGE.{unitWarehouseLabor, ...}, AI.{sellThreshold, sellRate}
systems/Storage.js    → NUEVO: tickStorageCost, storageBillFor
systems/Forecast.js   → NUEVO: pipelineSupplyFor, expectedPriceAt
systems/AISales.js    → NUEVO: aiTrySellInventory  (extracción del flujo de venta del AI)
systems/Farming.js    → autoHarvest AI deposita en inventory (cambio chico)
systems/AI.js         → orquesta: llama aiTrySellInventory mensual, aiPickBestVenture usa expectedPriceAt
scenes/Game.js        → panel del player muestra storage cost; AI decision log muestra expected vs spot
```

Dependencias:
```
Storage   → Labor (depende de wageRateFor para cost)
Forecast  → Market (priceMA), Producibles
AISales   → Forecast, Storage, executeTransaction
AI        → AISales, aiPickBestVenture
Farming   → Inflation (no cambia)
```

### B.2 `src/data/tunables.js`

```js
export const STORAGE = {
  // Labor units por unidad guardada por mes. Si Sprint A está, multiplica por wageRate.
  // Si no, usar STORAGE.unitCostPerMonth directo ($1) como fallback.
  unitWarehouseLabor: 0.02,       // = $1/mes a wage neutral
};

// Extender AI:
export const AI = {
  ...existing,
  sellThreshold: 0.92,            // vende cuando price ≥ MA60 × 0.92
  sellRate: 0.15,                 // 15% del stock por tick mensual
  inventoryCapDays: 30,           // hard cap = 30 días de consumption local; dump si excede
  pipelineLookbackDays: 60,       // ventana para detectar recent plantings
};
```

### B.3 `src/systems/Storage.js` — nuevo (SRP)

```js
import { COUNTRY_IDS } from '../data/countries.js';
import { STORAGE, FISCAL_CRISIS } from '../data/tunables.js';
import { wageRateFor } from './Labor.js';
import { walletFor } from './Bank.js';

// Pure getter: cuánto debería pagar el owner este mes por su inventario actual en cid.
export function storageBillFor(state, ownerId, cid) {
  const wallet = walletFor(state, ownerId);
  if (!wallet?.inventory) return 0;
  const wage = wageRateFor(state, cid);
  let units = 0;
  for (const qty of Object.values(wallet.inventory)) units += Math.max(0, qty);
  return Math.round(units * STORAGE.unitWarehouseLabor * wage);
}

// Mensual: cobra a cada wallet por su inventario. Va a wageFund (warehouse workers).
export function tickStorageCost(state) {
  for (const cid of COUNTRY_IDS) {
    const country = state.countries[cid];
    if (!country) continue;
    const haircut = country.fiscalCrisis?.active ? FISCAL_CRISIS.wageHaircutFraction : 0;

    // Player (paga si tiene inventory; asumimos almacenado en su home)
    // (player.countryId implícito = home; expandir si player tiene inventory abroad)
    const playerBill = storageBillFor(state, 'player', cid);
    if (cid === PLAYER_COUNTRY_ID && playerBill > 0 && state.player.cash >= playerBill) {
      state.player.cash -= playerBill;
      country.wageFund += playerBill * (1 - haircut);
    }

    // AI farmers en este país
    for (const ai of state.aiFarmers) {
      if (ai.countryId !== cid) continue;
      const bill = storageBillFor(state, ai.id, cid);
      if (bill > 0 && ai.cash >= bill) {
        ai.cash -= bill;
        country.wageFund += bill * (1 - haircut);
      }
    }
  }
}
```

**SRP**: Storage no toma decisiones de qué vender. Solo cobra por mantener inventario.

### B.4 `src/systems/Forecast.js` — nuevo

```js
import { PRODUCIBLES } from '../data/producibles.js';
import { priceMA } from './Market.js';

// Unidades/día que están "en camino" — tiles plantados que van a producir pronto.
export function pipelineSupplyFor(state, cid, pid) {
  const def = PRODUCIBLES[pid];
  if (!def || !def.growthDays) return 0;
  const map = state.maps?.[cid];
  if (!map) return 0;
  let dailySupply = 0;
  for (const tile of map.tiles) {
    if (tile.crop !== pid) continue;
    if (tile.state !== 'planted') continue;
    const remainingFraction = Math.max(0, 1 - (tile.growth || 0));
    // Yield esperado dividido por días restantes
    dailySupply += (def.yieldUnits || 0) / Math.max(1, def.growthDays * remainingFraction);
  }
  return dailySupply;
}

// Precio esperado en `daysAhead` días: combina MA largo y descuento por pipeline.
export function expectedPriceAt(state, cid, pid, daysAhead) {
  const def = PRODUCIBLES[pid];
  if (!def) return 0;
  const lookback = Math.max(30, Math.min(180, daysAhead));
  const ma = priceMA(state, pid, cid, lookback);
  if (ma <= 0) return 0;
  const consumption = state.countries[cid]?.consumption?.[pid] ?? 0;
  if (consumption <= 0) return ma;
  const pipeline = pipelineSupplyFor(state, cid, pid);
  // Si pipeline > consumption, esperar glut; ratio > 1 reduce precio esperado.
  const supplyRatio = (pipeline + consumption) / consumption;
  const discount = Math.max(0.4, Math.min(1.2, 1 / supplyRatio));
  return ma * discount;
}
```

**SRP**: Forecast no decide qué hacer. Solo proyecta.

### B.5 `src/systems/AISales.js` — nuevo (extrae el flujo de venta del AI)

```js
import { PRODUCIBLES } from '../data/producibles.js';
import { AI } from '../data/tunables.js';
import { priceMA } from './Market.js';
import { executeTransaction } from './Transactions.js';

// Mensual (o cada N días): cada AI revisa su inventario y vende gradualmente
// solo cuando el precio actual es razonable frente al MA60.
export function aiTrySellInventory(state, ai) {
  if (!ai.inventory) return;
  const cid = ai.countryId;
  for (const [pid, qty] of Object.entries(ai.inventory)) {
    if (qty <= 0) continue;
    const price = state.market.prices?.[cid]?.[pid] || 0;
    if (price <= 0) continue;
    const ma60 = priceMA(state, pid, cid, 60);
    if (ma60 <= 0) continue;

    // Hard cap: si el stock excede N días de consumo local, vender forzado.
    const consumption = state.countries[cid]?.consumption?.[pid] ?? 0;
    const cap = consumption * AI.inventoryCapDays;
    const forceSale = consumption > 0 && qty > cap;

    if (!forceSale && price < ma60 * AI.sellThreshold) continue;

    const sellQty = forceSale
      ? Math.ceil(qty - cap)                    // bajar al cap
      : Math.max(1, Math.floor(qty * AI.sellRate));

    const r = executeTransaction(state, {
      sellerId: ai.id, buyerId: 'foreign',
      productId: pid, units: sellQty, unitPrice: price,
      countryOfTransaction: cid, sellerCountryId: cid,
      type: 'b2b',
    });
    if (r.ok) {
      ai.inventory[pid] = qty - sellQty;
      // Inject supply into country pool so price reacts next tick
      const country = state.countries[cid];
      if (country) country.supplyToday[pid] = (country.supplyToday[pid] || 0) + sellQty;
    }
  }
}
```

**SRP**: AISales solo decide cuándo y cuánto vender. No produce, no compra inputs, no plant decisions.

### B.6 `src/systems/Farming.js` — cambio quirúrgico en autoHarvest

```js
// Antes: revenue = sellToMarket(...); if (ai) ai.cash += revenue;
// Después: depositar en ai.inventory (igual que para player).

} else {
  const ai = state.aiFarmers?.find(a => a.id === tile.owner);
  if (ai) {
    if (!ai.inventory) ai.inventory = {};
    ai.inventory[tile.crop] = (ai.inventory[tile.crop] || 0) + units;
    // No tracking de lossStreak inmediato — eso ahora ocurre cuando aiTrySellInventory vende.
  }
}
```

`lossStreak` y `skipStreak` ahora se evalúan en AISales contra el precio al que efectivamente vende, no contra spot.

### B.7 `src/systems/AI.js` — integración

- Importar `aiTrySellInventory` desde `AISales.js`.
- En `tickAIMonthly`, agregar `aiTrySellInventory(state, ai)` al inicio (antes de top up de industries).
- `aiPickBestVenture` (ya existe de Fase 5): reemplazar `priceMA(state, def.id, cid, 30)` por `expectedPriceAt(state, cid, def.id, def.growthDays)`. La intuición: para un manzano que tarda 730 días, lo que importa es el precio esperado a 2 años, no el de hoy.

### B.8 `src/scenes/Game.js` — UI mínima

**Tile panel** (player, si tiene inventory):
```
Storage: 50u apple → $1/mo (× wage market)
```

**AI decision log** entries (gratis, ya existe `pushAIDecision`):
```
considered: apple expected $80 (vs spot $250) — pipeline glut
```

### B.9 Hook en game loop

```js
if (events.month) {
  tickIndustrySalaries(this.state);
  tickMiningOps(this.state);
  tickStorageCost(this.state);    // 8c: warehouse labor → wageFund
  tickLoans(this.state);
  tickFiscalCrisis(this.state);
  tickLaborMarket(this.state);    // 8d (después de los cobros que generan demand)
  tickAIMonthly(this.state);
}
```

### B.10 Verificación

1. **Sin cobweb visible**: 5+ años a speed alto, sparkline de manzana en country chart sin sierra dentada.
2. **AI inventory no infinito**: si precios bajos sostenidos, AI eventualmente vende vía inventoryCapDays hard cap.
3. **AI decision log** muestra "expected $80 (vs spot $250)" en períodos de pipeline glut.
4. **Storage cost visible al player** si acumula inventory significativo.

---

## Sprint C — Exportadoras

### C.1 Arquitectura de módulos

```
data/tunables.js       → EXPORTERS.{minMarginPct, etaDaysPerDistance, baseCapital, ...}
data/exporters.js      → NUEVO: registry de nombres + colors para AI exporters
state/GameState.js     → state.exporters = []
systems/Exporters.js   → NUEVO: lifecycle (create, tickInTransit, settle)
systems/ExporterAI.js  → NUEVO: AI decision strategy (paralelo a IndustryAI.js)
systems/Market.js      → ELIMINAR bloque arbitrage 135-169; tradeFlows ahora derivan de Exporters
systems/WorldSeed.js   → sembrar exportadoras AI por país
scenes/Game.js         → vista Exporters en top bar; World view dibuja cargamentos
```

Dependencias:
```
Exporters   → Transactions (executeTransaction), Distances (transportCost, etaDays)
ExporterAI  → Exporters, Forecast (expectedPriceAt), Market (priceMA)
WorldSeed   → Exporters (createExporter)
Market      → ya no hace arbitraje
```

### C.2 `src/data/tunables.js`

```js
export const EXPORTERS = {
  minMarginPct: 0.10,             // margen mínimo (delivered < destPrice × 0.90) para disparar viaje
  etaDaysPerDistance: 2,          // días de tránsito por unit de distance (ej. distance 5 = 10 días)
  baseCapital: 5000,              // cash inicial de una exportadora AI
  maxCapitalPerTripFraction: 0.5, // gasta hasta 50% del cash por viaje
  decisionCooldownDays: 7,        // cada cuánto la exportadora considera un nuevo viaje
};
```

### C.3 `src/data/exporters.js` — registry

```js
export const EXPORTER_NAMES = [
  'East Indies Co.', 'Pacific Trade', 'TransGlobal',
  'Maritime Ventures', 'Continental Freight',
];
export const EXPORTER_COLORS = [0x88c8ff, 0x60b3ff, 0xc792ea, 0xff8a4a, 0x6ee7b7];
```

OCP: agregar más exportadoras = agregar entries acá. Cero código.

### C.4 `src/state/GameState.js`

```js
exporters: [],     // [{ id, ownerId, homeCountryId, cash, color, name, cooldown,
                   //    inFlight: [{ srcCid, dstCid, pid, units, etaDay, costPaid }] }]
```

### C.5 `src/systems/Exporters.js` — lifecycle (SRP)

API mínima:
```js
export function createExporter(state, { homeCountryId, ownerId, name, color, capital }): exporter
export function tickExporters(state): void              // daily: avanza inFlight, settles arrivals
export function exporterStartShipment(state, exporter, plan): { ok, reason? }
export function exportersByCountry(state, cid): exporter[]
```

`tickExporters` (daily):
- Para cada exporter, recorrer `inFlight`. Si `etaDay <= state.totalDays`: vender en destino via `executeTransaction`, marcar settlement, agregar entry a `state.tradeFlows`. Si ok, plata vuelve al cash del exporter. Si saturated market, mantener cargo, intentar próximo tick (con descuento de precio si lleva muchos días varado).

`exporterStartShipment(state, exporter, plan)`:
- plan = `{ srcCid, dstCid, pid, units, unitPrice }`. Computa `costPaid = (unitPrice + tax) × units + transport`.
- Llama `executeTransaction` con `sellerId: 'foreign'` (compra del marketPool del src), `buyerId: exporter.id`. Esto debe extender `walletOf` para que reconozca exporter IDs.
- Si ok, agrega entry a `exporter.inFlight` con `etaDay = state.totalDays + distance × etaDaysPerDistance`.

**SRP**: Exporters no decide qué comprar. Solo ejecuta planes.

### C.6 Cambio en `src/systems/Transactions.js`

Extender `walletOf` para reconocer exporters:
```js
export function walletOf(state, ownerId) {
  if (ownerId === 'player') return state.player;
  if (ownerId === 'population' || ownerId === 'treasury' || ownerId === 'foreign') return null;
  // Buscar primero en aiFarmers, después en exporters
  return state.aiFarmers?.find(a => a.id === ownerId)
      ?? state.exporters?.find(e => e.id === ownerId)
      ?? null;
}
```

Pattern abierto: si agregás más tipos de actores (banks, governments), se extiende acá.

### C.7 `src/systems/ExporterAI.js` — decision (paralelo a IndustryAI.js)

```js
export function aiExporterTryShipment(state, exporter): void
```

Loop:
1. Para cada par (srcCid, dstCid) con `srcCid !== dstCid`:
   - Para cada `pid` en producibles:
     - `priceSrc = priceMA(state, pid, srcCid, 30)`
     - `priceDst = priceMA(state, pid, dstCid, 30)`
     - `transport = transportCost(srcCid, dstCid, 1)`
     - `margin = (priceDst - priceSrc - transport) / priceDst`
     - Si `margin >= EXPORTERS.minMarginPct` y exporter tiene cash, considerar este viaje.
2. Pickear el mejor (mayor margin × units viables).
3. `exporterStartShipment(state, exporter, plan)`.

**OCP**: agregar Forecast.expectedPriceAt acá para que el AI proyecte sobre la duración del tránsito (no solo MA).

### C.8 `src/systems/Market.js` — eliminar arbitraje instantáneo

Borrar el bloque `for (const pid of PRODUCIBLE_IDS) { for (const dst of COUNTRY_IDS) ... }` en `tickMarket` (~líneas 135-169). El cross-country trade ahora viene de Exporters.

`state.tradeFlows` se sigue alimentando — pero ahora desde `Exporters.tickExporters` cuando se settlea un cargamento. Mismo formato `{ day, src, dst, pid, units }`.

### C.9 `src/systems/WorldSeed.js`

```js
import { createExporter } from './Exporters.js';
import { EXPORTER_NAMES, EXPORTER_COLORS } from '../data/exporters.js';
import { EXPORTERS } from '../data/tunables.js';

// Llamar dentro de seedStarterProduction, una vez por país:
function seedExportersFor(state, cid, index) {
  const count = 2;     // 2 exportadoras AI por país inicial
  for (let i = 0; i < count; i++) {
    const idx = (index + i) % EXPORTER_NAMES.length;
    createExporter(state, {
      homeCountryId: cid,
      ownerId: `${cid}_exp${i}`,
      name: EXPORTER_NAMES[idx],
      color: EXPORTER_COLORS[idx % EXPORTER_COLORS.length],
      capital: EXPORTERS.baseCapital,
    });
  }
}
```

### C.10 `src/scenes/Game.js` — UI

**Top bar**: agregar botón "🚢 Exporters" (icon button, mismo patrón que 🏭 Companies).

**Modal Exporters** (paralelo a Companies):
- Lista de todas las exportadoras (player + AI).
- Por cada una: nombre, país home, cash, cargamentos en vuelo, P&L acumulado.
- Click en cargamento: muestra ruta src→dst, ETA, profit esperado vs precio actual destino.

**World modal**: ya tiene flechas de trade. Cuando un cargamento está en vuelo, dibujar línea punteada animada src→dst. Cuando settlea, agrega a `state.tradeFlows` y la línea pasa a sólido.

**Player path**: en modal Bank o Companies, opción "Found new exporter": elegir homeCountry, capital inicial; loan opcional. Una vez creada, panel para configurar políticas (margin mínimo, capital por viaje, producibles autorizados).

### C.11 Game loop

```js
if (events.day) {
  ...existing...
  tickExporters(this.state);          // settlea cargamentos que llegaron
  for (const exp of this.state.exporters) {
    if (exp.cooldown > 0) { exp.cooldown -= 1; continue; }
    exp.cooldown = EXPORTERS.decisionCooldownDays;
    if (exp.ownerId !== 'player') aiExporterTryShipment(this.state, exp);
  }
}
```

### C.12 Verificación

1. **Bootstrap funciona**: con 0 exportadoras player, los precios convergen igual gracias a las AI seeded.
2. **Tránsito visible**: cargamento de cobre USA → Home tarda `4 × 2 = 8` días-juego. World modal lo muestra animado.
3. **Quiebra elegante**: forzar precio destino a colapsar mientras un cargamento está en vuelo. Exportadora pierde plata. Si llega a $0 cash, se "retira" (state.exporters.splice). UI muestra "bankrupt" en log.
4. **Sin regresiones**: marketPool por país sigue cerrando (totalMoneySupply estable).
5. **Player path**: jugador funda una exportadora, configura ruta, ve ganancias acumulándose.

---

## Resumen de archivos nuevos por sprint

| Sprint | Archivos nuevos | Archivos modificados |
|---|---|---|
| Preparatorio | `PriceIndex.js` | `Inflation.js`, `Market.js` |
| A | `Labor.js` | `tunables.js`, `producibles.js`, `industries.js`, `GameState.js`, `Inflation.js`, `Game.js` |
| B | `Storage.js`, `Forecast.js`, `AISales.js` | `tunables.js`, `Farming.js`, `AI.js`, `Game.js` |
| C | `Exporters.js`, `ExporterAI.js`, `exporters.js` (data) | `tunables.js`, `GameState.js`, `Transactions.js`, `Market.js`, `WorldSeed.js`, `Game.js` |

Total: **7 módulos nuevos**, **0 dependencias circulares**, cada uno con responsabilidad clara y testeable de forma aislada.

## Test/verification matrix

Cada sprint trae su propia verificación arriba. Adicional, después de cada sprint:

- `node --input-type=module -e "import('./src/.../File.js').then(...)"` para cada archivo nuevo (parse sanity).
- Manual playtest 5+ años con speed máximo, observar:
  - `totalMoneySupply` estable (±5% en un año-juego).
  - `priceIndex` por país en rango 0.8–1.5.
  - `wageRate` por país en rango 0.4–2.5 × baseWage.
  - Sparklines de commodities sin sierras dentadas.

## Riesgos generales

1. **Re-balanceo de calibración**: post-A los costos efectivos cambian. Esperar oscilación inicial. Tunear `WAGES.baseWage` o `tightnessClamp` si los costos se descalibran.
2. **Performance**: `laborDemandFor` recorre todos los tiles. Con 5 países × 196 tiles eso son ~1000 iteraciones/mes. Aceptable. Si crece, cachear en `country.laborDemand` y solo recomputar al cambiar (industry build/close, plant, harvest).
3. **Compatibilidad con saves**: si en algún momento agregás save/load, los items deprecados (harvestCost, monthlySalary) deben tener un migration shim. Por ahora no hay save → ignorar.

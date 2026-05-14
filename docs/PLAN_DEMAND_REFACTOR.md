# Plan — Demand vs Consumption refactor (postpuesto)

> **Status**: postpuesto. Este plan se ejecuta **después** de estabilizar la base agrícola single-country (ver rama `scope-reduction-1country-farming`).
>
> **Por qué postpuesto**: el problema del feedback loop existe en la base agrícola también, pero conviene resolverlo cuando los rails (Population, Market) estén simplificados al núcleo. Reintroducir industries/exporters después aplica el refactor a esos sites en la misma fase de reintroducción.

---

## Contexto del problema

El sistema actual mide demanda como `consumptionHistory[pid]` = unidades efectivamente compradas en los últimos 90 días. Si `inv = 0`, nadie compra → `consumptionDay = 0` → 90 días así → `consumptionHistory` se vacía → `target_stock → 0` → precio cae al floor → ningún incentivo a producir → economía atrapada.

**La demanda latente** (lo que los buyers querrían comprar si hubiera stock al precio actual) se evapora. Eso es un bug conceptual.

---

## Approach recomendado

Rail **paralelo** `demandHistory` que mide demanda **price + budget feasible asumiendo stock infinito**. `recomputeTargetStocks` lee este rail. `consumptionHistory` permanece como métrica observada (charts, nutrición).

**Regla de oro:** un buyer genera demand cuando pasaría TODOS los checks excepto stock. Wallet sí, price sí, stock **no**.

---

## Definición de "demand" por agente

| Agente | demand = | consumption = (sin cambios) |
|---|---|---|
| Population (`Population.js:50-82`) | `wantUnits = budget × score/totalScore / unitTotal`, cap por nutrición remanente | `min(wantUnits, inv, maxByNutrition)` |
| Industria AI top-up (`IndustryAI.js:78-102`) | `min(need, ai.cash / price)` | `min(need, stock, ai.cash/price)` (lo actual) |
| Industria del player (`Industries.js:131-146`) | `need = qty − have` SI `wallet.cash ≥ price × need × 1.2` | el `need` efectivamente comprado |
| Exporter (`Exporters.js:52-108`) | `units` del plan SI pasó margin check | `buy` que devolvió `buyFromGlobal` |
| Player UI manual | NO contar (decisión humana, no demanda económica orgánica) | lo que efectivamente compre |

---

## Schema nuevo en `state.countries[cid]`

Por simetría con el rail de consumption (si todavía existe el split local/export — depende de cuando se ejecute esto):

```js
demandDay: {},
demandLocalToday: {},
demandExportToday: {},
demandHistory: {},
demandLocalHistory: {},
demandExportHistory: {},
```

### Invariantes

```
demandHistory[pid][i]  ===  demandLocalHistory[pid][i] + demandExportHistory[pid][i]
demandHistory[pid][i]  >=   consumptionHistory[pid][i]   (siempre — cubre stockouts)
```

### Seed inicial

```js
const seed = isFood(pid) ? (c.consumption[pid] || 0) : 0;
runtime[id].demandHistory[pid] = new Array(90).fill(seed);
```

Foods con baseline (igual que consumption); no-foods en 0 (preserva el comportamiento correcto para minerales sin consumer).

---

## Cambios por archivo (file:line del momento de planificación)

### `src/systems/Market.js`

- **L25-79** `createCountriesState`: agregar los 6 nuevos campos (3 acumuladores + 3 rings).
- **L80-112**: agregar helpers
  ```js
  function _recordDemand(country, pid, units, isExport) { /* ... */ }
  export function recordDemand(country, producibleId, units, isExport = false) { /* ... */ }
  ```
- **L120-136** `recomputeTargetStocks`: cambiar `c?.consumptionHistory?.[pid]` → `c?.demandHistory?.[pid]`. Una sola línea — ese es el momento del cambio de comportamiento.
- **L141-148** `ROTATE_PAIRS`: agregar 3 entradas (`demandDay/demandHistory`, `demandLocalToday/demandLocalHistory`, `demandExportToday/demandExportHistory`).
- **L222-234** zona del `prevSupplyToday / prevConsumptionDay`: capturar también `prevDemandDay[cid]`.
- Pasar `prevDemandDay` a `recordMarketSnapshot(...)`.

### `src/systems/Population.js:50-82` — Capture site crítico

Refactor: mover el cálculo de `wantUnits` ANTES del check de stock.

```js
for (const cand of candidates) {
  if (budget <= 0 || nutritionAcquired >= nutritionTarget) break;
  // 1. demand asumiendo stock infinito (budget + nutrition feasible)
  const allocate = budget * (cand.score / totalScore);
  const rates = effectiveTaxRates(state, cid);
  const unitTotal = cand.price * (1 + rates.sale);
  const wantUnits = allocate / unitTotal;
  const remainingNutrition = Math.max(0, nutritionTarget - nutritionAcquired);
  const maxByNutrition = cand.nutrition > 0 ? remainingNutrition / cand.nutrition : wantUnits;
  const demandUnits = Math.min(wantUnits, maxByNutrition);
  if (demandUnits <= 0) continue;
  recordDemand(c, cand.pid, demandUnits, /* isExport */ false);
  // 2. Ahora sí mirar stock para la compra real
  const inv = m.inventory[cid][cand.pid] || 0;
  if (inv <= 0) continue;
  const buyUnits = Math.min(demandUnits, inv);
  // ... resto sin cambios
}
```

### `src/systems/IndustryAI.js:78-102` — `aiTopUpIndustryInputs` (cuando se reintroduzca)

Calcular `wantBuy = min(need, ai.cash / price)` antes del cap por stock. Registrar `wantBuy` como demand, luego comprar `min(wantBuy, stock)`.

### `src/systems/Industries.js:131-146` — Player industries (cuando se reintroduzca)

Antes del fallo por stock, si pasa wallet check, registrar `need` como demand.

### `src/systems/Exporters.js:52-108` — Cross-country (cuando se reintroduzca)

Antes del check de stock en srcCid, `recordDemand(state.countries[srcCid], pid, units, true)`.

### `src/systems/MarketHistory.js:33-57` — Visibilidad CSV

Aceptar `demandOverride`, agregar `demandDay: Math.round(demSrc?.[pid] ?? 0)` al snapshot record.

---

## Fases de implementación

| Fase | Cambio | Verificación |
|---|---|---|
| 1. Infra | Schema, helpers, seed, ROTATE_PAIRS, captura prev | sim 100d sin errores, `demandHistory` en seed inicial |
| 2. Capture sites | Population (+ industrias y exporters si están reintroducidos) | sim 100d: `demand >= consumption` por día |
| 3. Switch reader | Una línea en `recomputeTargetStocks` | sim 365d: ítems con demand latente no colapsan precio |
| 4. Visibilidad CSV | `demandDay` en snapshot | export CSV manual muestra columna |
| 5. Verify | 3 escenarios headless | 3 pasan |

---

## Verification (headless)

### Escenario A — Apples-can-be-grown-but-aren't (caso del bug original)

Bot heurístico no planta apples.

**Expected con refactor:**
- `consumptionHistory[home][apple] → 0` después de ~30 días (inv inicial agotado).
- `demandHistory[home][apple] ≈ baseline (2u/día) sostenido` — la pop sigue queriendo apples.
- `targetStock[home][apple] ≈ 60u` sostenido.
- `prices[home][apple]` **no colapsa** al floor — gap=+1 persistente.

**Actual hoy (bug):** target → 0, gap → −1, precio → 0.50.

### Escenario B — Minerals-nobody-needs (regression guard)

Sin demanda real, `demandHistory[mineral] = 0` → `target = 0` → `gap = −1` → precio cae al floor. Comportamiento preservado.

### Escenario C — Foods steady-state (sanity)

Economía balanceada. `demand ≈ consumption` (diff < 5%). Precios sin más oscilación que hoy.

### Smoke interactivo

Build 0 farms en una ciudad. Mirar góndola de apples a lo largo de 6 meses simulados:
- **Pre-refactor**: precio cae al floor ~día 60.
- **Post-refactor**: precio sostenido alto, señal económica clara.

---

## Edge cases

1. **Boot day 0**: ambos rings con seed idéntico → target inicial igual a hoy → ningún shock startup.
2. **Pop migra a sustitutos por precio alto**: score-share baja `allocate` automáticamente → `wantUnits` baja → demand baja. Feedback de sustitución preservado.
3. **Stockout persistente**: `wantUnits` se calcula sin mirar stock → demand acumula → target alto → gap=+1 → precio crece → atrae oferta.
4. **Minerales sin demanda real**: nadie llama `recordDemand` → ring queda 0 → target=0 → floor. Comportamiento deseado.
5. **Industria con wallet vacío**: wallet check falla → NO se registra como demand. Económicamente correcto.
6. **Exporter src out of stock**: demand SÍ registra en srcCid antes del check. Presión legítima sobre target del origen.
7. **`tickCityYearly` / nutrición**: sin cambios. Sigue leyendo `consumptionHistory` (verdad observada). Pop NO se nutre de demanda fantasma.

---

## Out of scope

- Reservation prices / queueing (carry-over de demanda no satisfecha entre días).
- Pure-flow refactor (precio basado en flujos diarios, no en niveles de stock).
- Asimetrizar `responsiveness` (distinto coeficiente para gap>0 vs gap<0).
- Serie demand visualizada en Stock chart Flows mode (deseable, ortogonal).

# TODO — pendientes concretos

> Lista de cosas decididas pero no implementadas. Vive separada de `PLAN.md` (que es design doc evolutivo). Cada item tiene contexto + dirección suficiente para retomarlo en otra sesión sin perder hilo.

---

## Roadmap

> Orden recomendado para los 3 items pendientes. Cada uno es una "sprint" independiente y shippable. La justificación del orden está en las dependencias económicas: el mercado laboral fija la convención de cómo se paga la mano de obra (en `workforce × wageRate`), el cobweb fix consume esa convención (storage cost va a wageFund vía warehouse labor), y las exportadoras se construyen sobre el patrón de "compra-guarda-vende" del cobweb fix.

### Sprint 1 — Mercado laboral (item A)

**Por qué primero**: arregla el bug más visible — los salarios disparándose al infinito vía `priceIndex`. Es un cambio estructural que cambia la convención: todos los costos de labor pasan a expresarse como `unidades × wageRate(cid)` en vez de fórmulas independientes. Cualquier sprint posterior que toque labor (almacenaje en B, tripulación de exportadoras en C) va a reutilizar este sistema.

Sub-fases sugeridas:

1. **Tunables y schema** — `WAGES.baseWage = 50`, `workAgeFraction = 0.5`, `tightnessClamp = [0.4, 3.0]`. Agregar `country.wageRate`, `wageRateHistory`, `laborDemand`, `laborSupply` en `createCountriesState`.
2. **Recipes en labor units** — convertir `monthlySalary` (industries.js) a `workforce`, `harvestCost` (producibles.js) a `harvestLabor`, `monthlyOpCost` a `monthlyLabor`. Con `baseWage = 50` los valores quedan en enteros limpios (ver tabla más abajo).
3. **Nuevo `src/systems/Labor.js`** — `tickLaborMarket(state)` mensual: recomputa demand (suma workforce de ventures activas), target wage, actualiza EMA60 de `wageRate`.
4. **Refactor `Inflation.js`** — `effectiveSalary` / `effectiveHarvestCost` / `effectiveMonthlyOpCost` pasan a ser `units × wageRate(cid)` (priceIndex queda solo para `tilePrice`, `buildCost`, `seedCost`, `plowCost`, `surveyCost`).
5. **UI** — country chart muestra labor demand/supply/wageRate con sparkline. Tile panel de industries muestra "Salary: 16 workers × $50 = $800/mo (market)".

**Quick-fix temporal**: si urge antes del refactor, agregar `Math.min(monthlySalary × priceIndex, monthlySalary × 2)` en `effectiveSalary` (3 líneas, cap del 2× al nominal). Cubre el síntoma pero no es economía real.

### Sprint 2 — Romper cobweb: storage + AI con pipeline (item B)

**Por qué segundo**: arregla la oscilación de precios (sierra dentada en commodities) que hoy es la principal fuente de inestabilidad. Depende de Sprint 1 porque el `STORAGE.unitCostPerMonth` se va a wageFund — debería pasarse como `warehouseLabor × wageRate(cid)` para ser coherente con la convención laboral. Si se hace antes que A, hay que volver a tocar Storage al hacer A.

Sub-fases sugeridas:

1. **Storage cost tunable** — `STORAGE.unitWarehouseLabor = 0.02` (por unidad por mes, en worker-units si Sprint 1 está hecho). Si no, `unitCostPerMonth = $1` directo.
2. **AI no dump-sell** — `autoHarvest` para AI deposita en `ai.inventory` igual que para player. Quitar el `sellToMarket` directo.
3. **`aiTrySellInventory`** mensual — vende solo cuando `currentPrice ≥ priceMA(60d) × 0.92`, y solo 15% del stock por tick. Distribuye la oferta.
4. **`aiPayStorageCost`** mensual — cobra al AI por unidad guardada. Va a wageFund.
5. **Helpers `expectedPriceAt(state, cid, pid, daysAhead)` y `pipelineSupplyFor`** — en `Market.js`. Estiman precio futuro descontando supply pendiente del pipeline (tiles plantados x madurez restante).
6. **Refactor `aiPickBestVenture`** (en `AI.js`, ya implementado en Fase 5) — usar `expectedPriceAt(growthDays)` en vez de `priceMA(30)` para crops largos. Aplicar penalty si `pipelineSupply / consumption > 1` (sobreoferta esperada).
7. **UI** — panel del player muestra "Storage: 50u apple → $50/mo" si tiene inventory acumulado.

### Sprint 3 — Exportadoras (item C)

**Por qué último**: cambio más invasivo (toca arbitraje internacional, nuevo módulo grande, nueva UI). Conceptualmente es una extensión del patrón de Sprint 2: una exportadora **es** un agente que compra, guarda durante el viaje, y vende. Sprint 2 deja el patrón en código (slow-sell de AI). Sprint 3 lo generaliza a agentes cross-país. Si Sprint 1 también está hecho, las exportadoras pueden tener `crewWorkforce` que paga vía `wageRate(homeCountry)` — modelo más rico.

Sub-fases sugeridas:

1. **State + tunables** — `state.exporters = []`, `EXPORTERS.minMarginPct = 0.10`, `etaDaysPerDistance = 2`, `baseCapitalPerTrip = 5000`.
2. **Nuevo `src/systems/Exporters.js`** — lifecycle, tick diario que decide compras, simula tránsito, ejecuta ventas en destino vía `executeTransaction`.
3. **WorldSeed** — sembrar 1–3 exportadoras AI por país. Sin esto, los precios divergen al infinito porque nadie comercia internacionalmente.
4. **Eliminar arbitraje instantáneo** — borrar `Market.js:135-169` (cross-country arbitrage). `state.tradeFlows` y `tradeFlowVolume` ahora se derivan de la actividad real de exportadoras.
5. **UI** — vista "Exporters" en top bar (o tipo nuevo dentro de modal Companies). World view dibuja cargamentos en tránsito.
6. **Player path** — comprar/financiar exportadora propia, configurar políticas (producible, capital máximo por viaje, margen mínimo).

### Resumen de dependencias

```
A (Labor)  ─── independiente
            │
B (Cobweb) ─┴── reutiliza wageRate de A para storage labor cost
            │
C (Exp.)   ─┴── reutiliza pattern slow-sell de B; opcional: crew via A
```

Cada uno se puede hacer aislado, pero hacerlos en orden A → B → C evita re-tocar archivos por convenciones que aún no existen.

---

## [ ] Mercado laboral: salarios por oferta y demanda

### Problema
Hoy `monthlySalary` se fija en `src/data/industries.js` como número arbitrario (flourMill $800, jewelry $2500, etc.). El "real" pagado es `monthlySalary × priceIndex` — solo se mueve por inflación general, no por escasez de trabajadores.

Resultado: cuando priceIndex crece (por shortage, glut, ciclo cobweb), los salarios **multiplican** sin freno. No hay mecanismo de mercado que los baje. En la realidad, si hay mucha gente sin trabajo el salario cae; si hay pleno empleo el salario sube. Eso no existe acá.

El usuario lo identificó: "actualmente estamos seteando un sueldo mínimo, eso debería verse más por oferta y demanda".

### Diseño: `wageRate` por país

Cada país tiene un sueldo de mercado emergente:

```
laborSupply(cid)  = population(cid) × WORK_AGE_FRACTION              // ≈ 0.5
laborDemand(cid)  = Σ workforce de ventures operacionales en cid
tightness(cid)    = clamp(laborDemand / laborSupply, 0.4, 3.0)
targetWage(cid)   = WAGES.baseWage × tightness × priceIndex(cid)
wageRate(cid)     = EMA60(targetWage)                                 // sticky
```

`priceIndex` aún entra (cost-of-living), pero amplificado/atenuado por la presión real del mercado laboral. Si hay sobre-empleo (más jobs que gente), `tightness > 1` → salarios suben. Si sub-empleo, `tightness < 1` → salarios bajan.

### Recipes en términos de labor (no de plata)

Con `baseWage = $50/mes/trabajador`, los recipes quedan en enteros limpios (sin decimales contraintuitivos):

**Industries** (`monthlySalary` actual → `workforce`):

| Industry | monthlySalary | workforce |
|---|---|---|
| flourMill   | $800  | **16** |
| juicePlant  | $1200 | **24** |
| steelworks  | $1500 | **30** |
| cableFactory| $1400 | **28** |
| bakery      | $1800 | **36** |
| jewelryShop | $2500 | **50** |

**Crops** (`harvestCost` actual → `harvestLabor` en worker-months equivalente):

| Crop   | harvestCost | harvestLabor | salario eq. |
|---|---|---|---|
| wheat  | $140  | **3**  | $150 (+7%)  |
| corn   | $320  | **6**  | $300 (-6%)  |
| potato | $140  | **3**  | $150 (+7%)  |
| apple  | $800  | **16** | $800 (exact)|
| cherry | $1050 | **21** | $1050 (exact)|

**Minerals** (`monthlyOpCost` actual → `monthlyLabor`):

| Mineral | monthlyOpCost | monthlyLabor | costo mes eq. |
|---|---|---|---|
| copper | $25 | **1** | $50 (2× original) |
| iron   | $18 | **1** | $50 (2.7× original) |
| gold   | $48 | **1** | $50 (~exact) |

La pequeña recalibración (~7% de drift) es aceptable; sin decimales un slot de minería = un trabajador real, no "medio trabajador". Si en práctica el costo de minería sube demasiado se puede ajustar a `monthlyLabor: 0.5` (medio-tiempo) caso por caso.

Las funciones effective se vuelven simples productos:

```
effectiveSalary(state, cid, recipe)    = recipe.workforce  × wageRate(cid)
effectiveHarvestCost(state, cid, def)  = def.harvestLabor  × wageRate(cid)
effectiveMonthlyOpCost(state, cid, def)= def.monthlyLabor  × wageRate(cid)
```

Si `priceIndex = 1` y `tightness = 1`, `wageRate = $50` → un industry de 16 workers paga $800 (match con el actual). Cuando el mercado laboral se aprieta, `tightness > 1` y los costos suben proporcionalmente.

### Loop económico auto-regulado

- **Boom industrial**: muchas industrias se abren → laborDemand sube → wageRate sube → costos suben → algunas industries cierran solas (ya tenemos `aiTryCloseIndustry`). Demand baja → wageRate baja. Equilibrio.
- **Crisis de cierres**: industries cierran → laborDemand baja → wageRate baja → margen mejora → otras vuelven a ser rentables → reabren. Cobweb amortiguado.
- **Países con más población** (China): laborSupply grande → wageRate bajo → ventaja comparativa industrial → naturalmente más industries. Coherente con economía real.

### Files a tocar

| Archivo | Cambio |
|---|---|
| `src/data/tunables.js` | + `WAGES.baseWage = 200`, `WAGES.workAgeFraction = 0.5`, `WAGES.tightnessClamp = [0.4, 3.0]` |
| `src/data/producibles.js` | Convertir `harvestCost` → `harvestLabor`, `monthlyOpCost` → `monthlyLabor` |
| `src/data/industries.js` | Convertir `monthlySalary` → `workforce` |
| `src/state/GameState.js` | + `country.wageRate`, `country.wageRateHistory`, `country.laborDemand`, `country.laborSupply` |
| Nuevo `src/systems/Labor.js` | `tickLaborMarket(state)` mensual: recomputa demand, target, actualiza EMA |
| `src/systems/Inflation.js` | `effectiveSalary` / `effectiveHarvestCost` / `effectiveMonthlyOpCost` usan `wageRate` en vez de fórmula directa con priceIndex |
| `src/scenes/Game.js` | Country chart: línea "Labor: demand/supply · wage $X (×tightness)". Tile panel para industries muestra "Salary: 4 workers × $250 = $1000/mo (market)" |

### Verificación

1. **Cold start**: wageRate ≈ baseWage en todos los países (tightness ≈ 1.0).
2. **Sueldos no se disparan**: hard cap por el clamp de tightness en 3.0× — máximo 3× del nominal aún con priceIndex alto.
3. **Country chart sparkline**: wageRate visible, debería oscilar sin runaway.
4. **Estabilidad de industries**: con cobweb antes había cierres masivos → industries cerradas; ahora salarios bajan y se recuperan.
5. **Sueldo nominal por país difiere**: China (mucha pop) tiene wageRate menor que Home → industrias chinas más competitivas. Refleja realidad.

### Alternativa rápida (si quieren ahorrar el refactor)

**Solo clampear**: en `effectiveSalary` agregar `Math.min(monthlySalary × priceIndex, monthlySalary × 2)`. Cap del 2× sobre el nominal. Frena los sueldos a las nubes sin cambiar nada estructural. Pero no es "mercado", solo un techo.

---

## [ ] Romper el ciclo cobweb: storage + AI con visión de pipeline

### Problema
Patrón observado especialmente con perennials (manzana, cherry):

1. AI cosecha y **vende todo de inmediato** → precio se desploma (oferta gigante, demanda diaria normal).
2. Población compra mucho mientras está barato → stock se agota rápido.
3. Precio se dispara cuando se acaba.
4. AI ve precio en las nubes y **decide plantar manzana** (730 días para que produzca).
5. Cuando madura, todos cosecharon a la vez → glut de oferta → precio al piso.
6. AI deja de plantar → años después, escasez → precio sube → repeat.

Hay dos causas estructurales en el código actual:
- **Dump-sell instantáneo**: en `src/systems/Farming.js` `autoHarvest`, cuando el dueño es AI, llama `sellToMarket(state, tile.crop, units, countryId)` y suma todo el revenue al cash del AI **el mismo día** de la cosecha. La oferta diaria sufre un spike enorme y el `tickMarket` baja precio violentamente vía `MARKET.responsiveness × gap`.
- **AI miope de tiempo**: `src/systems/AI.js` `pickBestProducible` decide qué plantar usando `state.market.prices?.[countryId]?.[def.id]` (precio spot). Para crops de 730 días, el precio spot de hoy no tiene relación con el precio que va a haber cuando el árbol produzca. Y no mira cuántos otros AIs ya plantaron lo mismo — entran en estampida sobre la misma decisión.

### Fix 1: Storage gradual con costo (rompe el dump)

**Cambiar `autoHarvest` para AI**: en vez de `sellToMarket` directo, depositar en `ai.inventory[crop]` (igual que ya hace para el player). El revenue NO entra al cash del AI hasta que efectivamente venda.

**Nuevo `aiTrySellInventory(state, ai)` (mensual o cada 5 días)**:
- Para cada producible en `ai.inventory`:
  - Computar `targetPrice = priceMA(60d) × sellThreshold` (ej. `sellThreshold = 0.95`).
  - Si `currentPrice >= targetPrice`: vender hasta `sellRate × stockpile` (ej. `sellRate = 0.10`, vende 10% por tick).
  - Si `currentPrice < targetPrice`: no vende — guarda esperando recuperación.
- Esto distribuye la oferta en lugar de concentrarla. El precio no se desploma.

**Storage cost mensual** (`aiPayStorageCost`):
- Por cada unidad guardada: `STORAGE.unitCostPerMonth` (ej. $0.5–$1) → wageFund (warehouse labor).
- Hace que guardar indefinido sea costoso. AI tiene incentivo a vender cuando el precio es razonable, no esperar a la luna.
- Player paga lo mismo en su `state.player.inventory` — coherente.

**Calibración**:
- `sellThreshold = 0.92` (vende cuando price ≥ 92% de MA60d, suficientemente cerca del techo).
- `sellRate = 0.15` (15% del stock por tick).
- `STORAGE.unitCostPerMonth = 1` (alto para crops baratos como papa, despreciable para gold).

### Fix 2: AI con visión de pipeline (rompe la estampida de plantaciones)

**Track "pipeline" por producible por país**: cuántos tiles plantados están en proceso, ponderados por madurez restante.

```
pipelineSupply(state, cid, pid) =
  Σ tiles donde tile.crop === pid && tile.state === 'planted'
    of (yieldUnits × (1 - growth)) / growthDays
```

Esto es "supply pendiente que va a llegar pronto" en unidades/día equivalente.

**Nuevo helper `expectedPriceAt(state, cid, pid, daysAhead)`** en `Market.js`:
- Usar MA60-90d como base (no spot).
- Restar: `pipelineSupply × daysAhead` ajustado contra consumption.
- Penalizar si pipeline > consumption × buffer.

**`pickBestProducible` modificado**:
- Reemplazar `state.market.prices?.[countryId]?.[def.id]` por `expectedPriceAt(state, countryId, def.id, def.growthDays)` — el precio que **se espera** cuando esto madure, no el de hoy.
- Para perennials con growthDays = 730, la decisión usa el precio estimado a 2 años, no el de mañana. Esto solo evita la estampida.

**Ranking adicional** (anti-glut):
- Score base: `(expectedPrice × yield - costs) / growthDays`.
- Aplicar penalty si `recentPlantings(state, cid, pid, days=growthDays/2) > N` — muchos AIs ya plantaron lo mismo, va a haber glut.
- O usar `pipelineSupply / consumption` directamente como factor de descuento (>1 = sobreoferta esperada).

### Files afectados (estimación)

| Archivo | Cambio |
|---|---|
| `src/systems/Farming.js` | `autoHarvest` AI deposita en inventory en vez de vender |
| `src/systems/AI.js` | Nuevo `aiTrySellInventory`, `aiPayStorageCost`. `pickBestProducible` usa `expectedPriceAt` |
| `src/systems/Market.js` | Nuevo `expectedPriceAt(state, cid, pid, daysAhead)`, helper `pipelineSupplyFor` |
| `src/data/tunables.js` | `STORAGE.unitCostPerMonth`, `AI.sellThreshold`, `AI.sellRate`, `AI.priceLookbackForBuild` |
| `src/scenes/Game.js` | (Opcional) Mostrar storage cost en panel del jugador, si tiene inventario |

### Verificación
1. **Sin cobweb**: speed ×8 por 5+ años, mirar el sparkline de manzana en country chart. Debería ser onda suave, no diente de sierra.
2. **AI no estampida**: mirar `aiDecisionLog`, debería mostrar `'considered: apple expectedPrice $80 (vs spot $250) — too much pipeline'` cuando hay glut entrante.
3. **Storage cost duele**: stock de 100 unidades de manzana × $1/mes × 12 meses = $1200/año. Mejor vender cuando precio ≥ MA × 0.92 que esperar y pagar.
4. **Player ve el costo**: panel muestra "Storage: 50u apple → $50/mo" si tiene inventario considerable.

### Riesgos / decisiones abiertas
- **Cold start**: `priceMA(60d)` necesita historia. Primeros 60 días el comportamiento puede ser raro. Solución: inicializar history con `basePrice` en `initMarket` (ya lo hace).
- **Storage de player**: cobrarle al player también o solo a AI? Por consistencia debería ser igual, pero puede frustrarlo en early game si tiene inventario sin querer.
- **Pipeline tracking**: hacerlo on-the-fly (recorrer tiles) vs incremental (state.production[cid][pid] mantenido). On-the-fly es O(tiles × producibles) — para 5 países × 196 tiles × 14 producibles = 14k checks por query, aceptable si solo se llama 1-2× por día.
- **Inventory del AI puede crecer infinito** si nunca llega al sellThreshold. Solución: hard cap por unidad (ej. 30 días de demand local). Pasado eso, dump aunque el precio esté mal.

---

## [ ] Reemplazar arbitraje automático por exportadoras

### Problema
La población de cada país solo compra de su **inventario local** al **precio local** (ver `src/systems/Population.js` `populationSpend`). No hay shopping global del consumidor.

El único mecanismo que mueve bienes entre países es el arbitraje automático en `src/systems/Market.js` `tickMarket()` (líneas ~135-169). Ese arbitraje:
- Es **instantáneo** (irreal — los bienes deberían tardar en cruzar océanos).
- Se gatea por **escasez de stock local** (`if (dstInv >= dstTarget) continue;`), no por **margen de precio**.

Consecuencia: si un país tiene producción local que cubre su consumo y el stock alcanza el target, nadie importa aunque el extranjero esté 5× más barato. La población local paga el precio caro local indefinidamente. **La ley del precio único (gap ≤ transporte) no se cumple cuando un país está auto-abastecido.**

### Dirección
**Crear "exportadoras" — empresas dedicadas al arbitraje, paralelas a las industries actuales.**

Loop de una exportadora:
1. Detecta diferencial de precio: compra en A a $X, vende en B a $Y, donde $Y − $X − transporte > margen mínimo.
2. **Compra** stock en A (paga cash, recibe inventario, `marketPool` de A recibe el cash).
3. **Embarca** — tarda *N días* en llegar a B (no instantáneo). Inventario en tránsito.
4. **Vende** en B vía `executeTransaction` normal — paga import tax en destino.

Estructura sugerida:
```
state.exporters = [{
  id, ownerId, homeCountryId, cash,
  inFlight: [{ srcCid, dstCid, pid, units, etaDay, costPaid }],
  policyTunables: { minMarginPct, maxCapitalPerTrip, ... }
}]
```

Beneficios:
- La ley del precio único emerge de la actividad de las exportadoras, no de un loop hardcodeado.
- Player puede ser exportador y competir contra AIs.
- Modelo económicamente más rico: una exportadora puede quebrar si el precio destino se desploma durante el viaje.

### Sub-tareas

- [ ] **Eliminar arbitraje instantáneo**: bloque en `src/systems/Market.js:135-169` y prune de `state.tradeFlows`/`tradeFlowVolume` en `Market.js`. Estos pasan a derivarse de la actividad de exportadoras.
- [ ] **Nuevo módulo** `src/systems/Exporters.js`: lifecycle, tick diario (decisiones, embarques, llegadas), AI policy.
- [ ] **Nuevo registry** `src/data/exporters.js` o tunables en `data/tunables.js`: nombres base, márgenes, tiempos de tránsito (`etaDays = DISTANCES[src][dst] × N`).
- [ ] **State init** `src/state/GameState.js`: agregar `state.exporters = []`.
- [ ] **WorldSeed**: sembrar 1–3 exportadoras AI por país para que el mundo arranque con flujos (sin esto, los precios divergen al infinito mientras nadie comercia).
- [ ] **UI**: nueva vista "Exporters" en top bar (o integrarlas dentro del modal Companies como un tipo más). World modal debería poder dibujar cargamentos en tránsito (animados, opcional).
- [ ] **Player path**: comprar/financiar exportadoras, configurar políticas (producible, capital por viaje, margen mínimo).

### Riesgos / decisiones abiertas

- **Bootstrap**: con 0 exportadoras, los precios divergen sin límite. La siembra inicial es crítica.
- **Quiebra**: una exportadora que apuesta mal queda sin cash. ¿Reaparece? ¿Otro AI compra los activos?
- **Aranceles**: hoy el `import` tax aplica solo cuando el comprador es real. Con exportadoras como compradoras, el import tax aplica cuando ELLA compra en destino — más realista.
- **Saturated market**: si una exportadora intenta vender pero `marketPool` destino está seca → `ok: false`. ¿Se queda con stock y vuelve? ¿Malvende a precio menor?
- **Transparencia para el player**: necesita ver precios mundiales para decidir cargamentos. Ya lo cubre el Market modal con tabs por país.

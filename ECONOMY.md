# Reglas económicas de la simulación

> **Este documento es de REGLAS económicas, no de código.** Describe el COMPORTAMIENTO del sistema en lenguaje humano: qué decide cada actor, qué desencadena qué, y por qué los precios suben o bajan. No hay extractos de código a propósito — la idea es que cualquiera (diseñador, programador, tester) pueda entender la economía sin abrir un solo archivo `.js`.
>
> Si lees el código y dudas, este doc es la referencia de "intención de diseño". Si el código contradice este doc, hay un bug — o bien hay que actualizar el doc, o bien arreglar el código.
>
> **Hay un hook configurado** (`.claude/settings.json`) que, después de cualquier edición de archivos en `src/systems/` o `src/data/`, le recuerda a Claude evaluar si ese cambio afecta reglas económicas documentadas acá y actualizar este archivo si corresponde.

---

## 1. Los actores

El mundo se divide en **5 países** (Home, Riverside/usa, Oakdale/china, Pinegrove/brazil, Hillcrest/germany). Cada país es semánticamente un pueblo o pequeña región, no una nación entera. Todos arrancan con la misma configuración base (1000 habitantes, mismas reglas).

Dentro de cada país conviven varios tipos de actores:

- **La población** del pueblo. No es un actor individual sino una entidad agregada que compra comida cada día.
- **AI farmers**: 4 por país. Son los productores agrarios y mineros. Tienen plata, son dueños de tierras, cosechan y venden.
- **El player**: vos. Arranca con 1 tile en Home, sin plata. Toma decisiones manuales.
- **AI exportadores**: 2 por país. Son traders. No producen ni consumen: compran en un país y venden en otro. Mueven cargas con un retraso de tránsito.
- **El gobierno del país**: existe como tres bolsas de plata sin agente que decida — `treasury`, `wageFund`, `marketPool`. Más sobre ellas en la sección 3.
- **El banco**: dispone préstamos. No tiene plata propia (los préstamos crean plata; las cuotas la "destruyen" — más detalle en sección 8).

---

## 2. Producción de alimento

### 2.1 Los cultivos disponibles

Hay 5 cultivos base, cada uno con su carácter:

- **Trigo** (annual): ciclo corto (~90 días), rinde unas 8 unidades por cosecha.
- **Maíz** (annual): ciclo medio (~150 días), rinde ~11.
- **Papa** (annual): ciclo rápido (~70 días), rinde ~12.
- **Manzano** (perennial): árbol que vive ~12 años, rinde ~33 manzanas por cosecha anual.
- **Cerezo** (perennial): vive ~10 años, rinde ~24 cerezas por cosecha anual.

Cada cultivo tiene un **precio base** (lo que "debería" costar en equilibrio), una **curva de crecimiento** que depende de la calidad del tile, y un **costo de labor** para cosechar (medido en worker-months, que se convierten a plata multiplicando por el salario del país).

### 2.2 El ciclo de un tile agrícola

Un tile cultivable pasa por estos estados:

1. **Wild** (sin dueño, sin trabajar).
2. **Fallow** (alguien lo compró pero todavía no plantó nada).
3. **Plowed** (arado, listo para plantar — paga un costo de labor de arado).
4. **Planted** (con cultivo joven, growth=0 al 100%, avanza día por día).
5. **Mature** (cuando growth llega a 100%, listo para cosechar).
6. **Cosechado** (sólo para perennials — el árbol sigue ahí, regenera fruta en N días). En annuals la cosecha vuelve al estado fallow para replantar.

El crecimiento diario depende de la **calidad del tile** (entre 0.2 y 1.0, asignado al generar el mapa con semilla random) y de **modificadores ambientales** de eventos (sequía, helada, etc).

### 2.3 Cosechar tiene un costo

Cosechar no es gratis. Tiene un **costo de labor en plata** (worker-months × wage del país). Si el AI o el player ven que el precio de mercado está tan bajo que la cosecha rinde menos que ese costo más un margen de seguridad (5%), **deciden no cosechar**. El tile queda maduro esperando que el precio suba.

Si nadie cosecha y pasan más de 30 días, el cultivo se pudre:
- Annual: vuelve a fallow (se pierde la cosecha).
- Perennial: vuelve a cosechado sin fruto (el árbol sobrevive, se pierde sólo este ciclo).

---

## 3. La población y su plata

### 3.1 De dónde sale la plata para comer

La población **no tiene plata propia**. En su lugar, el país tiene una bolsa colectiva llamada **wageFund** — pensala como la suma de todos los sueldos disponibles para comer ese día. De ahí sale el presupuesto diario para comprar comida.

El `wageFund` se llena por **tres fuentes**:

1. **Salarios de industrias**: cuando una fábrica está operativa, cada fin de mes paga un salario (workforce × wage del país). Ese dinero sale del dueño de la fábrica (AI o player) y entra al wageFund del país donde está la fábrica.
2. **Salarios de minas**: las minas operativas pagan un costo mensual al wageFund, mismo mecanismo.
3. **Welfare (subsidio de emergencia)**: si el wageFund cae por debajo de un piso muy bajo (~2 días de comida del país), el `treasury` (otra bolsa, la "caja del Estado") inyecta plata. Es un seguro para que la gente no muera de hambre instantáneamente cuando no hay industrias.

### 3.2 De dónde sale la plata del treasury

El **treasury** es la caja del gobierno del país. Se llena con:

- **Impuestos de venta** (cuando la población compra comida → un % va al treasury).
- **Impuestos B2B** (cuando un AI farmer vende al mayorista, otro % al treasury).
- **Impuestos de importación** (cuando un exportador entrega mercadería extranjera, otro %).

Se vacía por:

- **Welfare**: rellenar el wageFund cuando cae.
- **No tiene gastos discrecionales** (no construye, no contrata) — sólo es el "buffer fiscal" del país.

Si el treasury queda negativo varios meses seguidos, se activa la **crisis fiscal** (sección 9).

### 3.3 De dónde sale la plata del marketPool

El **marketPool** es la "caja registradora del mayorista". El mayorista no es un actor con decisiones: es una caja + una góndola. Cobra plata cuando le venden cosas (de productores), paga plata cuando le compran cosas (la población, otras industrias, exportadores). La sección 5 cubre cómo funciona en detalle.

### 3.4 ¿Cuándo compra la población?

**Una vez por día**, sin falta. No hay condiciones que la paren — siempre intenta comprar comida con el `wageFund` disponible. Lo único que la limita es si la góndola del mayorista está vacía: no se puede comprar lo que no existe.

### 3.5 ¿Cuánto compra?

Hay un **objetivo nutricional diario**: cada persona "necesita" 0.1 unidades de nutrición para sobrevivir, y aspira a un 20% extra para "vivir bien". Eso da un target de `población × 0.1 × 1.2` unidades de nutrición por día (para 1000 habitantes son 120 unidades de nutrición).

La población deja de comprar cuando llega a ese target. No se atraganta. Si sobra wageFund después de comprar lo necesario, queda en la bolsa para mañana.

Si en cambio el budget no alcanza, compra lo que pueda y pasa hambre. El motor no modela esta hambre explícitamente — sólo se refleja en que se compró menos.

### 3.6 ¿Qué eligen comprar?

Hay 8 candidatos posibles (los foods: trigo, maíz, papa, manzana, cereza, harina, jugo, pie — aunque actualmente sólo trigo/maíz/papa/manzana/cereza/harina existen).

Para cada uno, la población calcula un **"score"** que combina tres cosas:

- **Preferencia base** del país por ese food (Home prefiere papa, China prefiere manzana, etc — definido en `TOWN_BASELINE.preferences`).
- **Valor nutricional** del food (cada unidad de wheat aporta 1.2 de nutrición, una papa aporta 0.7, etc).
- **Precio actual** en la góndola del mayorista. A mayor precio, peor score.

Concretamente: **score = preferencia × nutrición ÷ precio**. Esto representa "cuán buena es esta opción combinando lo que me gusta, lo que me llena y lo que cuesta".

Después la población **reparte su budget proporcionalmente al score**. Si trigo tiene score 5 y manzana score 2, trigo se lleva 5/7 del presupuesto y manzana 2/7.

Esto produce **sustitución natural**: si trigo se pone carísimo, su score baja, la población migra a comprar más manzana y papa automáticamente. No hay reglas explícitas de diversidad — emerge del balance.

### 3.7 ¿Cómo crece o decrece la población?

El crecimiento poblacional se calcula **una vez al año** y depende del consumo real de nutrición observado en los últimos 90 días. La población es testigo objetivo de su propio bienestar.

Cada persona tiene dos umbrales:
- **Supervivencia**: cada habitante necesita al menos `nutritionPerCapita` unidades de nutrición por día (hoy 0.1).
- **Vivir bien**: con un 20% extra encima de supervivencia, la gente está cómoda.

El motor mira el promedio diario de nutrición que la población efectivamente compró y la compara contra esos dos umbrales:

| Estado | Condición | Efecto en la población |
|---|---|---|
| **Sobrada** | nutrición consumida ≥ pop × 0.12 (well-being) | Crece al ritmo base del país (~1%/año) |
| **Justa** | entre survival (0.10) y well-being (0.12) | Crece interpolando linealmente entre 0% y el ritmo base |
| **Hambruna parcial** | menor a survival pero > 0 | Decrece proporcional al déficit (hasta −5%/año en hambruna total) |
| **Cero comida** | nutrición = 0 | Decrece al máximo (−5%/año) |

Se suma un ruido aleatorio chico (±0.5%) por encima del rate calculado, así no es perfectamente determinístico. La población **nunca cae bajo 1 habitante** — el motor preserva al menos uno aunque la hambruna sea brutal (evita división por cero en otros cálculos).

Cuando la población cambia, las `consumption` baseline del país se reescalan proporcionalmente — más gente come más, menos gente come menos. Esto afecta tanto al target dinámico (sección 6.2) como a los pesos del basket de priceIndex.

**Implicancia económica**: este loop convierte la oferta agraria en una restricción dura del crecimiento. Si una región nunca consigue alimentar a sus 1000 habitantes, el equilibrio natural es que la población caiga hasta lo que la agricultura local + importaciones puedan sostener. Es señal sin caps — un país con economía agraria fuerte crece, uno con economía pobre se vacía.

---

## 4. Los AI farmers — cómo deciden producir

### 4.1 Qué tienen al arrancar

Cada AI farmer empieza con:
- Cierta cantidad de plata ($6000).
- 1 tile asignado al inicio.
- Cooldown de 5 días entre decisiones grandes.

Durante el seed inicial del mundo, cada AI farmer recibe además 1 tile sembrado con cada cultivo, en estado maduro (para que la primera cosecha caiga apenas arranca el juego). Las minas y las industrias **no se siembran** — el mundo arranca como una economía puramente agraria.

### 4.2 Comprar tierras

Cada cierto número de días, un AI farmer chequea si:
- Tiene cash suficiente (> $5000 después de la compra).
- Hay tiles wild disponibles cerca.
- El "venture" que pondría en ese tile rinde positivo.

Si sí, compra. Si no, espera.

### 4.3 Decidir qué venture poner en un tile

Cuando un AI farmer tiene un tile fallow, evalúa **todos los ventures posibles** (cada cultivo + minería si el tile tiene depósito surveyed + industrias si está en halo de ciudad). Para cada uno calcula el **margen mensual esperado**:

- **Para cultivos**: usa una predicción del precio en `growthDays` días (no el precio de hoy — sabe que cosecha en el futuro). Predice considerando cuánta presión de oferta hay en la pipeline.
- **Para minería**: precio actual del mineral × yield mensual − costo mensual de operación.
- **Para industrias**: precio promedio 30 días del output × cantidad − precio promedio inputs × cantidad − salario mensual.

Elige el venture con el **margen más alto**. Si todos son negativos, no hace nada y espera al próximo ciclo.

### 4.4 Decidir cosechar

Es automático cuando un tile madura, **pero hay un filtro de rentabilidad**: la cosecha sólo se ejecuta si el precio actual cubre el costo de labor con al menos 5% de margen. Si no, el AI deja el tile maduro esperando.

Si lo deja más de 30 días sin cosechar, el cultivo se pudre (annual) o cae a cosechado sin fruta (perennial).

### 4.5 ¿Cuándo replantan?

Después de cosechar:
- **Perennials** se regeneran solos (estado cosechado → mature otra vez después de regrowDays).
- **Annuals**: si el tile tiene `autoMode = true`, intenta auto-replantar el mismo cultivo. Si falla (sin cash), queda fallow y se reintenta el próximo tick.

Los tiles de AI farmer arrancan con `autoMode = true` por seed, así el ciclo cosechar-replantar se sostiene solo.

### 4.6 ¿Cuándo cierran/uprooten un cultivo perennial?

Si un perennial es "skipeado" (no cosechado por baja rentabilidad) o se cosecha a pérdida varios ciclos seguidos, el AI lo uproot (limpia el árbol) para liberar el tile a algo más rentable.

### 4.7 ¿Cómo deciden vender lo que tienen en inventario?

Una vez cosechado, el output no se vende de golpe. Cada día, el AI farmer evalúa cada producto que tiene en stock y decide qué porcentaje sacar a la venta. **El rate de venta es dinámico** y combina dos señales independientes:

- **Señal de precio** (¿es buen momento para vender?): compara el precio actual contra el promedio móvil de 60 días. Si está alto vs su histórico, es oportunidad — vende más. Si está bajo, vende menos pero algo (mantener cash flow). El multiplicador queda acotado entre 0.2× (precio muy bajo) y 2.5× (boom).
- **Señal de stock** (¿cuánto me está pesando el inventario?): mide el stock acumulado vs el "cap" del país (que es `consumption × inventoryCapDays`). Cuando el stock supera el 50% del cap, la presión empieza a acelerar la venta. Sin tope: más acumulado = más urgencia (porque el storage cost mensual come la rentabilidad).

El rate efectivo es **rate_base × multiplicador_precio × presión_stock**. Por ejemplo, si la base es 15% mensual:
- Precio en línea con MA, stock al 50% del cap → 15% × 1.0 × 1.0 = **15%/intento** (neutral).
- Precio 1.5× MA, stock 80% del cap → 15% × 1.5 × 1.3 = **29%/intento** (vendiendo rápido).
- Precio 0.3× MA, stock bajo → 15% × 0.3 × 1.0 = **4.5%/intento** (hoardea esperando recuperación).

**Override de seguridad**: si el stock supera el cap absoluto, se descarga el exceso sin importar el precio (fire-sale). Esto evita acumulación infinita cuando los precios nunca se recuperan.

---

## 5. El mayorista — cómo "compra" y "vende"

### 5.1 El mayorista no es un actor inteligente

El mayorista del país son **dos campos en el estado**: `marketPool` (la plata que tiene) y `market.inventory[país][producto]` (la góndola que tiene de cada producto). No toma decisiones discrecionales. Es un intermediario pasivo que:

- **Acepta cualquier venta** que le ofrezcan, siempre que su `marketPool` tenga plata para pagar el monto pedido (precio spot × unidades × (1+impuesto)).
- **Provee cualquier compra** que le pidan, siempre que su góndola tenga stock.

Si la caja está seca, rechaza ofertas. Si el stock está en cero, rechaza compras. No hay heurísticas más allá.

### 5.2 Cómo se llena la góndola

Cuando un agente (AI farmer, industria, exportador) vende al mayorista, la transferencia de stock es **atómica**: las unidades salen del wallet del vendedor y entran a la góndola del país en la misma operación. No hay lag entre "vendió" y "está en la góndola" — la población puede comprarlo el mismo día.

En paralelo, esa venta se registra en un counter del día (`supplyToday`) que alimenta la rotación a `supplyHistory` (90 días), el target dinámico, la UI del modal del país y el price-freeze check. Pero `supplyToday` es **señal**, no pipeline: el stock ya fue transferido cuando se grabó el counter.

Lo mismo aplica para los exportadores entregando un cargo en destino y para los write-offs (cuando una entrega no puede cobrarse, las unidades se donan a la góndola del destino sin pago — pero el movimiento sigue siendo atómico).

### 5.3 Cómo se vacía la góndola

Por las compras reales:
- La población compra comida cada día.
- Las industrias compran sus inputs mensualmente.
- El player compra desde la UI del Market.
- Los exportadores compran para llevar a otros países.

Cada una de estas compras decrementa el stock del mayorista de forma directa.

---

## 6. Cómo se mueven los precios

### 6.1 La fórmula del gap

Cada día, para cada producto en cada país, el motor mira:

- **`inv`**: cuántas unidades tiene la góndola.
- **`target`**: cuántas unidades "querría" tener la góndola.

Calcula el **gap**: cuánto le falta para llegar al target, expresado como porcentaje.

- Si la góndola está al 50% del target, gap = +0.5 → el precio sube ~2% ese día.
- Si está al 100% (en línea con target), gap = 0 → el precio sólo oscila con ruido (±0.5%).
- Si está al 200% del target (sobra mucho), gap = -1.0 → el precio baja ~4% ese día.

La "sensibilidad" de esta respuesta es el `MARKET.responsiveness` (4% por unidad de gap). No hay tope superior — el precio puede subir indefinidamente si la escasez se sostiene. Sí hay un piso muy bajo (`absoluteMinPrice = $0.50`) para evitar precios negativos.

### 6.2 ¿De dónde sale el target?

El target **no es estático**. Se recalcula cada día mirando **cuántas unidades se consumieron en promedio durante los últimos 90 días** y multiplicando por 30 (un mes de buffer).

Esto significa que:
- Si la población compra mucho trigo, el target del trigo sube → el motor "espera" tener más stock en góndola.
- Si nadie compra cable en 90 días, el target del cable cae a 20 (el piso mínimo) → cualquier stock mayor a 20 cuenta como saturación y baja el precio.

Es **autorreferencial**: el target sigue al flujo real, no a un número impuesto por el diseñador.

### 6.3 Freeze del precio en items extintos

Si un producto está en góndola = 0 Y no se vendió hoy, el motor **congela su precio**. Sin esto, el gap diría "escasez total" para algo que nadie produce ni quiere — el precio subiría al infinito sin información real para anclarlo. Cuando alguien vuelve a producir o aparece stock, el precio retoma su evolución normal.

### 6.4 Saturation decay

Si las ventas al mayorista fallan varios días seguidos por falta de plata en el `marketPool`, el motor empuja el precio hacia abajo gradualmente (hasta 4% extra por día). Es una presión adicional sobre el gap normal para acelerar el reseteo.

### 6.5 Ruido

Cada día se agrega un ruido aleatorio chico (±0.5%) al cambio de precio. Esto evita que los precios se queden perfectamente planos y simula la "fricción" del mercado real.

---

## 7. Costos de operación y storage

### 7.1 Costos de labor

Casi todo lo que requiere "personas" — arar, plantar, cosechar, operar una mina, operar una industria — se computa en **worker-months** y se convierte a plata multiplicando por el `wageRate` del país. Ese wage no es fijo: emerge de la oferta y demanda laboral del país (sección 7.2).

Esto significa que **producir en un país con wage alto cuesta más**. Si Home tiene wage $50 y China tiene wage $20, el mismo cultivo en China cuesta 60% menos en costo de cosecha.

### 7.2 Cómo se forma el wage

El `wageRate` de cada país se recalcula mensualmente. Mira dos cosas:

- **Oferta laboral**: una fracción de la población (50%) es trabajadora.
- **Demanda laboral**: suma de workforce de industrias operativas + labor mensual de minas + labor de mantenimiento de cada tile con cultivo en cultivación.

Si la demanda supera la oferta, hay "tightness" y los wages suben. Si la oferta supera la demanda, los wages bajan.

La respuesta es **sub-lineal** (raíz cuadrada del ratio) — los wages responden suave a desbalances grandes. Eso es elasticidad, no un cap.

**El wage NO depende del precio de la comida (priceIndex)**. Esto es intencional: si los wages chasearan al priceIndex, una suba de comida dispararía suba de wages → suba de costos → suba de precios → espiral. Manteniendo los wages atados sólo a labor, el sistema rompe ese loop.

### 7.3 Storage cost

Tener inventario en cualquier wallet (AI, player, exportador) cuesta **alquiler de bodega**, cobrado mensualmente. Es proporcional a las unidades stockeadas × wage del país. Es un incentivo para **no acumular eternamente** — vender el stock antes de que el storage te coma la rentabilidad.

---

## 8. El banco y los préstamos

Hay tres productos de préstamo:

1. **Land Financing** (7% anual): para comprar tierras grandes. Tasa baja.
2. **Mortgage** (11% anual): general purpose, tasa media.
3. **Working Capital** (22% anual): emergencias, tasa alta.

Cada uno tiene un monto máximo en función del valor de los assets del prestatario. Los AI farmers piden working capital cuando su cash cae por debajo de un threshold (~$500).

El banco no tiene caja propia. Cuando otorga un préstamo, **crea plata fiat** (el wallet del prestatario sube). Cuando cobra cuotas, **destruye plata** (la cuota sale del wallet del prestatario y no entra en ninguna otra bolsa).

Si el prestatario no puede pagar, las cuotas se acumulan como "missed". Después de 3 missed consecutivos, el banco **embarga** assets — toma uno de los tiles del prestatario y lo vende en un remate (precio entre 70-80% del valor de mercado).

---

## 9. La crisis fiscal

Cuando el `treasury` de un país queda **negativo durante 3 meses consecutivos**, se activa la crisis. Mientras dura:

- **Impuestos suben** gradualmente (cada mes adicional sin recuperar, los rates aumentan).
- **Preferencias de la población se "aplastan"**: la gente deja de poder permitirse food premium (manzana, cereza). Se concentra en lo básico (trigo, papa).
- **Salarios pagan menos al wageFund**: las industrias siguen pagando, pero parte de ese pago no llega — es un "haircut" que se evapora (simula que los empleados aceptan parte en deuda fiscal o similar).

La crisis se desactiva cuando el treasury vuelve a positivo durante 6 meses consecutivos. Es asimétrica a propósito: entrar en crisis es relativamente fácil, salir requiere persistencia.

---

## 10. Los exportadores — comercio entre países

### 10.1 Qué son

Son **agentes traders** con plata propia y cero producción. Vienen anchored a un país (su `homeCountryId`) y sólo manejan rutas que tocan ese país (`anchoredCountry ↔ X`). No hacen "triangulación" entre dos países que no sean su base.

### 10.2 Cómo deciden un viaje

Constantemente buscan rutas donde el precio del destino es significativamente más alto que el del origen, menos transporte. Concretamente, sólo arrancan un viaje si el margen esperado supera 10% del precio del destino.

### 10.3 El viaje físico

Al iniciar el viaje:
1. **Compran en el origen** al precio spot. La plata sale del exportador y entra al `marketPool` del país origen. La mercancía sale de la góndola del origen.
2. **Pagan el transporte** (un costo fijo por unidad × distancia). Esto es un "sink" — la plata se evapora (no entra a ningún otro wallet).
3. **El cargo entra en `inFlight`** con una fecha estimada de llegada (`etaDay`).

### 10.4 Al llegar al destino

El exportador intenta vender al precio spot del destino. Tres caminos posibles:

1. **Venta normal**: el `marketPool` del destino tiene plata para pagar → todo bien, el exportador gana margen.
2. **Fire-sale**: el pool destino no tiene suficiente para el spot. El exportador re-precia el cargo a lo que el pool puede pagar (incluso si pierde plata) y vende. Mejor algo que nada.
3. **Write-off**: el pool destino está completamente en cero. El exportador **dona** la mercancía al mayorista del destino — la góndola gana stock, el exportador come la pérdida total.

En las tres rutas, las unidades **terminan en la góndola del destino**, sólo varía cuánta plata recibió el exportador.

### 10.5 ¿Por qué importa esto?

Sin exportadores, cada país sería un mercado aislado. Con exportadores, los precios entre países tienden a equilibrarse (los traders arbitran las diferencias). También exponen demanda fantasma — un exportador comprando wheat en Home para llevar a China **cuenta como demanda real en Home** (registrada como "export"), lo que sube el target de wheat en Home y empuja sus precios.

---

## 11. Las industrias

### 11.1 ¿Qué hace una industria?

Convierte **inputs** (productos) en **outputs** (otros productos), cada `cycleDays` días. Por ejemplo:
- **Flour Mill**: 3 maíz → 1 harina cada 7 días.
- **Mechanical Parts Factory**: 4 hierro → 1 mechanical part cada 10 días.
- **Electrical Parts Factory**: 2 cobre → 1 electrical part cada 10 días.

Construir una industria cuesta plata upfront (entre $6000 y $9000), tarda ~90 días en estar operativa, y emplea entre 16 y 30 workers que demandan salario mensual.

### 11.2 ¿Cuándo construye un AI farmer una industria?

Cuando evalúa ventures sobre un tile que está en halo de una ciudad. Si el margen mensual esperado (revenue de output − cost de inputs − salario) supera el threshold, construye.

### 11.3 Operación

Cada ciclo, la industria:
1. Necesita inputs en el inventario del dueño. Si no los tiene, queda **idle** y se reintenta el próximo tick.
2. Si los tiene, los consume y produce los outputs en el mismo inventario del dueño.
3. Mensualmente: paga el salario al wageFund del país. Si el dueño no puede pagar, la industria se cierra.

El dueño después vende los outputs al mayorista (vía el rail canónico, igual que un AI farmer vendiendo su cosecha).

### 11.4 Top-up automático de inputs

Una vez por mes, los AI dueños chequean si sus industrias tienen inputs suficientes para los próximos 10 ciclos. Si no, compran del mayorista local (vía `buyFromGlobal`).

### 11.5 Cierre y reapertura

- Si el margen móvil de 90 días es muy negativo, el AI **cierra** la industria.
- Después de un cooldown de 60 días, evalúa reabrir. Si el margen de los últimos 14 días recuperó, reabre (paga un costo descontado vs construir desde cero).

### 11.6 Productos sin consumidor

Algunos outputs industriales (mechanical part, electrical part) **no tienen consumidor real** — ningún otro sistema los compra. Eso significa que su stock crece sin freno cada vez que la industria produce y vende. El motor responde:
- Target dinámico cae al piso de 20 (nadie los compra en los últimos 90 días).
- Stock acumula → gap se vuelve negativo → precio cae.
- Margen mensual de la industria se hunde → el AI la cierra.

Es comportamiento emergente: las industrias sin demanda real **mueren naturalmente**.

---

## 12. Eventos del mundo

De vez en cuando (probabilidad diaria ~1.2%, máx 2 concurrentes), pasa un evento aleatorio:

- **Sequía**: reduce el growth multiplier — los cultivos crecen más lento durante la duración.
- **Helada**: idem, más agresivo.
- **Boom de demanda** (por food específico): aumenta la consumption baseline de ese food en uno o varios países.
- **Crisis de oferta**: lo contrario.

Los eventos tienen duración limitada (e.g., 30-90 días). Al terminar, los efectos revierten.

---

## 13. Los flujos de dinero — visión completa

Si pensamos toda la plata del mundo como un sistema cerrado, las fuentes y los sinks son:

**Fuentes que crean plata** (la plata aparece):
- Banco otorgando préstamos.
- Seed inicial al crear el mundo (cada wallet, treasury, marketPool y wageFund se inicializan con plata "de la nada").

**Sinks que destruyen plata** (la plata desaparece):
- Cuotas de préstamo (no van a ningún otro wallet).
- Transporte de exportadores (cada unidad-distancia es un costo evaporado).
- Storage cost (las units que se almacenan generan un cobro que va... al wageFund. Así que técnicamente no es un sink — es una redistribución).

**Flujos entre wallets** (no crean ni destruyen, sólo mueven):
- Venta de un productor al mayorista: marketPool → wallet productor + treasury (impuesto).
- Compra de la población: wageFund → marketPool + treasury (impuesto).
- Compra del player o industria: wallet → marketPool + treasury.
- Welfare: treasury → wageFund.
- Salario de industria/mina: wallet dueño → wageFund.

El motor mantiene una identidad: **la suma total de plata del sistema** = `wallets + wageFund + treasury + marketPool`. Sin los sinks (loans, transport), ese total no cambia día a día. Es la conservación de dinero del modelo.

---

## 14. Resumen de cadencias

Para tener clara la "frecuencia con que pasan las cosas":

- **Diario** (cada tick de juego):
  - Crecimiento de cultivos.
  - `populationSpend`: la población compra comida.
  - `tickMarket`: traslada supply real a la góndola, recalcula targets, retasa precios.
  - AI farmers chequean ventas de inventario (drip-sell).
  - AI farmers ejecutan decisiones (cada `decisionEveryDays = 5` por farmer, escalonado).
  - Exportadores avanzan in-flight y settle arrivals.
  - Eventos del mundo se evalúan (probabilidad chica diaria).
- **Mensual**:
  - Industrias pagan salarios.
  - Mineros pagan costos operativos.
  - Storage cost se cobra.
  - WageRate se actualiza vía EMA.
  - Bancos cobran cuotas.
  - State machine de crisis fiscal.
  - AI evalúa cerrar/reabrir industrias y top-up de inputs.
- **Anual**:
  - Crecimiento poblacional (depende de la nutrición — ver sección 3.7).
  - Consumption baselines se reescalan con la nueva población.
  - Ciudad crece (aumenta su radio, más tiles entran al halo).

---

## 15. Decisiones de diseño explícitas

Algunas cosas que el sistema **NO hace a propósito**:

- **No hay caps duros en los precios**: si el sistema diverge, es porque hay un loop roto, no porque "se exceda un techo". El precio puede subir o bajar sin tope (aparte del piso mínimo $0.50). El compromiso es que la fórmula del gap converge en steady-state.
- **Los wages no chasean el priceIndex**: para evitar la espiral salarios-precios. Si la comida sube, los wages no suben automáticamente. Esto es una opinión de diseño: el juego no es sobre inflación clásica.
- **El mayorista no es inteligente**: a propósito. Toda la inteligencia económica vive en los **productores** (qué plantar, cuándo cosechar, cuándo vender) y en los **compradores reales** (qué food preferir según score). El mayorista es plumbing.
- **La población es un agregado, no muchos individuos**: simplifica enormemente la simulación. La preferencia y el score se aplican como una sola entidad.
- **Cada wallet tiene `countryId` o `homeCountryId`**: eso permite categorizar cada transacción como "local" o "cross-country" sin tocar nada más. Single source of truth.
- **Toda venta y compra pasa por funciones canónicas** (`sellFromInventory`, `buyFromGlobal`, `writeOffToMarket`). Cero rutas custom. Si un nuevo tipo de actor entra al sistema, sólo necesita registrar su wallet y usar esas funciones — el tracking de imports/exports y el target dinámico se ajustan solos.

---

## 16. Glosario rápido

| Término | Qué es |
|---|---|
| `wageFund` | Bolsa de plata del país que la población usa para comer cada día. |
| `treasury` | Caja del gobierno del país. Cobra impuestos, paga welfare. |
| `marketPool` | Caja del mayorista del país. Cobra cuando alguien le vende, paga cuando alguien le compra. |
| `marketStock` (`market.inventory`) | Góndola del mayorista. Se llena con supplyToday, se vacía con compras. |
| `supplyToday` | Acumulador del día con todo lo que productores le vendieron al mayorista. Se vacía y se mueve a marketStock al día siguiente. |
| `consumptionDay` | Acumulador del día con todo lo que se compró al mayorista. Alimenta el target dinámico. |
| `consumptionHistory` | Ring buffer de 90 días con la consumption diaria por producto. Define el target. |
| `target` | Cuántas unidades el mayorista "querría" tener en góndola. Se deriva de 30 × promedio diario de consumo de los últimos 90 días. |
| `gap` | (target − inv) ÷ target. Positivo = escasez = precio sube. Negativo = saturación = precio baja. |
| `priceIndex` | EMA del basket de precios vs basePrice. Reflejo de "qué tan inflada está la economía" del país. |
| `wageRate` | Salario en plata por worker-month. Sale del balance oferta/demanda de labor del país. |
| `priceMA` (moving average) | Promedio móvil del precio sobre N días. Lo usan los AI para decisiones que requieren estabilidad (build/close de industrias). |

---

Si encontrás que el código contradice algo de este doc, es muy probable que el doc esté obsoleto (las decisiones evolucionan rápido). Pingueame y actualizamos.

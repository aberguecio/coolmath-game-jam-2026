# Plan — Coolmath Game Jam 2026

> **Pitch**: Sim económico tipo *Capitalism / Patrician* en clave granjero‑inmobiliario. Empezás con un terreno, plantás, cosechás, vendés. El mundo reacciona: la ciudad crece, los AI compiten, los commodities suben y bajan, el banco te presta y te remata.

---

## 1. Visión

- **Núcleo**: simulación de **oferta y demanda** local + global con agentes IA que compiten contigo.
- **Sensación**: empezás chico (1 terreno, deuda con el banco) y escalás a magnate agrícola/inmobiliario/minero.
- **Loop**: comprar → producir → vender → reinvertir → expandir → diversificar.
- **Tensión**: el mercado castiga al monocultivo, recompensa la lectura de tendencias y la diversificación.

---

## 2. Alcance por fases (jam‑first)

### Fase 1 — MVP jugable (objetivo del jam)
1. Mapa top‑down de tiles (grid simple, zoom 1x, pan con WASD/drag).
2. Compra/venta de terrenos con precio que evoluciona con el tiempo.
3. 3 cultivos: **trigo** (anual rápido), **maíz** (anual medio), **manzano** (frutal lento, multi‑cosecha).
4. Ciclo: arar → plantar → regar/podar → cosechar → almacenar → vender.
5. Mercado local con precios dinámicos: tu volumen vendido empuja el precio hacia abajo.
6. Banco simple: 1 préstamo inicial, cuota mensual, intereses, default → embargo.
7. Reloj de juego (1 día = X segundos), pausable, con velocidades x1/x2/x4.
8. HUD: caja, deuda, día, cultivos en curso, próximos pagos.

### Fase 2 — Mundo vivo
9. **Ciudad cercana** con expansión radial por año. Terrenos en el "halo" se rezonifican a residencial.
10. **Loteo**: convertir agrícola → lotes; vender a desarrolladora (precio = f(distancia ciudad, tamaño ciudad)).
11. **Granjeros AI** (3–5 agentes): deciden cultivos según rentabilidad esperada → presionan oferta.
12. **Eventos**: sequía, plaga, helada, boom de demanda.

### Fase 3 — Mercado global
13. **Commodities globales** con países compradores. Cada cultivo expone una cesta de compradores con weight.
14. Choques: "China deja de comprar manzana" → si la cesta dependía de China, caída fuerte; si estaba diversificada, caída suave.
15. **Calidad de tierra** (fertilidad, agua, clima) afectando rendimiento por tile.

### Fase 4 — Verticales adicionales
16. **Minería**: prospección → revelar minerales por tile → extracción (capex alto, ingreso estable).
17. Ganadería (vacas, ovejas) — opcional si hay tiempo.
18. **Reputación** y contratos a futuro (forwards) con compradores.

### Fase 5 — Profundidad financiera
19. Múltiples bancos con tasas distintas, refinanciación.
20. **Remates** públicos cuando un AI quiebra → oportunidad de comprar barato.
21. Bancarrota propia con game‑over o reinicio con handicap.
22. Bolsa simple (acciones de la desarrolladora urbana, etc.).

---

## 3. Game loop (Fase 1)

```
[Día N]
  └─ Tick económico
      ├─ Avanza crecimiento de cultivos (growth += dt * tileQuality)
      ├─ Eventos aleatorios (con prob. baja)
      ├─ AI decide acciones (cada N días)
      ├─ Mercado recalcula precios (oferta vs demanda)
      └─ Banco cobra cuotas si toca día de pago

[Acción del jugador]
  ├─ Click tile → panel: comprar / arar / plantar / cosechar / vender / lotear
  ├─ Botón mercado → ver precios + tendencias (histograma 30 días)
  └─ Botón banco → ver deuda + pedir/pagar
```

---

## 4. Modelo de simulación de precios

Para cada commodity `c` en cada tick:

```
price_c(t+1) = price_c(t) * (1 + α·demand_shock - β·supply_shock + γ·noise)
demand_shock = (globalDemand_c - baseDemand_c) / baseDemand_c
supply_shock = (localSupply_c + aiSupply_c + playerSupply_c - baseSupply_c) / baseSupply_c
```

- **Suavizado**: media móvil para que no oscile como loco.
- **Elasticidad por commodity**: trigo poco elástico, frutas más elásticas.
- **Diversificación**: `globalDemand_c = Σ (countryDemand_i * weight_i)`. Si un país cae, impacto = su weight.
- **Memoria**: AI recuerda precios de los últimos N días → planta lo que estuvo caro → satura el mercado el próximo ciclo (cobweb cycle clásico — emergencia gratis).

---

## 5. Modelo de tierra

Cada `Tile`:
- `id`, `x`, `y`
- `owner` (player | aiId | bank | gov)
- `quality` (fertilidad 0–1, agua 0–1, clima 0–1)
- `zoning` (rural | residencial | industrial | minero)
- `state` (vacío | arado | plantado{crop, growth} | maduro | cosechado | loteado)
- `mineralWealth` (oculto hasta prospectar)
- `distanceToCity` (recalculado cuando la ciudad crece)
- `marketValue` = f(quality, zoning, distanceToCity, demanda)

---

## 6. Modelo de banco

- Préstamo: `principal`, `rate`, `term`, `monthlyPayment`.
- Default: si caja < cuota durante M ciclos → marca de mora → embargo de tiles como colateral.
- Tile rematado entra a un mercado público a precio de tasación * 0.7 (oportunidad para AI/jugador).

---

## 7. Arquitectura técnica (Phaser 3 + Vite)

```
src/
  main.js                  bootstrap (ya existe)
  config.js                tunables: tickRate, mapSize, baseEconomy
  scenes/
    Boot.js
    Preloader.js
    MainMenu.js
    Game.js                escena principal con cámara y mapa
    UIScene.js             HUD overlay (caja, día, botones)
  systems/
    Clock.js               reloj global, velocidad x1/x2/x4
    Economy.js             precios, oferta, demanda, commodities
    World.js               mapa, tiles, ciudad, expansión
    Farming.js             cultivos, growth, cosecha
    AI.js                  granjeros rivales
    Bank.js                préstamos, cuotas, embargos
    Events.js              sequías, plagas, choques globales
  ui/
    TilePanel.js           panel al click de tile
    MarketPanel.js         tabla de precios + sparklines
    BankPanel.js           deuda y pagos
  data/
    crops.js               definiciones de cultivos
    commodities.js         compradores globales por commodity
    tunables.js            constantes balanceables
```

**Patrón**: cada `system` expone `update(dt, state)` y muta un `GameState` central. Renderizado puro vía Phaser desde el state.

---

## 8. UX del mapa

- Grid de 32×24 tiles, cada tile 32px (768×768 visible, mapa total mayor).
- Colores por estado: marrón (arado), verde claro (plantado), verde oscuro (maduro), gris (residencial), naranja (minero).
- Hover muestra tooltip con `quality`, `crop`, `growth%`, `valor`.
- Click abre `TilePanel` lateral con acciones contextuales.
- Indicador visual del **halo de la ciudad** (overlay translúcido que crece año a año).

---

## 9. Balance inicial (números semilla, ajustar jugando)

| Item | Valor |
|---|---|
| Caja inicial | $10.000 |
| Préstamo inicial | $20.000 a 5% mensual, 24 cuotas |
| Tile rural base | $3.000 |
| Trigo: ciclo / costo / yield | 30 días / $200 / $800 |
| Maíz: ciclo / costo / yield | 60 días / $400 / $1.800 |
| Manzano: maduración / costo / yield anual | 365 días / $2.000 / $1.500 × 5 años |
| Día = N segundos | 2s en x1 |
| Cuota mensual = | cada 30 días de juego |

---

## 10. Riesgos & mitigaciones para el jam

- **Scope creep**: la lista 11–22 es post‑jam. Cerrar Fase 1 + parte de Fase 2 (ciudad estática + AI básico) ya es un juego.
- **Balance**: exponer `tunables.js` + atajo `~` para abrir consola de debug y editar en vivo.
- **Arte**: usar tiles de color sólido o emoji para MVP. Sprites después.
- **Performance**: el `Economy.update` corre cada N ticks, no cada frame.

---

## 11. Próximos pasos concretos

1. Crear `src/state/GameState.js` con shape inicial.
2. Crear `src/systems/Clock.js` con tick loop y velocidades.
3. Crear `src/scenes/Game.js` con grid renderizado a partir del state.
4. Implementar compra de tile (click + pago + transferencia owner).
5. Implementar siembra/cosecha de trigo (más simple).
6. Mercado mínimo: precio fijo con ruido, vender = +caja.
7. Banco: cuota mensual hardcoded.
8. Iterar: agregar maíz, manzano, AI, ciudad, commodities globales, etc.

---

## 12. Preguntas abiertas

- ¿Estética? Pixel art, vector simple, o emojis/símbolos?
- ¿Duración objetivo de partida? (15 min, 1 hora, infinito).
- ¿Win condition? (X plata, dominar la ciudad, monopolio, o sandbox abierto).
- ¿Multiplayer asincrónico (subir score) o single‑player puro?

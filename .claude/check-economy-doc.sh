#!/usr/bin/env bash
# Hook: después de Edit/Write/MultiEdit, recordar a Claude evaluar si el
# cambio afecta reglas económicas documentadas en ECONOMY.md.
#
# El hook lee el JSON del PostToolUse en stdin (tool_input.file_path) y, si el
# archivo modificado está en `src/systems/`, `src/data/`, o es algún archivo
# del motor económico, emite un system-reminder via additionalContext para que
# Claude evalúe actualizar ECONOMY.md.
#
# Patrones cubiertos (rules of thumb):
#   src/systems/{Market,Population,Farming,AI,AISales,Industries,IndustryAI,
#                Exporters,ExporterAI,Bank,Labor,Inflation,PriceIndex,
#                FiscalCrisis,Events,Storage,Mining,Production,Transactions}.js
#   src/data/{tunables,producibles,industries,countries,taxRates,loanProducts}.js

set -e

# Leer el JSON del PostToolUse (Claude Code lo manda por stdin)
INPUT=$(cat)

# Extraer file_path del JSON. Usamos jq si está, sino un grep básico.
FILE_PATH=""
if command -v jq >/dev/null 2>&1; then
  FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null || true)
else
  # Fallback regex: busca "file_path":"..."
  FILE_PATH=$(echo "$INPUT" | grep -o '"file_path"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"file_path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')
fi

# Si no logramos extraer el path, salir silencioso
if [ -z "$FILE_PATH" ]; then
  exit 0
fi

# Filtros: ¿es un archivo del motor económico?
case "$FILE_PATH" in
  */src/systems/Market.js|\
  */src/systems/Population.js|\
  */src/systems/Farming.js|\
  */src/systems/AI.js|\
  */src/systems/AISales.js|\
  */src/systems/Industries.js|\
  */src/systems/IndustryAI.js|\
  */src/systems/Exporters.js|\
  */src/systems/ExporterAI.js|\
  */src/systems/Bank.js|\
  */src/systems/Labor.js|\
  */src/systems/Inflation.js|\
  */src/systems/PriceIndex.js|\
  */src/systems/FiscalCrisis.js|\
  */src/systems/Events.js|\
  */src/systems/Storage.js|\
  */src/systems/Mining.js|\
  */src/systems/Production.js|\
  */src/systems/Transactions.js|\
  */src/systems/WorldSeed.js|\
  */src/data/tunables.js|\
  */src/data/producibles.js|\
  */src/data/industries.js|\
  */src/data/countries.js|\
  */src/data/taxRates.js|\
  */src/data/loanProducts.js|\
  */src/data/eventTypes.js)
    ;;
  *)
    # No es un archivo del motor económico — salir silencioso
    exit 0
    ;;
esac

# Emitir system-reminder al stream del modelo. Claude Code recoge stdout del
# PostToolUse hook como additionalContext y lo inyecta al agente.
cat <<EOF
<system-reminder>
Cambiaste el archivo \`$FILE_PATH\`, que pertenece al motor económico documentado en \`ECONOMY.md\`. Evaluá si el cambio modifica alguna **regla** documentada (no implementación interna ni refactor) y, de ser así, actualizá \`ECONOMY.md\` para que siga siendo el reflejo correcto del comportamiento del juego.

Cambios que SÍ requieren actualizar el doc: nuevas fórmulas, cambios de umbrales que afectan comportamiento observable, nuevos actores o flujos, cambios en cadencias (diario/mensual/anual), cambios en cómo se calculan precios o targets, cambios en reglas de decisión de AI, cambios en los flujos de dinero entre wallets.

Cambios que NO requieren actualizar el doc: refactors que no alteran comportamiento, fix de bugs que ya respetan el doc, rename de funciones, cleanup de código, cambios sólo en logging/UI/visuales.

\`ECONOMY.md\` describe REGLAS, no código — sin extractos de \`.js\`.
</system-reminder>
EOF

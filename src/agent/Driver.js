// Driver — contrato duck-typed que cualquier "jugador" implementa.
//
//   class Driver {
//     decide(observation, actionsModule) → Action[]
//   }
//
// Donde `Action` es `{ action: 'name', ...args }` (ver Actions.js).
// `actionsModule` es el módulo Actions completo — útil cuando el bot
// quiere usar `listActions()` para descubrir su superficie sin hardcodear.
//
// LSP: HumanDriver, HeuristicBot, LLMBot son intercambiables. El Loop no
// distingue.

// HumanDriver — no decide nada. La UI dispara acciones directo desde clicks.
// Existe para que el Loop pueda correrse con un humano "al volante" sin
// casos especiales (e.g. al replicar una corrida grabada con acciones
// pregrabadas como `decide` de un humano).
export class HumanDriver {
  decide(_observation, _actions) {
    return [];
  }
}

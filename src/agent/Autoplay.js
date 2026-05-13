// Autoplay — corre el HeuristicBot DENTRO del browser, sobre el mismo state
// que el humano ve. Cada acción se aplica vía PlayerActions.apply(), así pasa
// por el mismo rail que un click humano (LSP). El usuario ve animaciones,
// pushFx, pushLog y cambios de cash en vivo.
//
// Se llama desde Game.update() cuando events.day === true, así el bot toma
// una decisión por día in-game al ritmo del clock (respeta pause/speed).

import { HeuristicBot } from './HeuristicBot.js';
import { observe } from './Observation.js';
import { apply } from './PlayerActions.js';
import { pushLog } from '../state/GameState.js';

// Misma origin que la app — el plugin vite (`bridgePlugin` en vite.config.js)
// monta /__bridge/* sobre el mismo dev server. Eso evita CORS y el sandbox
// del webview de cmux que puede no alcanzar puertos secundarios.
const BRIDGE_URL = '';

export class AutoplayController {
  constructor() {
    this.mode = 'off';                // 'off' | 'heuristic' | 'claude'
    this.bot = new HeuristicBot();
    this.lastActions = [];
    this.lastResults = [];
    this.pendingClaudeActions = null; // cache de respuesta del puente
  }

  get enabled() { return this.mode !== 'off'; }

  toggle(state) {
    // Cycle: off → heuristic → claude → off
    this.mode = this.mode === 'off' ? 'heuristic'
              : this.mode === 'heuristic' ? 'claude'
              : 'off';
    pushLog(state,
      this.mode === 'off' ? 'Autoplay OFF.' :
      this.mode === 'heuristic' ? 'Autoplay ON — HeuristicBot at the wheel.' :
      'Autoplay ON — Claude at the wheel (bridge :3335).');
    return this.mode;
  }

  // Llamado desde Game.update() cuando hay tick de día. No hace nada si está
  // apagado. No avanza el reloj — el motor lo hace.
  tickDay(state) {
    if (this.mode === 'off') return;
    if (this.mode === 'heuristic') return this._applyHeuristic(state);
    if (this.mode === 'claude') return this._applyClaude(state);
  }

  _applyHeuristic(state) {
    const obs = observe(state);
    const acts = this.bot.decide(obs) ?? [];
    const results = [];
    for (const a of acts) results.push(apply(state, a));
    this.lastActions = acts;
    this.lastResults = results;
  }

  // Modo Claude: POSTea la observación al puente y polea acciones. Si el
  // puente no responde o no hay acciones aún, hace noop y reintenta el próximo
  // tick. Esto significa que Claude puede "tomarse su tiempo" — el juego avanza
  // sin actuar hasta que las acciones aparezcan.
  _applyClaude(state) {
    const obs = observe(state);
    // Fire-and-forget POST de la observación (no bloquea el frame).
    fetch(`${BRIDGE_URL}/__bridge/obs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(obs),
    }).catch(() => { /* bridge down, silent */ });

    // Polea acciones pendientes (no bloqueante via promesa cacheada).
    if (!this.pendingClaudeActions) {
      this.pendingClaudeActions = fetch(`${BRIDGE_URL}/__bridge/actions`)
        .then(r => r.json())
        .catch(() => []);
    }
    // Si la promesa ya resolvió, aplicamos.
    this.pendingClaudeActions.then(acts => {
      if (!Array.isArray(acts) || acts.length === 0) return;
      const results = [];
      for (const a of acts) results.push(apply(state, a));
      this.lastActions = acts;
      this.lastResults = results;
      for (const a of acts) {
        if (a.action === 'noop') continue;
        pushLog(state, `🤖 Claude → ${a.action}${a.tileId != null ? ' tile=' + a.tileId : ''}${a.producibleId ? ' ' + a.producibleId : ''}${a.units ? ' x' + a.units : ''}`);
      }
    });
    // Pedimos acciones nuevas en el próximo tick.
    this.pendingClaudeActions = null;
  }
}

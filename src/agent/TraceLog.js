// TraceLog — hook `onTick` que mantiene un CSV de la sesión.
//
// Reusa src/util/csv.js (buildCSV/escapeCSVCell) — única fuente de verdad
// para escaping y formato.
//
// Diseño:
//  - una fila por (día, accion) si el bot actuó; una fila por día con
//    action='(none)' si no hizo nada — así la columna de tiempo es continua.
//  - métricas globales del día (cash, priceIndex home, etc.) duplicadas en
//    cada fila de ese día. Hace el CSV más fácil de filtrar/pivotear en
//    pandas/Excel sin tener que joinear con un eje de tiempo.

import { buildCSV } from '../util/csv.js';
import { PLAYER_COUNTRY_ID } from '../data/countries.js';

const HEADERS = [
  'day', 'year', 'month',
  'action', 'args', 'ok', 'reason',
  'cash', 'cashDelta',
  'priceIndex_home', 'wageRate_home',
  'marketPool_home', 'wageFund_home', 'treasury_home',
  'totalEvents',
];

export function createTrace() {
  const rows = [];
  let lastCash = null;

  const onTick = ({ state, acts, results }) => {
    const day = state.time.totalDays;
    const home = state.countries[PLAYER_COUNTRY_ID];
    const cash = state.player.cash;
    const cashDelta = lastCash == null ? 0 : (cash - lastCash);
    lastCash = cash;

    const base = {
      day,
      year: state.time.year,
      month: state.time.month,
      cash: Math.round(cash),
      cashDelta: Math.round(cashDelta),
      priceIndex_home: home ? Math.round((home.priceIndex ?? 1) * 1000) / 1000 : '',
      wageRate_home: home ? Math.round(home.wageRate ?? 0) : '',
      marketPool_home: home ? Math.round(home.marketPool ?? 0) : '',
      wageFund_home: home ? Math.round(home.wageFund ?? 0) : '',
      treasury_home: home ? Math.round(home.treasury ?? 0) : '',
      totalEvents: state.eventHistory.length,
    };

    if (!acts || acts.length === 0) {
      rows.push([...HEADERS.map(h =>
        h === 'action' ? '(none)' :
        h === 'args' ? '' :
        h === 'ok' ? '' :
        h === 'reason' ? '' :
        base[h] ?? '')]);
      return;
    }

    for (let i = 0; i < acts.length; i++) {
      const a = acts[i] ?? {};
      const r = results?.[i] ?? {};
      const args = JSON.stringify(
        Object.fromEntries(Object.entries(a).filter(([k]) => k !== 'action')),
      );
      rows.push(HEADERS.map(h =>
        h === 'action' ? (a.action ?? '') :
        h === 'args' ? args :
        h === 'ok' ? (r.ok ? 'true' : 'false') :
        h === 'reason' ? (r.reason ?? '') :
        base[h] ?? ''));
    }
  };

  const toCSV = () => buildCSV(HEADERS, rows);

  return { onTick, toCSV, rows };
}

#!/usr/bin/env node
// scripts/bridge.js — puente entre el browser y Claude.
//
// El browser POSTea la observación del día y polea acciones. Claude (yo) leo
// /tmp/coolmath-obs.json desde Claude Code y escribo /tmp/coolmath-actions.json
// con la próxima jugada. El browser la levanta en el siguiente poll y la aplica.
//
// Endpoints (CORS abierto para Vite localhost:3334):
//   POST /obs         body=observation JSON  → guarda en /tmp/coolmath-obs.json
//                                              y devuelve { day } eco.
//   GET  /actions     → si /tmp/coolmath-actions.json existe Y su `forDay` coincide
//                       con el último día observado, devuelve las acciones y
//                       borra el archivo. Si no hay nada, devuelve [].
//   GET  /status      → resumen amigable para diagnóstico desde curl.

import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';

const PORT = 3335;
const OBS_PATH = '/tmp/coolmath-obs.json';
const ACT_PATH = '/tmp/coolmath-actions.json';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'content-type',
};

function readBody(req) {
  return new Promise((res, rej) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => res(Buffer.concat(chunks).toString('utf8')));
    req.on('error', rej);
  });
}

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'content-type': type, ...cors });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

let lastObsDay = null;

const server = createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, '');

  if (req.method === 'POST' && req.url === '/obs') {
    const raw = await readBody(req);
    writeFileSync(OBS_PATH, raw);
    try { lastObsDay = JSON.parse(raw)?.time?.totalDays ?? null; } catch {}
    return send(res, 200, { ok: true, day: lastObsDay });
  }

  if (req.method === 'GET' && req.url === '/actions') {
    if (!existsSync(ACT_PATH)) return send(res, 200, []);
    let payload;
    try { payload = JSON.parse(readFileSync(ACT_PATH, 'utf8')); } catch {
      return send(res, 200, []);
    }
    // Si las acciones fueron escritas para un día distinto, ignorarlas (stale).
    if (payload?.forDay != null && lastObsDay != null && payload.forDay !== lastObsDay) {
      return send(res, 200, []);
    }
    try { unlinkSync(ACT_PATH); } catch {}
    return send(res, 200, payload?.actions ?? []);
  }

  if (req.method === 'GET' && req.url === '/status') {
    return send(res, 200, {
      lastObsDay,
      obsFileExists: existsSync(OBS_PATH),
      actFileExists: existsSync(ACT_PATH),
    });
  }

  send(res, 404, { error: 'unknown route' });
});

server.listen(PORT, () => {
  console.log(`[bridge] listening on http://localhost:${PORT}`);
  console.log(`[bridge] obs file:     ${OBS_PATH}`);
  console.log(`[bridge] actions file: ${ACT_PATH}`);
});

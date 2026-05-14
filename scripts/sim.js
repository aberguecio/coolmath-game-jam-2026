#!/usr/bin/env node
// scripts/sim.js — CLI headless del simulador.
//
//   node scripts/sim.js --driver=heuristic --days=365 --out=trace.csv
//   node scripts/sim.js --driver=none --days=1825 --out=passive.csv
//
// Flags:
//   --driver={heuristic|none}   default: heuristic
//   --days=<n>                  default: 365
//   --out=<path>                default: ./trace.csv

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { runSession } from '../src/agent/Loop.js';
import { HumanDriver } from '../src/agent/Driver.js';
import { HeuristicBot } from '../src/agent/HeuristicBot.js';
import { createTrace } from '../src/agent/TraceLog.js';
import { observe } from '../src/agent/Observation.js';

function parseArgs(argv) {
  const out = { driver: 'heuristic', days: 365, out: 'trace.csv' };
  for (const a of argv.slice(2)) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (!m) continue;
    const [, k, v] = m;
    if (k === 'days') out.days = parseInt(v, 10);
    else out[k] = v;
  }
  return out;
}

function makeDriver(name) {
  if (name === 'none' || name === 'human') return new HumanDriver();
  if (name === 'heuristic') return new HeuristicBot();
  throw new Error(`unknown driver: ${name}`);
}

const args = parseArgs(process.argv);
const driver = makeDriver(args.driver);
const trace = createTrace();

const t0 = Date.now();
const state = runSession({ driver, days: args.days, onTick: trace.onTick });
const elapsedMs = Date.now() - t0;

const outPath = resolve(process.cwd(), args.out);
writeFileSync(outPath, trace.toCSV(), 'utf8');

const finalObs = observe(state);
console.log('---');
console.log(`driver: ${args.driver}`);
console.log(`days:   ${args.days}  (elapsed ${elapsedMs} ms)`);
console.log(`bankrupt: ${state.player.bankrupt}`);
console.log(`cash: $${Math.round(state.player.cash)}`);
console.log('countries:');
for (const [cid, c] of Object.entries(finalObs.countries)) {
  console.log(`  ${cid}: priceIndex=${c.priceIndex}  wage=$${c.wageRate}  marketPool=$${c.marketPool}`);
}
console.log(`trace: ${outPath} (${trace.rows.length} rows)`);

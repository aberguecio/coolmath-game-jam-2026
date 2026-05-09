// Procedural sound effects via Web Audio API. No asset files.
// Adding a new SFX = one entry in PRESETS. Systems trigger with `play('kind')`
// or by pushing an FX event of type 'sfx'.
//
// Mute is shared with Music.js — when music is muted the SFX stays silent too.

import { isMusicMuted } from './Music.js';

let ctx = null;
let masterGain = null;

function ensureCtx() {
  if (ctx) return ctx;
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) return null;
  ctx = new Ctor();
  masterGain = ctx.createGain();
  masterGain.gain.value = 0.30;
  masterGain.connect(ctx.destination);
  return ctx;
}

function tone({ freq, freqEnd, type = 'sine', duration = 0.1, attack = 0.005, release = 0.05, gain = 0.25 }, when = 0) {
  if (!ctx) return;
  const t = ctx.currentTime + when;
  const osc = ctx.createOscillator();
  const env = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (freqEnd != null) osc.frequency.linearRampToValueAtTime(freqEnd, t + duration);
  env.gain.setValueAtTime(0, t);
  env.gain.linearRampToValueAtTime(gain, t + attack);
  env.gain.exponentialRampToValueAtTime(0.0001, t + duration + release);
  osc.connect(env);
  env.connect(masterGain);
  osc.start(t);
  osc.stop(t + duration + release + 0.05);
}

function noiseBurst({ duration = 0.2, gain = 0.18, lpFreq = 600, hpFreq = 0, decay = true } = {}, when = 0) {
  if (!ctx) return;
  const t = ctx.currentTime + when;
  const buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * duration), ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) {
    const env = decay ? (1 - i / data.length) : 1;
    data[i] = (Math.random() * 2 - 1) * env;
  }
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  const lpf = ctx.createBiquadFilter();
  lpf.type = 'lowpass';
  lpf.frequency.value = lpFreq;
  let chain = src;
  chain.connect(lpf);
  chain = lpf;
  if (hpFreq > 0) {
    const hpf = ctx.createBiquadFilter();
    hpf.type = 'highpass';
    hpf.frequency.value = hpFreq;
    chain.connect(hpf);
    chain = hpf;
  }
  const env = ctx.createGain();
  env.gain.value = gain;
  chain.connect(env);
  env.connect(masterGain);
  src.start(t);
}

// Each preset is a closure that schedules notes/noise on the AudioContext clock.
const PRESETS = {
  // Money in — bright two-note ping
  coin: () => {
    tone({ freq: 1318, type: 'square', duration: 0.05, gain: 0.18 });
    tone({ freq: 1976, type: 'square', duration: 0.07, gain: 0.16 }, 0.05);
  },

  // Money out — descending pair
  coinNeg: () => {
    tone({ freq: 988, type: 'square', duration: 0.06, gain: 0.18 });
    tone({ freq: 587, type: 'square', duration: 0.10, gain: 0.16 }, 0.06);
  },

  // Thump — low pulse for purchase / land transfer
  thump: () => {
    tone({ freq: 110, freqEnd: 55, type: 'sine', duration: 0.18, gain: 0.45 });
    noiseBurst({ duration: 0.10, gain: 0.10, lpFreq: 400 });
  },

  // Plow — filtered noise rumble
  plow: () => {
    noiseBurst({ duration: 0.32, gain: 0.18, lpFreq: 700 });
    tone({ freq: 80, freqEnd: 40, type: 'sine', duration: 0.30, gain: 0.18 });
  },

  // Plant — soft triangle pluck
  plant: () => {
    tone({ freq: 660, type: 'triangle', duration: 0.07, gain: 0.20 });
    tone({ freq: 990, type: 'triangle', duration: 0.05, gain: 0.10 }, 0.04);
  },

  // Survey — rising scanner sweep
  survey: () => {
    tone({ freq: 380, freqEnd: 920, type: 'sawtooth', duration: 0.20, gain: 0.16 });
  },

  // Chime — payday / contract complete
  chime: () => {
    tone({ freq: 880, type: 'sine', duration: 0.12, gain: 0.22 });
    tone({ freq: 1175, type: 'sine', duration: 0.14, gain: 0.20 }, 0.06);
    tone({ freq: 1568, type: 'sine', duration: 0.18, gain: 0.16 }, 0.12);
  },

  // Reject — descending minor third
  reject: () => {
    tone({ freq: 622, type: 'square', duration: 0.09, gain: 0.20 });
    tone({ freq: 415, type: 'square', duration: 0.14, gain: 0.18 }, 0.08);
  },

  // Foreclosure — dark minor chord stab
  foreclose: () => {
    tone({ freq: 110, type: 'sawtooth', duration: 0.40, gain: 0.20 });
    tone({ freq: 138.6, type: 'sawtooth', duration: 0.40, gain: 0.18 });
    tone({ freq: 165, type: 'sawtooth', duration: 0.40, gain: 0.16 });
    noiseBurst({ duration: 0.30, gain: 0.10, lpFreq: 600 });
  },

  // Offer landing — soft ping
  offerIn: () => {
    tone({ freq: 1175, type: 'sine', duration: 0.10, gain: 0.20 });
    tone({ freq: 1568, type: 'sine', duration: 0.14, gain: 0.16 }, 0.08);
  },
};

export function play(kind) {
  if (isMusicMuted()) return;
  if (!ensureCtx()) return;
  if (ctx.state === 'suspended') ctx.resume();
  const fn = PRESETS[kind];
  if (fn) fn();
}

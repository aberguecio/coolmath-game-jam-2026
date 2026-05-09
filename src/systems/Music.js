// Procedural ambient music via Web Audio API. No asset files.
// Pad chords with an arpeggio on top — chill but moving. Call startMusic() from
// inside a user gesture handler (browsers block AudioContext otherwise).

const PROGRESSION = [
  [261.63, 329.63, 392.00],   // C  major
  [220.00, 261.63, 329.63],   // A  minor
  [174.61, 220.00, 261.63],   // F  major
  [196.00, 246.94, 293.66],   // G  major
];

const CHORD_DURATION = 2.4;        // seconds per chord (was 5.0)
const OVERLAP = 0.6;               // crossfade window between pads
const NOTES_PER_CHORD = 4;         // arpeggio steps per chord
const SCHEDULE_AHEAD = 2.0;
const SCHEDULER_INTERVAL = 350;
const VOLUME_DEFAULT = 0.13;
const STORAGE_KEY = 'coolmath:music-muted';

let ctx = null;
let masterGain = null;
let scheduler = null;
let nextChordTime = 0;
let chordIdx = 0;
let isPlaying = false;
let isMuted = readMutedFromStorage();

function readMutedFromStorage() {
  try { return localStorage.getItem(STORAGE_KEY) === '1'; } catch { return false; }
}
function writeMutedToStorage(v) {
  try { localStorage.setItem(STORAGE_KEY, v ? '1' : '0'); } catch {}
}

function ensureCtx() {
  if (ctx) return ctx;
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) return null;
  ctx = new Ctor();
  masterGain = ctx.createGain();
  masterGain.gain.value = isMuted ? 0 : VOLUME_DEFAULT;

  const lpf = ctx.createBiquadFilter();
  lpf.type = 'lowpass';
  lpf.frequency.value = 2200;
  lpf.Q.value = 0.7;

  masterGain.connect(lpf);
  lpf.connect(ctx.destination);
  return ctx;
}

// Slow pad chord — same as before, just shorter.
function playPad(freqs, startTime) {
  for (const f of freqs) {
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = f;
    env.gain.setValueAtTime(0, startTime);
    env.gain.linearRampToValueAtTime(0.32, startTime + 0.8);
    env.gain.linearRampToValueAtTime(0, startTime + CHORD_DURATION);
    osc.connect(env);
    env.connect(masterGain);
    osc.start(startTime);
    osc.stop(startTime + CHORD_DURATION + 0.15);
  }
}

// Plucky arpeggio over the same chord, one octave up.
function playArp(freqs, startTime) {
  const stepDur = CHORD_DURATION / NOTES_PER_CHORD;
  // Build a 4-step pattern: root, fifth, octave, third (lifted variation per chord)
  const pattern = [
    freqs[0] * 2,
    freqs[2] * 2,
    freqs[0] * 4,
    freqs[1] * 2,
  ];
  for (let i = 0; i < NOTES_PER_CHORD; i++) {
    const t = startTime + i * stepDur;
    const f = pattern[i % pattern.length];
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.value = f;
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(0.18, t + 0.02);          // pluck attack
    env.gain.exponentialRampToValueAtTime(0.0001, t + stepDur * 0.95);
    osc.connect(env);
    env.connect(masterGain);
    osc.start(t);
    osc.stop(t + stepDur);
  }
}

// Soft bass pulse on the chord root, once per chord.
function playBass(freqs, startTime) {
  const osc = ctx.createOscillator();
  const env = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.value = freqs[0] / 2;     // octave below
  env.gain.setValueAtTime(0, startTime);
  env.gain.linearRampToValueAtTime(0.30, startTime + 0.05);
  env.gain.exponentialRampToValueAtTime(0.0001, startTime + CHORD_DURATION * 0.9);
  osc.connect(env);
  env.connect(masterGain);
  osc.start(startTime);
  osc.stop(startTime + CHORD_DURATION);
}

function scheduleLoop() {
  if (!isPlaying || !ctx) return;
  const now = ctx.currentTime;
  while (nextChordTime < now + SCHEDULE_AHEAD) {
    const chord = PROGRESSION[chordIdx];
    playPad(chord, nextChordTime);
    playBass(chord, nextChordTime);
    playArp(chord, nextChordTime);
    chordIdx = (chordIdx + 1) % PROGRESSION.length;
    nextChordTime += CHORD_DURATION - OVERLAP;
  }
  scheduler = setTimeout(scheduleLoop, SCHEDULER_INTERVAL);
}

export function startMusic() {
  if (isPlaying) return;
  if (!ensureCtx()) return;
  if (ctx.state === 'suspended') ctx.resume();
  isPlaying = true;
  nextChordTime = ctx.currentTime + 0.1;
  chordIdx = 0;
  scheduleLoop();
}

export function stopMusic() {
  isPlaying = false;
  if (scheduler) { clearTimeout(scheduler); scheduler = null; }
}

export function toggleMute() {
  isMuted = !isMuted;
  if (masterGain) {
    masterGain.gain.cancelScheduledValues(ctx.currentTime);
    masterGain.gain.linearRampToValueAtTime(isMuted ? 0 : VOLUME_DEFAULT, ctx.currentTime + 0.15);
  }
  writeMutedToStorage(isMuted);
  return isMuted;
}

export function isMusicMuted() {
  return isMuted;
}

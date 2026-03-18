/**
 * Generates assets/notify.wav — a soft bubble-pop notification sound.
 * No dependencies required — pure Node.js built-in modules only.
 * Run: node scripts/generate-sound.mjs
 *
 * Sound design: two-layer bubble pop
 *   - Layer 1: descending sine sweep 680Hz → 280Hz, ~320ms, fast decay
 *   - Layer 2: lower harmonic at half frequency, -8dB, same decay
 * Result: gentle, non-intrusive "blup" rather than a sharp ping.
 */
import { writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = join(__dirname, "..", "assets");
const OUT = join(ASSETS_DIR, "notify.wav");

const SAMPLE_RATE = 44100;
const DURATION    = 0.32;        // seconds
const VOLUME      = 0.25;        // master volume (0–1), kept low to avoid jarring
const NUM_SAMPLES = Math.floor(SAMPLE_RATE * DURATION);

// ── Synthesis ─────────────────────────────────────────────────────────────────
const pcm = new Int16Array(NUM_SAMPLES);

let phase1 = 0;
let phase2 = 0;

for (let i = 0; i < NUM_SAMPLES; i++) {
  const t        = i / SAMPLE_RATE;
  const progress = t / DURATION;

  // Frequency sweep: exponential descent
  const f1 = 680 * Math.pow(280 / 680, progress);  // main layer
  const f2 = f1 * 0.5;                              // sub harmonic

  // Envelope: instant attack, smooth exponential tail
  const attackSamples = Math.floor(0.004 * SAMPLE_RATE);  // 4ms attack
  const env =
    i < attackSamples
      ? i / attackSamples
      : Math.exp(-progress * 7.5);                  // decay speed

  const layer1 = Math.sin(phase1) * env;
  const layer2 = Math.sin(phase2) * env * 0.25;     // -12dB sub harmonic

  const sample = (layer1 + layer2) * VOLUME;
  pcm[i] = Math.round(Math.max(-1, Math.min(1, sample)) * 32767);

  // Accumulate phase (handles frequency drift smoothly)
  phase1 += (2 * Math.PI * f1) / SAMPLE_RATE;
  phase2 += (2 * Math.PI * f2) / SAMPLE_RATE;
}

// ── WAV encoding ──────────────────────────────────────────────────────────────
function u16le(n) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
}
function u32le(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
}

const dataBytes  = Buffer.from(pcm.buffer);
const byteRate   = SAMPLE_RATE * 1 * 2;   // sampleRate * channels * bytesPerSample
const blockAlign = 1 * 2;                 // channels * bytesPerSample

const fmt = Buffer.concat([
  Buffer.from("fmt "),
  u32le(16),              // chunk size (PCM)
  u16le(1),               // audio format: PCM
  u16le(1),               // channels: mono
  u32le(SAMPLE_RATE),
  u32le(byteRate),
  u16le(blockAlign),
  u16le(16),              // bits per sample
]);

const wav = Buffer.concat([
  Buffer.from("RIFF"),
  u32le(36 + dataBytes.length),
  Buffer.from("WAVE"),
  fmt,
  Buffer.from("data"),
  u32le(dataBytes.length),
  dataBytes,
]);

mkdirSync(ASSETS_DIR, { recursive: true });
writeFileSync(OUT, wav);
console.log(`notify.wav written to ${OUT}`);
console.log(`  Duration : ${DURATION * 1000}ms`);
console.log(`  Frequency: 680Hz → 280Hz sweep`);
console.log(`  Channels : mono, 44100 Hz, 16-bit PCM`);

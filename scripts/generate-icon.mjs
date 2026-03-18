/**
 * Generates icon.png at the project root.
 * No dependencies required — uses only Node.js built-in modules.
 * Run: node scripts/generate-icon.mjs
 */
import { writeFileSync } from "fs";
import { deflateSync } from "zlib";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, "..", "icon.png");

const W = 64, H = 64;

// ── Pixel helpers ─────────────────────────────────────────────────────────────
const pixels = new Uint8Array(W * H * 3);

const BG     = [17,  24,  39];   // gray-900
const CARD   = [31,  41,  55];   // gray-800
const ACCENT = [99, 179, 237];   // blue-400
const WHITE  = [255, 255, 255];

function set(x, y, [r, g, b]) {
  if (x < 0 || x >= W || y < 0 || y >= H) return;
  const i = (y * W + x) * 3;
  pixels[i] = r; pixels[i + 1] = g; pixels[i + 2] = b;
}

function fillRect(x, y, w, h, color) {
  for (let dy = 0; dy < h; dy++)
    for (let dx = 0; dx < w; dx++)
      set(x + dx, y + dy, color);
}

function roundedRect(x, y, w, h, r, color) {
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      const cx = dx < r ? r - dx : dx >= w - r ? dx - (w - r - 1) : 0;
      const cy = dy < r ? r - dy : dy >= h - r ? dy - (h - r - 1) : 0;
      if (cx === 0 || cy === 0 || cx * cx + cy * cy <= r * r)
        set(x + dx, y + dy, color);
    }
  }
}

// ── Draw ──────────────────────────────────────────────────────────────────────
// Background
fillRect(0, 0, W, H, BG);

// Card
roundedRect(6, 6, 52, 52, 8, CARD);

// "Code lines" motif — three horizontal bars of decreasing width
const bars = [[14, 22, 36], [14, 30, 28], [14, 38, 20]];
for (const [bx, by, bw] of bars) {
  fillRect(bx, by, bw, 4, ACCENT);
}

// Small accent dot (bullet) left of each bar
for (const [bx, by] of bars) {
  fillRect(bx - 6, by + 1, 3, 3, WHITE);
}

// ── Encode PNG ────────────────────────────────────────────────────────────────
function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) {
    c ^= byte;
    for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const t = Buffer.from(type, "ascii");
  const d = Buffer.from(data);
  const crcBuf = Buffer.concat([t, d]);
  return Buffer.concat([u32(d.length), t, d, u32(crc32(crcBuf))]);
}

// Build raw scanlines (filter byte 0 = None, then RGB triplets)
const raw = Buffer.alloc(H * (1 + W * 3));
for (let y = 0; y < H; y++) {
  raw[y * (1 + W * 3)] = 0; // filter = None
  for (let x = 0; x < W; x++) {
    const src = (y * W + x) * 3;
    const dst = y * (1 + W * 3) + 1 + x * 3;
    raw[dst]     = pixels[src];
    raw[dst + 1] = pixels[src + 1];
    raw[dst + 2] = pixels[src + 2];
  }
}

const sig  = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const IHDR = pngChunk("IHDR", [...u32(W), ...u32(H), 8, 2, 0, 0, 0]);
const IDAT = pngChunk("IDAT", deflateSync(raw));
const IEND = pngChunk("IEND", []);

writeFileSync(OUT, Buffer.concat([sig, IHDR, IDAT, IEND]));
console.log(`icon.png written to ${OUT}`);

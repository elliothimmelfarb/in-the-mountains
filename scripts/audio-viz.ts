/**
 * audio-viz.ts — turn rendered .wav scenes into SVG spectrograms + waveforms for the report.
 *
 *   npx tsx scripts/audio-viz.ts <scene.wav> <out.svg> [label]
 *   npx tsx scripts/audio-viz.ts --ab <before.wav> <after.wav> <out.svg> [label]
 *
 * For sound, a spectrogram is what a trajectory diagram is for movement (Bug-hunt playbook):
 * structure that hides in numbers jumps out of the picture — a reverb tail, added high-frequency
 * detail, stereo decorrelation, an ambient bed where there was silence. The --ab mode stacks
 * before/after with a shared color scale so the delta is unmissable. Convert with
 * `node scripts/svg2png.mjs <in.svg> <out.png>`.
 */
import { readFileSync, writeFileSync } from "node:fs";
import sharp from "sharp";

/** Write the SVG and a true-size PNG beside it (sharp rasterizes at 1:1 at density 96). */
async function emit(out: string, svg: string): Promise<void> {
  writeFileSync(out, svg);
  const png = out.replace(/\.svg$/, ".png");
  await sharp(Buffer.from(svg), { density: 96 }).png().toFile(png);
  console.log(`wrote ${out} + ${png}`);
}

interface Wav { L: Float32Array; R: Float32Array; sr: number }

function readWav(path: string): Wav {
  const b = readFileSync(path);
  const sr = b.readUInt32LE(24);
  const ch = b.readUInt16LE(22);
  const bits = b.readUInt16LE(34);
  // find 'data' chunk
  let o = 12;
  while (o < b.length - 8) {
    const id = b.toString("ascii", o, o + 4);
    const sz = b.readUInt32LE(o + 4);
    if (id === "data") { o += 8; break; }
    o += 8 + sz;
  }
  const bytes = bits / 8;
  const frames = Math.floor((b.length - o) / (bytes * ch));
  const L = new Float32Array(frames), R = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    const base = o + i * bytes * ch;
    L[i] = b.readInt16LE(base) / 32768;
    R[i] = ch > 1 ? b.readInt16LE(base + bytes) / 32768 : L[i];
  }
  return { L, R, sr };
}

// radix-2 FFT (re/im in place)
function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, bIdx = i + k + len / 2;
        const tr = re[bIdx] * cr - im[bIdx] * ci, ti = re[bIdx] * ci + im[bIdx] * cr;
        re[bIdx] = re[a] - tr; im[bIdx] = im[a] - ti; re[a] += tr; im[a] += ti;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

/** STFT → dB magnitude grid [timeCols][freqRows], log-frequency mapped. */
function spectrogram(mono: Float32Array, sr: number, cols: number, rows: number) {
  const FFT = 2048, hop = Math.max(1, Math.floor(mono.length / cols));
  const re = new Float32Array(FFT), im = new Float32Array(FFT);
  const grid: number[][] = [];
  const fMin = 40, fMax = Math.min(18000, sr / 2);
  for (let c = 0; c < cols; c++) {
    const s = c * hop;
    re.fill(0); im.fill(0);
    for (let i = 0; i < FFT; i++) {
      const idx = s + i;
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT - 1));
      re[i] = idx < mono.length ? mono[idx] * w : 0;
    }
    fft(re, im);
    const colArr: number[] = [];
    for (let r = 0; r < rows; r++) {
      // log-freq bin
      const f = fMin * Math.pow(fMax / fMin, r / (rows - 1));
      const k = Math.round((f * FFT) / sr);
      const mag = k >= 1 && k < FFT / 2 ? Math.hypot(re[k], im[k]) : 0;
      colArr.push(20 * Math.log10(mag + 1e-7));
    }
    grid.push(colArr);
  }
  return { grid, fMin, fMax };
}

// magma-ish colormap for dB in [-90,-10]
function color(dbv: number): string {
  const t = Math.max(0, Math.min(1, (dbv + 90) / 80));
  // dark purple -> magenta -> orange -> yellow-white
  const stops = [
    [8, 6, 28], [60, 15, 90], [140, 30, 110], [210, 60, 70], [245, 130, 50], [253, 220, 140],
  ];
  const x = t * (stops.length - 1), i = Math.floor(x), f = x - i;
  const a = stops[i], b = stops[Math.min(stops.length - 1, i + 1)];
  const ch = (j: number) => Math.round(a[j] + (b[j] - a[j]) * f);
  return `rgb(${ch(0)},${ch(1)},${ch(2)})`;
}

function spectrogramSvg(mono: Float32Array, sr: number, x0: number, y0: number, w: number, h: number, title: string): string {
  const cols = 240, rows = 120;
  const { grid, fMin, fMax } = spectrogram(mono, sr, cols, rows);
  const cw = w / cols, rh = h / rows;
  let s = `<g>`;
  s += `<text x="${x0}" y="${y0 - 6}" fill="#cbd5e1" font-size="13" font-family="ui-monospace,monospace">${title}</text>`;
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) {
      const dbv = grid[c][rows - 1 - r];
      if (dbv < -88) continue; // leave the floor as background
      s += `<rect x="${(x0 + c * cw).toFixed(1)}" y="${(y0 + r * rh).toFixed(1)}" width="${(cw + 0.6).toFixed(1)}" height="${(rh + 0.6).toFixed(1)}" fill="${color(dbv)}"/>`;
    }
  }
  s += `<rect x="${x0}" y="${y0}" width="${w}" height="${h}" fill="none" stroke="#334155"/>`;
  // freq axis labels
  for (const f of [100, 500, 1000, 4000, 12000]) {
    const r = Math.log(f / fMin) / Math.log(fMax / fMin);
    const y = y0 + h - r * h;
    s += `<text x="${x0 - 6}" y="${(y + 3).toFixed(1)}" fill="#64748b" font-size="9" text-anchor="end" font-family="ui-monospace,monospace">${f >= 1000 ? f / 1000 + "k" : f}</text>`;
  }
  s += `</g>`;
  return s;
}

function waveformSvg(L: Float32Array, R: Float32Array, x0: number, y0: number, w: number, h: number, title: string): string {
  const cols = 600, hop = Math.max(1, Math.floor(L.length / cols));
  let s = `<g><text x="${x0}" y="${y0 - 6}" fill="#cbd5e1" font-size="13" font-family="ui-monospace,monospace">${title}</text>`;
  s += `<rect x="${x0}" y="${y0}" width="${w}" height="${h}" fill="#0b1220" stroke="#334155"/>`;
  const mid = y0 + h / 2;
  s += `<line x1="${x0}" y1="${mid}" x2="${x0 + w}" y2="${mid}" stroke="#1e293b"/>`;
  let path = "";
  for (let c = 0; c < cols; c++) {
    let pk = 0; const st = c * hop, en = Math.min(L.length, st + hop);
    for (let i = st; i < en; i++) pk = Math.max(pk, Math.abs(L[i]), Math.abs(R[i]));
    const x = x0 + (c / cols) * w;
    path += `M${x.toFixed(1)},${(mid - pk * (h / 2)).toFixed(1)}L${x.toFixed(1)},${(mid + pk * (h / 2)).toFixed(1)}`;
  }
  s += `<path d="${path}" stroke="#38bdf8" stroke-width="1" opacity="0.85"/></g>`;
  return s;
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--ab") {
    const [, before, after, out, label = ""] = args;
    const b = readWav(before), a = readWav(after);
    const W = 1040, H = 720;
    const bm = new Float32Array(b.L.length), am = new Float32Array(a.L.length);
    for (let i = 0; i < bm.length; i++) bm[i] = (b.L[i] + b.R[i]) * 0.5;
    for (let i = 0; i < am.length; i++) am[i] = (a.L[i] + a.R[i]) * 0.5;
    let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="#020617"/>`;
    svg += `<text x="40" y="30" fill="#f1f5f9" font-size="18" font-family="ui-monospace,monospace">${label}  —  before (top) vs after (bottom)</text>`;
    svg += waveformSvg(b.L, b.R, 70, 70, 900, 90, "BEFORE waveform");
    svg += spectrogramSvg(bm, b.sr, 70, 210, 900, 130, "BEFORE spectrogram");
    svg += waveformSvg(a.L, a.R, 70, 430, 900, 90, "AFTER waveform");
    svg += spectrogramSvg(am, a.sr, 70, 570, 900, 130, "AFTER spectrogram");
    svg += `</svg>`;
    await emit(out, svg);
  } else {
    const [wav, out, label = wav] = args;
    const { L, R, sr } = readWav(wav);
    const mono = new Float32Array(L.length);
    for (let i = 0; i < mono.length; i++) mono[i] = (L[i] + R[i]) * 0.5;
    const W = 1040, H = 360;
    let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="#020617"/>`;
    svg += waveformSvg(L, R, 70, 40, 900, 90, `${label} — waveform`);
    svg += spectrogramSvg(mono, sr, 70, 190, 900, 130, `${label} — spectrogram`);
    svg += `</svg>`;
    await emit(out, svg);
  }
}

main();

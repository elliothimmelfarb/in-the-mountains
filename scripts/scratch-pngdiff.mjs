// scratch: dependency-free PNG mean/peak RGB diff for visual A/B gates. Pure node zlib.
// Handles 8-bit non-interlaced PNG (RGB/RGBA) — what headless Chrome captureScreenshot emits.
//   node scripts/scratch-pngdiff.mjs a.png b.png   → JSON {meanDiff, pctChanged, maxDiff}
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";

function decode(path) {
  const buf = readFileSync(path);
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not png " + path);
  let off = 8, w = 0, h = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9];
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    off += 12 + len;
  }
  if (bitDepth !== 8) throw new Error("bitDepth " + bitDepth);
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : -1;
  if (channels < 0) throw new Error("colorType " + colorType);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * channels;
  const out = Buffer.alloc(h * stride);
  let pos = 0;
  const paeth = (a, b, c) => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };
  for (let y = 0; y < h; y++) {
    const filter = raw[pos++];
    for (let x = 0; x < stride; x++) {
      const rawByte = raw[pos++];
      const a = x >= channels ? out[y * stride + x - channels] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = x >= channels && y > 0 ? out[(y - 1) * stride + x - channels] : 0;
      let val;
      switch (filter) {
        case 0: val = rawByte; break;
        case 1: val = rawByte + a; break;
        case 2: val = rawByte + b; break;
        case 3: val = rawByte + ((a + b) >> 1); break;
        case 4: val = rawByte + paeth(a, b, c); break;
        default: throw new Error("filter " + filter);
      }
      out[y * stride + x] = val & 0xff;
    }
  }
  return { w, h, channels, data: out };
}

const [pa, pb] = process.argv.slice(2);
const A = decode(pa), B = decode(pb);
if (A.w !== B.w || A.h !== B.h) { console.log(JSON.stringify({ error: "size mismatch", a: [A.w, A.h], b: [B.w, B.h] })); process.exit(1); }
let sum = 0, changed = 0, max = 0;
const n = A.w * A.h;
for (let i = 0; i < n; i++) {
  const ao = i * A.channels, bo = i * B.channels;
  const dr = Math.abs(A.data[ao] - B.data[bo]);
  const dg = Math.abs(A.data[ao + 1] - B.data[bo + 1]);
  const db = Math.abs(A.data[ao + 2] - B.data[bo + 2]);
  const d = (dr + dg + db) / 3;
  sum += d;
  if (d > 8) changed++;
  if (d > max) max = d;
}
console.log(JSON.stringify({ meanDiff: +(sum / n).toFixed(3), pctChanged: +((changed / n) * 100).toFixed(2), maxDiff: max }));

// scratch-pngluma — dependency-free mean-luma reader for the shipped screenshot PNGs.
// The numeric backbone for the visual gates: noon-mid-gray-vs-attempt-1, compound-veil floor,
// "night not crushed", "bloom doesn't wash strategic". Decodes PNG (zlib inflate + unfilter)
// and reports mean sRGB luma 0-255 over the whole frame and a central crop, plus the darkest
// and brightest decile (a cheap lit/shadow spread). Compares two files when given a pair.
//
//   node scripts/scratch-pngluma.mjs <a.png> [b.png] [--crop 0.5]
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";

function decodePNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
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
  if (bitDepth !== 8) throw new Error("only 8-bit PNG supported, got " + bitDepth);
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : 0;
  if (!channels) throw new Error("unsupported colorType " + colorType);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * channels;
  const out = Buffer.alloc(h * stride);
  const paeth = (a, b, c) => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };
  let rp = 0;
  for (let y = 0; y < h; y++) {
    const ft = raw[rp++];
    for (let x = 0; x < stride; x++) {
      const v = raw[rp++];
      const a = x >= channels ? out[y * stride + x - channels] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = x >= channels && y > 0 ? out[(y - 1) * stride + x - channels] : 0;
      let r;
      switch (ft) {
        case 0: r = v; break;
        case 1: r = v + a; break;
        case 2: r = v + b; break;
        case 3: r = v + ((a + b) >> 1); break;
        case 4: r = v + paeth(a, b, c); break;
        default: throw new Error("bad filter " + ft);
      }
      out[y * stride + x] = r & 0xff;
    }
  }
  return { w, h, channels, data: out };
}

function stats(png, crop) {
  const { w, h, channels, data } = png;
  const x0 = Math.floor(w * (1 - crop) / 2), x1 = w - x0;
  const y0 = Math.floor(h * (1 - crop) / 2), y1 = h - y0;
  let sum = 0, n = 0, csum = 0, cn = 0;
  const hist = new Array(256).fill(0);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * channels;
      const L = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      sum += L; n++;
      hist[Math.min(255, Math.round(L))]++;
      if (x >= x0 && x < x1 && y >= y0 && y < y1) { csum += L; cn++; }
    }
  }
  // darkest / brightest decile means (cheap shadow vs lit spread)
  let acc = 0, dCut = 0, bCut = 0;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= n * 0.1 && !dCut) dCut = v; if (acc >= n * 0.9 && !bCut) { bCut = v; break; } }
  let dSum = 0, dN = 0, bSum = 0, bN = 0;
  for (let v = 0; v < 256; v++) { if (v <= dCut) { dSum += v * hist[v]; dN += hist[v]; } if (v >= bCut) { bSum += v * hist[v]; bN += hist[v]; } }
  return {
    mean: +(sum / n).toFixed(1),
    centerMean: +(csum / cn).toFixed(1),
    darkDecile: +(dSum / Math.max(1, dN)).toFixed(1),
    brightDecile: +(bSum / Math.max(1, bN)).toFixed(1),
    shadowLitRatio: +((dSum / Math.max(1, dN)) / Math.max(1, bSum / Math.max(1, bN))).toFixed(3),
  };
}

const args = process.argv.slice(2);
const crop = args.includes("--crop") ? Number(args[args.indexOf("--crop") + 1]) : 0.6;
const files = args.filter((a) => a.endsWith(".png"));
const results = files.map((f) => ({ f, s: stats(decodePNG(readFileSync(f)), crop) }));
for (const r of results) console.log(`${r.f}\n  mean=${r.s.mean}  center=${r.s.centerMean}  darkDecile=${r.s.darkDecile}  brightDecile=${r.s.brightDecile}  shadow/lit=${r.s.shadowLitRatio}`);
if (results.length === 2) {
  const [a, b] = results;
  console.log(`\nΔ center luma: ${(b.s.centerMean - a.s.centerMean).toFixed(1)}  (${a.f.split("/").pop()} → ${b.f.split("/").pop()})`);
}

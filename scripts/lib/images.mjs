// images.mjs — download a product photo and bring it under the store's upload ceiling.
//
// WHY: the store's media door takes the file as base64 inside JSON, and on common shared hosting a request
// much over ~490 KB of file is refused by the HOST (a bare 403, before the store ever sees it). So an image
// over MAX_BYTES is re-encoded under it, at most MAX_EDGE pixels on its long side; one already under it is kept.
//
// Engines, tried in order — the first that produces a JPEG under the ceiling wins:
//   1. source-server   CJ's image server resizes on request (its images are served from an Alibaba Cloud
//                      OSS bucket, which takes an `x-oss-process` instruction). Exact, fast, any format.
//   2. codec           shipped with this skill, runs anywhere: JPEG through the vendored jpeg-js, PNG through
//                      node's own zlib. Honours the camera's EXIF orientation; flattens transparency on white.
//   3. local-tool      whatever this machine already has, for every other format (WebP, AVIF, HEIC …):
//                      `sips` (macOS), ImageMagick (`magick`, or `convert` outside Windows), or
//                      PowerShell's built-in imaging (Windows).
// If none can, the image is refused and named — it is never uploaded oversized.
//
// Also here: the download asks for JPEG/PNG and prefers the original of a resized copy (downloadBest), and toPng()
// converts what the codec cannot read, for the photos step (photos.mjs).

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { inflateSync } from 'node:zlib';

const require = createRequire(import.meta.url);
const jpegDecode = require('./vendor/jpeg-js/decoder.cjs');
const jpegEncode = require('./vendor/jpeg-js/encoder.cjs');

export const MAX_BYTES = 450 * 1024;
export const MAX_EDGE = 1600;
const QUALITIES = [85, 75, 65, 55];
// When even the lowest quality is too heavy (a very detailed photo), each engine steps the size down before
// giving up: 1600 → 1280 → 1024 → 800 px on the long edge.
const edgeSteps = (maxEdge) => [...new Set([maxEdge, Math.round(maxEdge * 0.8), Math.round(maxEdge * 0.64), Math.min(800, maxEdge)])];
const UA = 'Mozilla/5.0 (compatible; codbrand-tools image fetch)';
// JPEG or PNG only, never a wildcard. Measured 30-09-2026: AliExpress's image CDN answers any Accept that allows
// `image/*` (even `image/*;q=0.5`) with a re-encoded WebP — 121 KB instead of the 349 KB JPEG it stores — and sends
// the stored JPEG when only these two are allowed. A file stored as WebP comes back as WebP either way (measured);
// a server that refuses the narrow list (406) is asked again with `image/*`.
const ACCEPT = 'image/jpeg,image/png';

/** GET an image. Two tries, 30 s each. */
export async function download(url) {
  let last;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const get = (accept) => fetch(url, { headers: { 'User-Agent': UA, Accept: accept }, signal: AbortSignal.timeout(30000) });
      let r = await get(ACCEPT);
      if (r.status === 406) r = await get('image/*');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return Buffer.from(await r.arrayBuffer());
    } catch (e) { last = e; }
  }
  throw new Error(`could not download ${url}: ${last.message}`);
}

/**
 * The original of a photo whose URL names a resized copy, or null. Each pattern was fetched both ways, 30-09-2026:
 *   WordPress    …/wp-content/uploads/…/name-600x731.jpg              600×731 → name.jpg             960×1170
 *   Shopify      cdn.shopify.com/…/name_300x.png                      300×300 → name.png            4000×4000
 *   alicdn       …/kf/S….jpg_120x120.jpg_.webp                        120×120 → …/kf/S….jpg           800×800
 *                …/kf/H….png_350x350.png                              350×350 → …/kf/H….png         1024×1024
 *   BigCommerce  …/products/80/images/272/name.1456436717.500.750.jpg 500×500 →
 *                …/images/stencil/original/products/80/272/name.1456436717.jpg                       1000×1000
 *                …/images/stencil/1280x1280/… → …/images/stencil/original/…
 * It is only a guess: downloadBest() keeps the original only when it downloads and is larger.
 */
export function originalOf(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const host = u.host.toLowerCase();
  const p = u.pathname;
  const EXT = '(\\.(?:jpe?g|png|gif|webp))';
  let q = null;
  if (/\/wp-content\/uploads\//.test(p)) q = p.replace(new RegExp(`-\\d{2,5}x\\d{2,5}${EXT}$`, 'i'), '$1');
  else if (/(^|\.)shopify\.com$/.test(host) || /\/cdn\/shop\//.test(p)) {
    q = p.replace(new RegExp(`_(?:\\d{1,5}x\\d{0,5}|x\\d{1,5}|pico|icon|thumb|small|compact|medium|large|grande|master|original)(?:@\\dx)?${EXT}$`, 'i'), '$1');
  } else if (/(^|\.)(alicdn\.com|aliexpress-media\.com)$/.test(host)) q = p.replace(/(\.(?:jpe?g|png|webp))_[^/]*$/i, '$1');
  else if (/(^|\.)bigcommerce\.com$/.test(host)) {
    q = p.replace(/\/images\/stencil\/[^/]+\//, '/images/stencil/original/');
    const m = q === p ? p.match(new RegExp(`^(.*)/products/(\\d+)/images/(\\d+)/(.+?)\\.\\d+\\.\\d+${EXT}$`, 'i')) : null;
    if (m) q = `${m[1]}/images/stencil/original/products/${m[2]}/${m[3]}/${m[4]}${m[5]}`;
  }
  if (!q || q === p) return null;
  u.pathname = q;
  return u.href;
}

/** download(url) — or the original it is a resized copy of, when that downloads and is larger. */
export async function downloadBest(url) {
  const given = await download(url);
  const orig = originalOf(url);
  if (!orig) return { buffer: given, url };
  let big;
  try { big = await download(orig); } catch { return { buffer: given, url }; }
  const a = probe(given), b = probe(big);
  const edge = (x) => Math.max(x.width || 0, x.height || 0);
  if (b.format === 'unknown' || edge(b) <= edge(a)) return { buffer: given, url };
  return { buffer: big, url: orig, larger: { from: [a.width, a.height], to: [b.width, b.height] } };
}

/** Format and pixel size from the file header — no decoding. */
export function probe(b) {
  const out = { format: 'unknown', width: null, height: null, bytes: b.length };
  if (b.length < 16) return out;
  if (b[0] === 0xff && b[1] === 0xd8) {
    out.format = 'jpeg';
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1];
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
      const len = b.readUInt16BE(i + 2);
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        out.height = b.readUInt16BE(i + 5);
        out.width = b.readUInt16BE(i + 7);
        break;
      }
      i += 2 + len;
    }
  } else if (b.readUInt32BE(0) === 0x89504e47) {
    out.format = 'png'; out.width = b.readUInt32BE(16); out.height = b.readUInt32BE(20);
  } else if (b.toString('ascii', 0, 4) === 'GIF8') {
    out.format = 'gif'; out.width = b.readUInt16LE(6); out.height = b.readUInt16LE(8);
  } else if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
    out.format = 'webp';
    const chunk = b.toString('ascii', 12, 16);
    if (chunk === 'VP8 ' && b.length >= 30) { out.width = b.readUInt16LE(26) & 0x3fff; out.height = b.readUInt16LE(28) & 0x3fff; }
    else if (chunk === 'VP8L' && b.length >= 25) {
      const [b0, b1, b2, b3] = [b[21], b[22], b[23], b[24]];
      out.width = 1 + (b0 | ((b1 & 0x3f) << 8));
      out.height = 1 + ((b1 >> 6) | (b2 << 2) | ((b3 & 0x0f) << 10));
    } else if (chunk === 'VP8X' && b.length >= 30) { out.width = 1 + b.readUIntLE(24, 3); out.height = 1 + b.readUIntLE(27, 3); }
  } else if (b.toString('ascii', 4, 8) === 'ftyp') {
    const brand = b.toString('ascii', 8, 12);
    out.format = /avif|avis/.test(brand) ? 'avif' : /hei|mif/.test(brand) ? 'heic' : 'unknown';
  }
  return out;
}

const EXT = { jpeg: 'jpg', png: 'png', gif: 'gif', webp: 'webp', avif: 'avif', heic: 'heic' };
export const extFor = (format) => EXT[format] || 'bin';

// ── engine 1: CJ's image server ───────────────────────────────────────────────────────────────────
const isCj = (url) => { try { return /(^|\.)cjdropshipping\.com$/i.test(new URL(url).host); } catch { return false; } };

async function sourceServer(url, maxEdge, maxBytes) {
  if (!isCj(url)) return null;
  for (const edge of edgeSteps(maxEdge)) {
    for (const q of QUALITIES) {
      let buf;
      try { buf = await download(`${url}?x-oss-process=image/resize,l_${edge}/quality,q_${q}/format,jpg`); } catch { return null; }
      const p = probe(buf);
      if (p.format !== 'jpeg') return null; // the server ignored the instruction — do not trust it further
      if (p.bytes <= maxBytes) return { buffer: buf, engine: 'source-server', quality: q };
    }
  }
  return null;
}

// ── engine 2: the shipped codec ───────────────────────────────────────────────────────────────────

/** The EXIF orientation of a JPEG (1 = as stored). */
export function jpegOrientation(b) {
  try {
    if (!(b[0] === 0xff && b[1] === 0xd8)) return 1;
    let i = 2;
    while (i + 10 < b.length && b[i] === 0xff) {
      const m = b[i + 1];
      const len = b.readUInt16BE(i + 2);
      if (m === 0xda) break;
      if (m === 0xe1 && b.toString('ascii', i + 4, i + 10) === 'Exif\0\0') {
        const t = i + 10;
        const le = b.toString('ascii', t, t + 2) === 'II';
        const u16 = (o) => (le ? b.readUInt16LE(o) : b.readUInt16BE(o));
        const u32 = (o) => (le ? b.readUInt32LE(o) : b.readUInt32BE(o));
        const ifd = t + u32(t + 4);
        for (let k = 0, n = u16(ifd); k < n; k++) {
          const e = ifd + 2 + k * 12;
          if (u16(e) === 0x0112) { const o = u16(e + 8); return o >= 1 && o <= 8 ? o : 1; }
        }
        return 1;
      }
      i += 2 + len;
    }
  } catch { /* a malformed header reads as "as stored" */ }
  return 1;
}

/** Apply an EXIF orientation to RGBA pixels, so the upload looks the way the camera meant. */
export function orient({ data, w, h }, o) {
  if (o === 1) return { data, w, h };
  const swap = o >= 5;
  const W = swap ? h : w, H = swap ? w : h;
  const src = {
    2: (x, y) => [w - 1 - x, y], 3: (x, y) => [w - 1 - x, h - 1 - y], 4: (x, y) => [x, h - 1 - y],
    5: (x, y) => [y, x], 6: (x, y) => [y, h - 1 - x], 7: (x, y) => [w - 1 - y, h - 1 - x], 8: (x, y) => [w - 1 - y, x],
  }[o];
  const out = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const [sx, sy] = src(x, y);
    const s = (sy * w + sx) * 4, d = (y * W + x) * 4;
    out[d] = data[s]; out[d + 1] = data[s + 1]; out[d + 2] = data[s + 2]; out[d + 3] = data[s + 3];
  }
  return { data: out, w: W, h: H };
}

/** A PNG as RGBA pixels (8/16-bit, every colour type, palette transparency), or null for interlaced files. */
export function decodePng(b) {
  let i = 8, w, h, depth, ctype, interlace, palette = null, trns = null;
  const idat = [];
  while (i + 8 <= b.length) {
    const len = b.readUInt32BE(i);
    const type = b.toString('ascii', i + 4, i + 8);
    const d = b.subarray(i + 8, i + 8 + len);
    if (type === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); depth = d[8]; ctype = d[9]; interlace = d[12]; }
    else if (type === 'PLTE') palette = d;
    else if (type === 'tRNS') trns = d;
    else if (type === 'IDAT') idat.push(d);
    else if (type === 'IEND') break;
    i += 12 + len;
  }
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ctype];
  if (!w || !h || !channels || interlace) return null;
  const bpp = channels * depth;
  const step = Math.max(1, bpp >> 3);
  const stride = Math.ceil((w * bpp) / 8);
  const raw = inflateSync(Buffer.concat(idat));
  const px = Buffer.alloc(stride * h);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = px.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= step ? cur[x - step] : 0, up = prev[x], c = x >= step ? prev[x - step] : 0;
      let v = line[x];
      if (f === 1) v += a;
      else if (f === 2) v += up;
      else if (f === 3) v += (a + up) >> 1;
      else if (f === 4) { const p = a + up - c, pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? up : c; }
      cur[x] = v & 0xff;
    }
    prev = cur;
  }
  const sample = (row, idx) => {
    if (depth === 8) return px[row * stride + idx];
    if (depth === 16) return px[row * stride + idx * 2];
    const bitPos = idx * depth, byte = px[row * stride + (bitPos >> 3)];
    return (byte >> (8 - depth - (bitPos & 7))) & ((1 << depth) - 1);
  };
  const scale = depth < 8 && ctype === 0 ? 255 / ((1 << depth) - 1) : 1;
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 4, s = x * channels;
    let r, g, bl, al = 255;
    if (ctype === 3) {
      const k = sample(y, x);
      r = palette[k * 3]; g = palette[k * 3 + 1]; bl = palette[k * 3 + 2];
      if (trns && k < trns.length) al = trns[k];
    } else if (ctype === 0 || ctype === 4) {
      const v = sample(y, s);
      r = g = bl = Math.round(v * scale);
      if (ctype === 4) al = sample(y, s + 1);
      else if (trns && depth === 8 && v === trns.readUInt16BE(0)) al = 0;
    } else {
      r = sample(y, s); g = sample(y, s + 1); bl = sample(y, s + 2);
      if (ctype === 6) al = sample(y, s + 3);
      else if (trns && depth === 8 && r === trns.readUInt16BE(0) && g === trns.readUInt16BE(2) && bl === trns.readUInt16BE(4)) al = 0;
    }
    out[o] = r; out[o + 1] = g; out[o + 2] = bl; out[o + 3] = al;
  }
  return { data: out, w, h };
}

/** Transparency composited onto white — a JPEG has no alpha, and black is what "no alpha" looks like. */
export function flattenWhite(d) {
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3];
    if (a === 255) continue;
    const k = a / 255;
    d[i] = Math.round(d[i] * k + 255 * (1 - k));
    d[i + 1] = Math.round(d[i + 1] * k + 255 * (1 - k));
    d[i + 2] = Math.round(d[i + 2] * k + 255 * (1 - k));
    d[i + 3] = 255;
  }
}

/** Area-average downscale (each output pixel is the mean of the source area it covers — no aliasing). */
export function resizeRGBA(src, w, h, nw, nh) {
  const weights = (n, nn) => {
    const s = n / nn, all = [];
    for (let d = 0; d < nn; d++) {
      const a = d * s, z = a + s, ws = [];
      for (let i = Math.floor(a); i < Math.min(n, Math.ceil(z)); i++) {
        const wt = Math.min(z, i + 1) - Math.max(a, i);
        if (wt > 0) ws.push(i, wt / s);
      }
      all.push(ws);
    }
    return all;
  };
  const wx = weights(w, nw), wy = weights(h, nh);
  const tmp = new Float32Array(nw * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < nw; x++) {
    const ws = wx[x];
    let r = 0, g = 0, b = 0, a = 0;
    for (let k = 0; k < ws.length; k += 2) {
      const o = (y * w + ws[k]) * 4, f = ws[k + 1];
      r += src[o] * f; g += src[o + 1] * f; b += src[o + 2] * f; a += src[o + 3] * f;
    }
    const t = (y * nw + x) * 4;
    tmp[t] = r; tmp[t + 1] = g; tmp[t + 2] = b; tmp[t + 3] = a;
  }
  const out = new Uint8Array(nw * nh * 4);
  for (let y = 0; y < nh; y++) {
    const ws = wy[y];
    for (let x = 0; x < nw; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let k = 0; k < ws.length; k += 2) {
        const o = (ws[k] * nw + x) * 4, f = ws[k + 1];
        r += tmp[o] * f; g += tmp[o + 1] * f; b += tmp[o + 2] * f; a += tmp[o + 3] * f;
      }
      const t = (y * nw + x) * 4;
      out[t] = Math.round(r); out[t + 1] = Math.round(g); out[t + 2] = Math.round(b); out[t + 3] = Math.round(a);
    }
  }
  return out;
}

/** The codec engine on its own (exported for tests). JPEG and PNG only; anything else -> null. */
export function codecShrink(buf, from, maxEdge = MAX_EDGE, maxBytes = MAX_BYTES) {
  let img;
  try {
    if (from.format === 'jpeg') {
      const d = jpegDecode(buf, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: 100, maxMemoryUsageInMB: 1024 });
      img = orient({ data: d.data, w: d.width, h: d.height }, jpegOrientation(buf));
    } else if (from.format === 'png') {
      img = decodePng(buf);
      if (!img) return null;
    } else return null;
  } catch { return null; }
  flattenWhite(img.data);
  for (const edge of edgeSteps(maxEdge)) {
    const k = Math.min(1, edge / Math.max(img.w, img.h));
    const nw = Math.max(1, Math.round(img.w * k)), nh = Math.max(1, Math.round(img.h * k));
    const px = k < 1 ? resizeRGBA(img.data, img.w, img.h, nw, nh) : img.data;
    for (const q of QUALITIES) {
      const out = Buffer.from(jpegEncode({ data: px, width: nw, height: nh }, q).data);
      if (out.length <= maxBytes) return { buffer: out, engine: 'codec', quality: q };
    }
    if (k === 1) break; // already at its own size — a smaller step would be an upscale of nothing
  }
  return null;
}

// ── engine 3: a tool this machine already has ─────────────────────────────────────────────────────
let toolCache;
export function localTool() {
  if (toolCache !== undefined) return toolCache;
  const has = (cmd, args) => { try { return spawnSync(cmd, args, { stdio: 'ignore', timeout: 15000 }).status === 0; } catch { return false; } };
  if (process.platform === 'darwin' && has('sips', ['--help'])) toolCache = 'sips';
  else if (has('magick', ['-version'])) toolCache = 'magick';
  else if (process.platform !== 'win32' && has('convert', ['-version'])) toolCache = 'convert'; // on Windows `convert` is a disk tool
  else if (process.platform === 'win32' && has('powershell', ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'])) toolCache = 'powershell';
  else toolCache = null;
  return toolCache;
}

// Windows' own imaging (WIC, through PresentationCore): decodes JPEG, PNG, GIF, BMP, TIFF, and WebP/HEIC
// where Windows has those codecs. Sent as -EncodedCommand, so no script file and no execution-policy
// change; the only values spliced in are this process's own temp paths and two numbers, and the paths
// are single-quoted with any quote doubled.
const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;
const PS_BODY = `
Add-Type -AssemblyName PresentationCore
$s = [IO.File]::OpenRead($in)
try {
  $dec = [Windows.Media.Imaging.BitmapDecoder]::Create($s, [Windows.Media.Imaging.BitmapCreateOptions]::PreservePixelFormat, [Windows.Media.Imaging.BitmapCacheOption]::OnLoad)
} finally { $s.Close() }
$f = $dec.Frames[0]
$k = [Math]::Min(1.0, [double]$edge / [Math]::Max($f.PixelWidth, $f.PixelHeight))
$src = $f
if ($k -lt 1.0) { $src = New-Object Windows.Media.Imaging.TransformedBitmap($f, (New-Object Windows.Media.ScaleTransform($k, $k))) }
$c = New-Object Windows.Media.Imaging.FormatConvertedBitmap($src, [Windows.Media.PixelFormats]::Bgr24, $null, 0)
$e = New-Object Windows.Media.Imaging.JpegBitmapEncoder
$e.QualityLevel = [int]$q
$e.Frames.Add([Windows.Media.Imaging.BitmapFrame]::Create($c))
$o = [IO.File]::Create($out)
try { $e.Save($o) } finally { $o.Close() }
`;

function runTool(tool, input, output, edge, q, needsResize) {
  switch (tool) {
    case 'sips':
      return spawnSync('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', String(q), ...(needsResize ? ['-Z', String(edge)] : []), input, '--out', output], { stdio: 'ignore', timeout: 60000 });
    case 'magick':
    case 'convert':
      return spawnSync(tool, [input, '-auto-orient', '-resize', `${edge}x${edge}>`, '-background', 'white', '-alpha', 'remove', '-alpha', 'off', '-quality', String(q), output], { stdio: 'ignore', timeout: 60000 });
    case 'powershell': {
      const script = `$in = ${psQuote(input)}; $out = ${psQuote(output)}; $edge = ${Number(edge)}; $q = ${Number(q)}\n${PS_BODY}`;
      const encoded = Buffer.from(script, 'utf16le').toString('base64');
      return spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { stdio: 'ignore', timeout: 60000 });
    }
    default: return { status: 1 };
  }
}

function localEngine(buf, from, maxEdge, maxBytes) {
  const tool = localTool();
  if (!tool) return null;
  const dir = mkdtempSync(join(tmpdir(), 'cj-img-'));
  try {
    const input = join(dir, `in.${extFor(from.format)}`);
    writeFileSync(input, buf);
    for (const edge of edgeSteps(maxEdge)) {
      const needsResize = from.width == null || Math.max(from.width, from.height) > edge;
      for (const q of QUALITIES) {
        const output = join(dir, `out-${edge}-${q}.jpg`);
        const r = runTool(tool, input, output, edge, q, needsResize);
        if (r.status !== 0) return null;
        let out;
        try { out = readFileSync(output); } catch { return null; }
        const p = probe(out);
        if (p.format === 'jpeg' && p.bytes <= maxBytes) return { buffer: out, engine: `local-tool:${tool}`, quality: q };
      }
      if (!needsResize) break;
    }
    return null;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// Windows' own imaging again, as a CONVERTER only: any format it reads → a plain (not interlaced) PNG, which the
// shipped codec then reads. Measured 30-09-2026 on Windows 10: a WebP decodes ("Microsoft Webp Decoder") and the
// PNG it writes decodes in decodePng().
const PS_PNG = `
Add-Type -AssemblyName PresentationCore
$s = [IO.File]::OpenRead($in)
try {
  $dec = [Windows.Media.Imaging.BitmapDecoder]::Create($s, [Windows.Media.Imaging.BitmapCreateOptions]::PreservePixelFormat, [Windows.Media.Imaging.BitmapCacheOption]::OnLoad)
} finally { $s.Close() }
$e = New-Object Windows.Media.Imaging.PngBitmapEncoder
$e.Interlace = [Windows.Media.Imaging.PngInterlaceOption]::Off
$e.Frames.Add([Windows.Media.Imaging.BitmapFrame]::Create($dec.Frames[0]))
$o = [IO.File]::Create($out)
try { $e.Save($o) } finally { $o.Close() }
`;

/**
 * A PNG the codec can read, for a file it cannot (WebP, AVIF, HEIC, GIF, an interlaced PNG) — or null.
 * CJ's image server converts on request (measured: `x-oss-process=image/format,png` returns a PNG); anything else
 * goes through a tool this machine has.
 */
export async function toPng(buf, from, url = null) {
  if (url && isCj(url)) {
    try {
      const b = await download(`${url}?x-oss-process=image/format,png`);
      if (probe(b).format === 'png') return b;
    } catch { /* the machine's own tool below */ }
  }
  const tool = localTool();
  if (!tool) return null;
  const dir = mkdtempSync(join(tmpdir(), 'cj-img-'));
  try {
    const input = join(dir, `in.${extFor(from.format)}`);
    const output = join(dir, 'out.png');
    writeFileSync(input, buf);
    let r;
    if (tool === 'sips') r = spawnSync('sips', ['-s', 'format', 'png', input, '--out', output], { stdio: 'ignore', timeout: 60000 });
    else if (tool === 'magick' || tool === 'convert') r = spawnSync(tool, [input, '-auto-orient', '-interlace', 'none', output], { stdio: 'ignore', timeout: 60000 });
    else {
      const script = `$in = ${psQuote(input)}; $out = ${psQuote(output)}\n${PS_PNG}`;
      r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { stdio: 'ignore', timeout: 60000 });
    }
    if (r.status !== 0) return null;
    let out;
    try { out = readFileSync(output); } catch { return null; }
    return probe(out).format === 'png' ? out : null;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/**
 * Bring one image under the ceiling.
 * -> { buffer, ext, engine, from: {format,width,height,bytes}, to: {...} }   or   { error, from }
 */
export async function shrink(buf, { url = null, maxEdge = MAX_EDGE, maxBytes = MAX_BYTES } = {}) {
  const from = probe(buf);
  const done = (r) => ({ buffer: r.buffer, ext: 'jpg', engine: r.engine, quality: r.quality, from, to: probe(r.buffer) });
  // A web-format file already under the ceiling is kept byte for byte, whatever its pixel size: re-encoding a
  // well-compressed photo only to reduce its pixels can make it HEAVIER (measured: 279 KB -> 303 KB), and the
  // store makes its own smaller copies. Only a file over the ceiling is re-encoded, and then also resized.
  if (['jpeg', 'png', 'gif', 'webp'].includes(from.format) && from.bytes <= maxBytes) {
    return { buffer: buf, ext: extFor(from.format), engine: 'none', from, to: from };
  }
  const viaServer = url ? await sourceServer(url, maxEdge, maxBytes) : null;
  if (viaServer) return done(viaServer);
  const viaCodec = codecShrink(buf, from, maxEdge, maxBytes);
  if (viaCodec) return done(viaCodec);
  const viaTool = localEngine(buf, from, maxEdge, maxBytes);
  if (viaTool) return done(viaTool);
  if (from.bytes <= maxBytes && from.format !== 'unknown') {
    return { buffer: buf, ext: extFor(from.format), engine: 'none', from, to: from,
      warning: `kept at ${from.width ?? '?'}x${from.height ?? '?'}: nothing here could resize it, but it is under the size ceiling` };
  }
  return { error: `${from.format} ${from.width ?? '?'}x${from.height ?? '?'}, ${Math.round(from.bytes / 1024)} KB — no engine could bring it under ${Math.round(maxBytes / 1024)} KB` +
    (localTool() ? '' : ' (no image tool found on this machine: install ImageMagick, or resize it by hand)'), from };
}

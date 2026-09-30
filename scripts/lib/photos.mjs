// photos.mjs — make one product photo at the catalogue's ONE format, ratio and pixel size.
//
// WHY: a listing crops every photo to its own ratio, photos of different sizes look differently sharp in one grid,
// and a store-setup check refuses a catalogue that mixes formats, ratios or sizes. Sources send whatever their
// sellers uploaded — measured on a real 20-product import: 3 formats, 42 of 165 photos not square, long edges
// 190–1920 px.
//
// A photo is fitted INSIDE the target and never cropped (a crop can cut the product off). The rest is padded,
// each side with the colour of that side's own edge. On a studio shot the edge is one colour and the padding
// cannot be seen; on a scene it shows as a band, so the photo is named for a person to look at (measured on the
// same import: 12 of the 42 off-ratio photos had a plain edge, 30 were scenes).
//
// The format is JPEG. A photo is enlarged at most MAX_ENLARGE times — beyond that it looks soft, and it is
// refused with its size instead. Every photo comes out at exactly the target's pixel size, under the upload
// ceiling; nothing is ever uploaded that was not made here.

import { createRequire } from 'node:module';
import { probe, decodePng, orient, jpegOrientation, flattenWhite, resizeRGBA, toPng, MAX_BYTES } from './images.mjs';

const require = createRequire(import.meta.url);
const jpegDecode = require('./vendor/jpeg-js/decoder.cjs');
const jpegEncode = require('./vendor/jpeg-js/encoder.cjs');

export const MAX_ENLARGE = 2;
const QUALITIES = [85, 75, 65, 55];
// An edge is "plain" when at least PLAIN_SHARE of its band is within PLAIN_TOLERANCE (per channel, 0–255) of the
// band's median colour. JPEG noise on a white studio backdrop stays within a few steps of 255.
const PLAIN_SHARE = 0.97;
const PLAIN_TOLERANCE = 16;

/** Pixels of a JPEG or PNG, or of any format a converter turns into a PNG. -> { data, w, h } or null */
async function pixels(buf, from, url) {
  try {
    if (from.format === 'jpeg') {
      const d = jpegDecode(buf, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: 100, maxMemoryUsageInMB: 1024 });
      return orient({ data: d.data, w: d.width, h: d.height }, jpegOrientation(buf));
    }
    if (from.format === 'png') {
      const img = decodePng(buf);
      if (img) return img;
    }
  } catch { /* a converter below may still read it */ }
  const png = await toPng(buf, from, url);
  if (!png) return null;
  try { return decodePng(png); } catch { return null; }
}

/** Bilinear enlargement (the area-average in images.mjs only shrinks). */
export function enlargeRGBA(src, w, h, nw, nh) {
  const out = new Uint8Array(nw * nh * 4);
  const sx = w / nw, sy = h / nh;
  for (let y = 0; y < nh; y++) {
    const fy = Math.min(h - 1, Math.max(0, (y + 0.5) * sy - 0.5));
    const y0 = Math.floor(fy), y1 = Math.min(h - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < nw; x++) {
      const fx = Math.min(w - 1, Math.max(0, (x + 0.5) * sx - 0.5));
      const x0 = Math.floor(fx), x1 = Math.min(w - 1, x0 + 1), tx = fx - x0;
      const a = (y0 * w + x0) * 4, b = (y0 * w + x1) * 4, c = (y1 * w + x0) * 4, d = (y1 * w + x1) * 4;
      const o = (y * nw + x) * 4;
      for (let k = 0; k < 4; k++) {
        const top = src[a + k] + (src[b + k] - src[a + k]) * tx;
        const bottom = src[c + k] + (src[d + k] - src[c + k]) * tx;
        out[o + k] = Math.round(top + (bottom - top) * ty);
      }
    }
  }
  return out;
}

/** The size a w×h photo takes INSIDE a W×H frame (nothing cut), and the scale that gives it. */
export function fitInside(w, h, W, H) {
  const k = Math.min(W / w, H / h);
  return { k, w: Math.min(W, Math.max(1, Math.round(w * k))), h: Math.min(H, Math.max(1, Math.round(h * k))) };
}

/**
 * The colour of one side's own edge band, and whether that band is one colour.
 * side: 'left' | 'right' | 'top' | 'bottom'. -> { rgb: [r,g,b], plain: boolean, share }
 */
export function edgeColour({ data, w, h }, side) {
  const band = Math.max(2, Math.round(Math.min(w, h) * 0.02));
  const at = [];
  if (side === 'left' || side === 'right') {
    const xs = Array.from({ length: Math.min(band, w) }, (_, i) => (side === 'left' ? i : w - 1 - i));
    for (let y = 0; y < h; y++) for (const x of xs) at.push((y * w + x) * 4);
  } else {
    const ys = Array.from({ length: Math.min(band, h) }, (_, i) => (side === 'top' ? i : h - 1 - i));
    for (const y of ys) for (let x = 0; x < w; x++) at.push((y * w + x) * 4);
  }
  const median = (c) => { const v = at.map((i) => data[i + c]).sort((a, b) => a - b); return v[v.length >> 1]; };
  const rgb = [median(0), median(1), median(2)];
  let near = 0;
  for (const i of at) {
    if (Math.abs(data[i] - rgb[0]) <= PLAIN_TOLERANCE && Math.abs(data[i + 1] - rgb[1]) <= PLAIN_TOLERANCE && Math.abs(data[i + 2] - rgb[2]) <= PLAIN_TOLERANCE) near++;
  }
  const share = at.length ? near / at.length : 0;
  return { rgb, plain: share >= PLAIN_SHARE, share };
}

const hex = (rgb) => `#${rgb.map((v) => v.toString(16).padStart(2, '0')).join('')}`;

/**
 * One photo at the target. `target` is targetOf(plan.photos); `url` the photo's source URL (CJ's image server can
 * convert a format the codec cannot read).
 * -> { buffer, to: {format, width, height, bytes}, from, changes[], edge: 'plain'|'scene'|null, scale, quality }
 *    or { error, from }
 */
export async function makePhoto(buf, target, { url = null, maxBytes = MAX_BYTES } = {}) {
  const from = probe(buf);
  const W = target.width, H = target.height;
  // Already exactly right: a JPEG at the target size, shown as stored, under the ceiling — kept byte for byte, so
  // a well-made photo is not re-encoded for nothing.
  if (from.format === 'jpeg' && from.width === W && from.height === H && jpegOrientation(buf) === 1 && from.bytes <= maxBytes) {
    return { buffer: buf, from, to: { format: 'jpeg', width: W, height: H, bytes: from.bytes }, changes: [], edge: null, scale: 1, quality: null };
  }
  const img = await pixels(buf, from, url);
  if (!img) {
    return { error: `${from.format} ${from.width ?? '?'}×${from.height ?? '?'}: nothing here can read this format — install ImageMagick, or exclude the photo`, from };
  }
  flattenWhite(img.data);
  const fit = fitInside(img.w, img.h, W, H);
  if (fit.k > MAX_ENLARGE) {
    return { error: `${img.w}×${img.h} would be enlarged ×${fit.k.toFixed(1)} to fit ${W}×${H} — above ×${MAX_ENLARGE} it looks soft: exclude it (low-quality), or choose a smaller photos.long_edge`, from };
  }
  const changes = [];
  if (from.format !== 'jpeg') changes.push(`converted ${from.format} → jpeg`);
  else if (jpegOrientation(buf) !== 1) changes.push('turned upright (the camera\'s orientation tag)');
  let px = img.data;
  if (fit.w !== img.w || fit.h !== img.h) {
    px = fit.k > 1 ? enlargeRGBA(img.data, img.w, img.h, fit.w, fit.h) : resizeRGBA(img.data, img.w, img.h, fit.w, fit.h);
    changes.push(`${fit.k > 1 ? 'enlarged' : 'reduced'} ×${fit.k.toFixed(2)} (${img.w}×${img.h} → ${fit.w}×${fit.h})`);
  }
  const sized = { data: px, w: fit.w, h: fit.h };

  // pad to the exact frame, each side with its own edge's colour
  let edge = null;
  let out = px;
  const padX = W - fit.w, padY = H - fit.h;
  if (padX > 0 || padY > 0) {
    const sides = padX > 0 ? ['left', 'right'] : ['top', 'bottom'];
    const [a, b] = sides.map((s) => edgeColour(sized, s));
    edge = a.plain && b.plain ? 'plain' : 'scene';
    const left = Math.floor(padX / 2), top = Math.floor(padY / 2);
    out = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const o = (y * W + x) * 4;
        const ix = x - left, iy = y - top;
        let c;
        if (ix >= 0 && iy >= 0 && ix < fit.w && iy < fit.h) {
          const s = (iy * fit.w + ix) * 4;
          out[o] = px[s]; out[o + 1] = px[s + 1]; out[o + 2] = px[s + 2]; out[o + 3] = 255;
          continue;
        }
        if (padX > 0) c = ix < 0 ? a.rgb : b.rgb;
        else c = iy < 0 ? a.rgb : b.rgb;
        out[o] = c[0]; out[o + 1] = c[1]; out[o + 2] = c[2]; out[o + 3] = 255;
      }
    }
    const colours = hex(a.rgb) === hex(b.rgb) ? hex(a.rgb) : `${hex(a.rgb)} / ${hex(b.rgb)}`;
    changes.push(`padded ${sides.join('+')} with ${colours} — ${edge === 'plain' ? 'plain edge, the padding does not show' : 'a scene: the padding shows as a band, look at it'}`);
  }

  // one size is the rule, so the quality steps down but the size never does
  for (const q of QUALITIES) {
    const enc = Buffer.from(jpegEncode({ data: out, width: W, height: H }, q).data);
    if (enc.length <= maxBytes) {
      if (!changes.length) changes.push(`re-encoded at quality ${q}, under the ${Math.round(maxBytes / 1024)} KB ceiling`);
      return { buffer: enc, from, to: { format: 'jpeg', width: W, height: H, bytes: enc.length }, changes, edge, scale: fit.k, quality: q };
    }
  }
  return { error: `too detailed for ${W}×${H} under ${Math.round(maxBytes / 1024)} KB even at quality ${QUALITIES.at(-1)} — choose a smaller photos.long_edge, or exclude it`, from };
}

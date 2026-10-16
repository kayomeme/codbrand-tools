// sheets.mjs — contact sheets: photos side by side in ONE image an agent can open and look at.
//
// WHY: an agent reads image files but not web pages, so review.html alone left the photo review to whoever had a
// browser — measured on a real import: the session built its own sheets, and 3 bad photos still went live.
// Each tile carries its number; the legend beside the sheet (a text file) says which file that is, its size and
// the decision. A green frame is kept, red excluded, grey not decided.

import { createRequire } from 'node:module';
import { resizeRGBA } from './images.mjs';
import { enlargeRGBA, fitInside } from './photos.mjs';

const require = createRequire(import.meta.url);
const jpegEncode = require('./vendor/jpeg-js/encoder.cjs');

export const TILE = 300;
export const COLS = 4;
export const PER_SHEET = 12;
const GAP = 12, BORDER = 8, SCALE = 4;
export const FRAME = { keep: [46, 125, 50], exclude: [198, 40, 40], other: [158, 158, 158] };

// The ten digits, 5×7, drawn SCALE times larger — enough to number tiles with no font file.
const DIGITS = {
  0: ['01110', '10001', '10011', '10101', '11001', '10001', '01110'], 1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  2: ['01110', '10001', '00001', '00010', '00100', '01000', '11111'], 3: ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
  4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'], 5: ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  6: ['00110', '01000', '10000', '11110', '10001', '10001', '01110'], 7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'], 9: ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
};

function fill(canvas, W, x0, y0, w, h, [r, g, b]) {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) {
    const o = (y * W + x) * 4;
    canvas[o] = r; canvas[o + 1] = g; canvas[o + 2] = b; canvas[o + 3] = 255;
  }
}

/** The number in black on a white box at (x0, y0). */
export function drawNumber(canvas, W, x0, y0, n) {
  const text = String(n);
  const pad = 6;
  fill(canvas, W, x0, y0, pad * 2 + text.length * 6 * SCALE - SCALE, pad * 2 + 7 * SCALE, [255, 255, 255]);
  [...text].forEach((d, k) => {
    DIGITS[d].forEach((row, ry) => [...row].forEach((bit, rx) => {
      if (bit === '1') fill(canvas, W, x0 + pad + k * 6 * SCALE + rx * SCALE, y0 + pad + ry * SCALE, SCALE, SCALE, [0, 0, 0]);
    }));
  });
}

/**
 * One sheet: tiles = [{ img: {data, w, h} | null, n, frame: 'keep' | 'exclude' | 'other' }] (at most PER_SHEET).
 * -> JPEG Buffer, COLS tiles wide.
 */
export function drawSheet(tiles) {
  const rows = Math.max(1, Math.ceil(tiles.length / COLS));
  const W = COLS * TILE + (COLS + 1) * GAP, H = rows * TILE + (rows + 1) * GAP;
  const canvas = new Uint8Array(W * H * 4);
  fill(canvas, W, 0, 0, W, H, [255, 255, 255]);
  tiles.forEach((t, i) => {
    const x0 = GAP + (i % COLS) * (TILE + GAP), y0 = GAP + Math.floor(i / COLS) * (TILE + GAP);
    fill(canvas, W, x0, y0, TILE, TILE, FRAME[t.frame] || FRAME.other);
    const inner = TILE - BORDER * 2;
    fill(canvas, W, x0 + BORDER, y0 + BORDER, inner, inner, [238, 238, 238]);
    if (t.img) {
      const fit = fitInside(t.img.w, t.img.h, inner, inner);
      const px = fit.k > 1 ? enlargeRGBA(t.img.data, t.img.w, t.img.h, fit.w, fit.h)
        : fit.w === t.img.w && fit.h === t.img.h ? t.img.data : resizeRGBA(t.img.data, t.img.w, t.img.h, fit.w, fit.h);
      const ox = x0 + BORDER + Math.floor((inner - fit.w) / 2), oy = y0 + BORDER + Math.floor((inner - fit.h) / 2);
      for (let y = 0; y < fit.h; y++) {
        const from = y * fit.w * 4;
        canvas.set(px.subarray(from, from + fit.w * 4), ((oy + y) * W + ox) * 4);
      }
    }
    drawNumber(canvas, W, x0 + BORDER, y0 + BORDER, t.n);
  });
  return Buffer.from(jpegEncode({ data: canvas, width: W, height: H }, 82).data);
}

/** Tiles in groups of PER_SHEET: one sheet image each. */
export const pages = (tiles) => Array.from({ length: Math.ceil(tiles.length / PER_SHEET) }, (_, k) => tiles.slice(k * PER_SHEET, (k + 1) * PER_SHEET));

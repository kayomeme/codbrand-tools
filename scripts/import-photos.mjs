#!/usr/bin/env node
/**
 * import-photos.mjs — step 3 of a product import: every KEPT photo at the plan's one format, ratio and size.
 *
 *   node import-photos.mjs [--dir product-import] [--dry-run]
 *
 * Reads plan.json's `photos` — { "ratio": "1:1", "long_edge": 1000 } — and makes each kept photo at exactly that
 * pixel size, as JPEG, under the store's upload ceiling: fitted inside the frame (never cropped), the rest padded
 * with the photo's own edge colour, enlarged at most ×2. Writes images/<key>/final/…jpg, records on each photo in
 * plan.json what was changed, and writes review.html again so every photo can be looked at as it will be uploaded.
 * Nothing is sent to the store; import-apply.mjs uploads these files and refuses a photo that was not made here.
 *
 *   --dry-run   the same report, nothing written
 *
 * Exit 0 = every kept photo made. Exit 1 = something to fix (each photo is named).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { targetOf, keyOf, MIN_LONG_EDGE } from './lib/plan.mjs';
import { makePhoto } from './lib/photos.mjs';
import { reviewHtml, kb, sourceLongEdge } from './lib/review.mjs';

const argv = process.argv.slice(2);
const dirIdx = argv.indexOf('--dir');
const DIR = resolve(dirIdx !== -1 ? argv[dirIdx + 1] : 'product-import');
const DRY = argv.includes('--dry-run');
const sha = (b) => createHash('sha256').update(b).digest('hex');
const say = (s = '') => console.log(s);

async function main() {
  const planPath = join(DIR, 'plan.json');
  if (!existsSync(planPath)) { console.error(`✗ no plan at ${planPath} — run import-fetch.mjs first`); return 1; }
  const plan = JSON.parse(readFileSync(planPath, 'utf8'));
  const minEdge = plan.photos?.min_long_edge ?? MIN_LONG_EDGE;
  const keptOf = (p) => p.images.filter((i) => i.decision === 'keep' && i.file && !i.error);

  const target = targetOf(plan.photos);
  if (target.error) {
    say(`import-photos: REFUSED — ${target.error}.\n`);
    say('The kept photos, as fetched, to help choose (set "photos": { "ratio": …, "long_edge": … } in plan.json):');
    const ratios = new Map(), edges = [];
    for (const p of plan.products) for (const i of keptOf(p)) {
      const t = i.shrink?.to;
      if (!t?.width) continue;
      const r = t.width / t.height;
      const name = Math.abs(r - 1) <= 0.02 ? '1:1' : Math.abs(r - 3 / 4) <= 0.02 ? '3:4' : Math.abs(r - 4 / 5) <= 0.02 ? '4:5' : Math.abs(r - 2 / 3) <= 0.02 ? '2:3' : Math.abs(r - 4 / 3) <= 0.02 ? '4:3' : r < 1 ? 'other, taller' : 'other, wider';
      ratios.set(name, (ratios.get(name) || 0) + 1);
      edges.push(Math.max(t.width, t.height));
    }
    say(`  ratios: ${[...ratios].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ×${n}`).join(', ') || 'none kept yet'}`);
    if (edges.length) {
      for (const L of [800, 1000, 1200, 1600]) {
        const up = edges.filter((e) => L / e > 1.001).length, over = edges.filter((e) => L / e > 2).length;
        say(`  long_edge ${L}: ${up} of ${edges.length} enlarged${over ? `, ${over} of them more than ×2 (refused)` : ''}`);
      }
    }
    say('\nThe ratio is the store\'s listing ratio (its product cards\' image box), or the one the merchant chose.');
    return 1;
  }

  const sources = {};
  const srcDir = join(DIR, 'source');
  if (existsSync(srcDir)) {
    for (const f of readdirSync(srcDir).filter((x) => x.endsWith('.json'))) {
      const s = JSON.parse(readFileSync(join(srcDir, f), 'utf8'));
      sources[keyOf(s)] = s;
    }
  }

  say(`import-photos ${DRY ? '(DRY RUN — nothing is written) ' : ''}— every kept photo as jpeg · ${target.key.split('@')[0]} · ${target.width}×${target.height}\n`);
  const errors = [];
  const tally = { photos: 0, cached: 0, unchanged: 0, converted: 0, plain: 0, scene: 0, enlarged: 0, reduced: 0, maxUp: 1 };
  const small = [];
  for (const p of plan.products) {
    const kept = keptOf(p);
    if (!kept.length) continue;
    say(`• ${p.copy?.title || sources[p.key]?.facts?.title || p.key}  [${p.key}]`);
    for (const img of kept) {
      tally.photos++;
      const edge = sourceLongEdge(img);
      if (edge != null && edge < minEdge) small.push(`${p.key}: ${img.file} ${img.shrink.from.width}×${img.shrink.from.height}`);
      const path = join(DIR, img.file);
      if (!existsSync(path)) { errors.push(`${p.key}: ${img.file} — file missing; run import-fetch.mjs again`); continue; }
      const bytes = readFileSync(path);
      const srcSha = sha(bytes);
      const f = img.final;
      if (f && f.target === target.key && f.source_sha === srcSha && existsSync(join(DIR, f.file))) {
        tally.cached++;
        count(tally, f);
        continue; // already made from this very file at this target
      }
      const r = await makePhoto(bytes, target, { url: img.original_url || img.source_url });
      if (r.error) {
        errors.push(`${p.key}: ${img.file} — ${r.error}`);
        if (!DRY) delete img.final;
        continue;
      }
      const file = `${dirname(img.file)}/final/${basename(img.file).replace(/\.[^.]+$/, '')}.jpg`;
      const final = { file, target: target.key, source_sha: srcSha, from: slim(r.from), to: r.to, changes: r.changes, edge: r.edge, quality: r.quality };
      count(tally, final);
      say(`    ${basename(img.file)}  ${r.from.format} ${r.from.width}×${r.from.height} → ${target.width}×${target.height}, ${kb(r.to.bytes)}${r.changes.length ? ` — ${r.changes.join('; ')}` : ' — already right, kept as it is'}`);
      if (!DRY) {
        mkdirSync(join(DIR, dirname(file)), { recursive: true });
        writeFileSync(join(DIR, file), r.buffer);
        img.final = final;
      }
    }
  }

  say(`\n${tally.photos} kept photo(s) → jpeg · ${target.width}×${target.height}${tally.cached ? ` (${tally.cached} already made, unchanged since)` : ''}:`);
  say(`  kept as they were ${tally.unchanged} · converted to jpeg ${tally.converted} · enlarged ${tally.enlarged}${tally.enlarged ? ` (at most ×${tally.maxUp.toFixed(2)})` : ''} · reduced ${tally.reduced}`);
  say(`  padded ${tally.plain + tally.scene}: ${tally.plain} on a plain edge (invisible), ${tally.scene} scene(s) where the padding shows as a band — look at those in review.html (dashed frame)`);
  if (small.length) say(`\nUnder ${minEdge} px on the long edge, as the source offers them (${small.length}) — each is enlarged, and softer for it:\n  ${small.join('\n  ')}`);
  if (errors.length) say(`\n✗ ${errors.length} photo(s) could not be made:\n  ${errors.join('\n  ')}`);

  if (!DRY) {
    writeFileSync(planPath, JSON.stringify(plan, null, 2) + '\n');
    writeFileSync(join(DIR, 'review.html'), reviewHtml(plan, sources));
    say(`\nplan.json and review.html updated. ${errors.length ? 'Fix the photos above, then run this again.' : 'Next: import-apply.mjs --dry-run.'}`);
  }
  return errors.length ? 1 : 0;
}

function count(t, f) {
  if (!f.changes.length) { t.unchanged++; return; }
  if (f.changes.some((c) => c.startsWith('converted'))) t.converted++;
  const up = f.changes.find((c) => c.startsWith('enlarged'));
  if (up) { t.enlarged++; t.maxUp = Math.max(t.maxUp, Number(up.match(/×([\d.]+)/)?.[1] || 1)); }
  if (f.changes.some((c) => c.startsWith('reduced'))) t.reduced++;
  if (f.edge === 'plain') t.plain++;
  if (f.edge === 'scene') t.scene++;
}

const slim = (p) => ({ format: p.format, width: p.width, height: p.height, bytes: p.bytes });

main().then((code) => { process.exitCode = code; }, (e) => { console.error(`✗ ${e.message}`); process.exitCode = 1; });

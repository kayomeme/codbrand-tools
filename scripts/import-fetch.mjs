#!/usr/bin/env node
/**
 * import-fetch.mjs — step 1 of a product import: get the products, their photos, and a plan to review.
 *
 *   node import-fetch.mjs [--out <folder>] <product URL or CJ product id> ...
 *   node import-fetch.mjs [--out <folder>] --page <product-captures-….json> ...
 *
 * Sources: CJdropshipping, AliExpress, Alibaba, Shopify stores, WooCommerce stores, and any product page that
 * publishes schema.org product data. By URL, a plain fetch is used where the source allows it (CJ's official
 * API when CJ_ACCESS_TOKEN is set; a Shopify store's product file; a WooCommerce page; a schema.org page).
 * Where it does not (AliExpress and Alibaba always; any site that answers a script with a human check), it says
 * so, and the product is captured in a browser with page-capture.js + page-download.js, then given with --page.
 *
 * Writes, in <folder> (default ./product-import):
 *   source/<key>.json   what the source says about each product — facts for the rewrite, its price for reference
 *   images/<key>/…      every photo, already under the store's upload ceiling (the source's original when a URL names
 *                       a resized copy of it); photos under the plan's minimum long edge are listed in the report
 *   plan.json           the decisions still to make — import-apply.mjs refuses until each is made
 *   review.html         a contact sheet of every photo, to open in a browser
 *
 * Running it again ADDS products and keeps every decision already written in plan.json.
 * It writes nothing to the store. Exit 0 = at least one product fetched; 1 = none (the reasons are printed).
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { fetchProduct, fromCapture, capturesIn, NeedsBrowser } from './lib/sources/index.mjs';
import { cjClient } from './lib/sources/cj-api.mjs';
import { downloadBest, shrink, MAX_BYTES } from './lib/images.mjs';
import { productEntry, mergePlan, keyOf, MIN_LONG_EDGE } from './lib/plan.mjs';
import { reviewHtml, PLATFORM, ROUTE, kb, sourceLongEdge } from './lib/review.mjs';

const argv = process.argv.slice(2);
const outIdx = argv.indexOf('--out');
const OUT = resolve(outIdx !== -1 ? argv[outIdx + 1] : 'product-import');
const rest = outIdx === -1 ? argv : argv.filter((_, i) => i !== outIdx && i !== outIdx + 1);
const pageMode = rest.includes('--page');
const inputs = rest.filter((a) => a !== '--page');

async function main() {
  if (!inputs.length) {
    console.error('usage: node import-fetch.mjs [--out <folder>] <product URL or CJ product id> ...\n' +
      '       node import-fetch.mjs [--out <folder>] --page <product-captures-….json> ...   (saved by page-download.js)');
    return 1;
  }

  // ── 1. the products ──
  const products = [];
  const needBrowser = [];
  if (pageMode) {
    for (const f of inputs) {
      let caps;
      try { caps = capturesIn(JSON.parse(readFileSync(f, 'utf8'))); } catch (e) { console.error(`✗ ${f}: ${e.message}`); continue; }
      for (const c of caps) {
        try { products.push(fromCapture(c)); } catch (e) { console.error(`✗ ${f} (${c.platform} ${c.id}): ${e.message}`); }
      }
    }
  } else {
    let cj = null;
    if (process.env.CJ_ACCESS_TOKEN) {
      cj = cjClient();
      try { await cj.init(); } catch (e) { console.error(`✗ ${e.message}`); return 1; }
    }
    for (const arg of inputs) {
      try { products.push(await fetchProduct(arg, { cj })); }
      catch (e) {
        if (e instanceof NeedsBrowser) needBrowser.push(`${arg}\n      ${e.message}`);
        else console.error(`✗ ${arg}: ${e.message}`);
        if (e.code === 1600001 || e.code === 1600002) return 1; // a bad CJ token fails every CJ product the same way
      }
    }
  }
  // the same product twice (a capture saved twice) — keep the last one
  const unique = [...new Map(products.map((p) => [keyOf(p), p])).values()];
  if (needBrowser.length) {
    console.log(`These need a browser (open each page, run scripts/page-capture.js on it, then page-download.js once per site in a NEW tab, then run this with --page <the saved file>):\n  • ${needBrowser.join('\n  • ')}\n`);
  }
  if (!unique.length) return 1;

  // ── 2. files: source, images ──
  mkdirSync(join(OUT, 'source'), { recursive: true });
  const planPath = join(OUT, 'plan.json');
  const oldPlan = existsSync(planPath) ? JSON.parse(readFileSync(planPath, 'utf8')) : null;
  const entries = [];
  const fetched = {}; // key -> this run's image list (for the report)
  for (const src of unique) {
    const key = keyOf(src);
    writeFileSync(join(OUT, 'source', `${key}.json`), JSON.stringify(src, null, 2) + '\n');
    mkdirSync(join(OUT, 'images', key), { recursive: true });
    const old = oldPlan?.products?.find((p) => p.key === key);
    const images = [];
    let n = 0;
    for (const img of src.images) {
      n++;
      const stem = `${String(n).padStart(2, '0')}-${createHash('sha1').update(img.url).digest('hex').slice(0, 8)}`;
      const prev = old?.images?.find((x) => x.source_url === img.url && x.file && existsSync(join(OUT, x.file)));
      if (prev) {
        images.push({ file: prev.file, url: img.url, roles: img.roles, values: img.values, shrink: prev.shrink,
          ...(prev.original_url ? { original_url: prev.original_url } : {}), ...(prev.error ? { error: prev.error } : {}) });
        continue;
      }
      try {
        // the source's own original when the URL names a resized copy of it, and it is larger
        const got = await downloadBest(img.url);
        const r = await shrink(got.buffer, { url: got.url });
        if (r.error) { images.push({ file: null, url: img.url, roles: img.roles, values: img.values, shrink: null, error: r.error }); continue; }
        const file = `images/${key}/${stem}.${r.ext}`;
        writeFileSync(join(OUT, file), r.buffer);
        images.push({ file, url: img.url, roles: img.roles, values: img.values,
          ...(got.url !== img.url ? { original_url: got.url, larger: got.larger } : {}),
          shrink: { engine: r.engine, from: slim(r.from), to: slim(r.to), ...(r.warning ? { warning: r.warning } : {}) } });
      } catch (e) {
        images.push({ file: null, url: img.url, roles: img.roles, values: img.values, shrink: null, error: e.message });
      }
    }
    fetched[key] = images;
    entries.push(productEntry(src, images));
  }

  // ── 3. the plan, merged with any decisions already made ──
  const plan = mergePlan(oldPlan, entries);
  writeFileSync(planPath, JSON.stringify(plan, null, 2) + '\n');
  const all = Object.fromEntries(readdirSync(join(OUT, 'source')).filter((f) => f.endsWith('.json'))
    .map((f) => { const s = JSON.parse(readFileSync(join(OUT, 'source', f), 'utf8')); return [keyOf(s), s]; }));
  writeFileSync(join(OUT, 'review.html'), reviewHtml(plan, all));

  // ── 4. the report ──
  const minEdge = plan.photos?.min_long_edge ?? MIN_LONG_EDGE;
  console.log(`Product import — ${unique.length} product(s) into ${relative(process.cwd(), OUT) || '.'}\n`);
  for (const e of entries) {
    const src = unique.find((p) => keyOf(p) === e.key);
    const shrunk = e.images.filter((i) => i.shrink && i.shrink.engine !== 'none');
    const failed = e.images.filter((i) => i.error);
    const larger = (fetched[e.key] || []).filter((i) => i.larger);
    // what the SOURCE offers, before any shrinking — description images included, the review decides on them
    const small = e.images.filter((i) => !i.error && sourceLongEdge(i) != null && sourceLongEdge(i) < minEdge);
    const amb = e.variants.filter((v) => !Array.isArray(v.source_values)).length;
    const dropped = e.options.filter((o) => o.drop).map((o) => o.source_name);
    console.log(`• ${src.facts.title}  [${e.key}]`);
    console.log(`    from: ${PLATFORM[src.platform] || src.platform}, by ${ROUTE[src.route] || src.route}${src.supplier ? '' : ' — a RETAILER\'s own content: the merchant must confirm they may use it (rights_confirmed)'}`);
    console.log(`    ${src.variants.length} variant(s)${src.options.length ? ` — ${src.options.map((o) => `${o.name}: ${o.values.length}`).join(', ')}` : ''}${src.image_option ? `; photo follows ${src.image_option}` : ''}${dropped.length ? `; dropped by default (one value): ${dropped.join(', ')}` : ''}${amb ? `; ${amb} to resolve by hand` : ''}`);
    console.log(`    ${e.images.length} image(s): ${e.images.filter((i) => i.decision === 'unreviewed').length} to review, ${e.images.filter((i) => i.decision === 'exclude').length} excluded by default (description images, failures)`);
    if (shrunk.length) console.log(`    shrunk ${shrunk.length}: ${shrunk.map((i) => `${kb(i.shrink.from.bytes)}→${kb(i.shrink.to.bytes)} (${i.shrink.engine})`).join(', ')}`);
    if (larger.length) console.log(`    larger original used for ${larger.length}: ${larger.map((i) => `${i.larger.from.join('×')} → ${i.larger.to.join('×')}`).join(', ')}`);
    if (small.length) console.log(`    under ${minEdge} px on the long edge (${small.length}): ${small.map((i) => `${i.file} ${i.shrink.from.width}×${i.shrink.from.height}`).join(', ')}`);
    for (const f of failed) console.log(`    ✗ ${f.url}: ${f.error}`);
    const pr = src.price;
    console.log(`    source ${pr.kind === 'cost' ? 'cost' : 'price'} ${pr.min ?? '?'}${pr.max != null && pr.max !== pr.min ? `–${pr.max}` : ''} ${pr.currency || '(currency unknown)'} — reference only; never a store price`);
    if (src.facts.moq > 1) console.log(`    ⚠ minimum order on the source: ${src.facts.moq} — check it can be bought one at a time before selling it`);
  }
  console.log(`\nNext: open review.html, then fill plan.json (prices, copy, image decisions, the photo target, variations${unique.some((p) => !p.supplier) ? ', rights' : ''}), run import-photos.mjs, then import-apply.mjs.`);
  console.log(`Every image is at most ${kb(MAX_BYTES)}. A photo under ${minEdge} px on its long edge, as the source offers it, is listed above and shown in red in review.html.`);
  return 0;
}

const slim = (p) => ({ format: p.format, width: p.width, height: p.height, bytes: p.bytes });

main().then((code) => { process.exitCode = code; }, (e) => { console.error(`✗ ${e.message}`); process.exitCode = 1; });

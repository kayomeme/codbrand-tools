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
 *   images/<key>/…      every photo, already under the store's upload ceiling
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
import { download, shrink, MAX_BYTES } from './lib/images.mjs';
import { productEntry, mergePlan, keyOf } from './lib/plan.mjs';

const argv = process.argv.slice(2);
const outIdx = argv.indexOf('--out');
const OUT = resolve(outIdx !== -1 ? argv[outIdx + 1] : 'product-import');
const rest = outIdx === -1 ? argv : argv.filter((_, i) => i !== outIdx && i !== outIdx + 1);
const pageMode = rest.includes('--page');
const inputs = rest.filter((a) => a !== '--page');

const PLATFORM = { cjdropshipping: 'CJdropshipping', aliexpress: 'AliExpress', alibaba: 'Alibaba', shopify: 'Shopify store', woocommerce: 'WooCommerce store', jsonld: 'product page (schema.org)' };
const ROUTE = { api: 'official API', fetch: 'plain fetch', page: 'browser capture' };

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
      if (prev) { images.push({ file: prev.file, url: img.url, roles: img.roles, values: img.values, shrink: prev.shrink, ...(prev.error ? { error: prev.error } : {}) }); continue; }
      try {
        const raw = await download(img.url);
        const r = await shrink(raw, { url: img.url });
        if (r.error) { images.push({ file: null, url: img.url, roles: img.roles, values: img.values, shrink: null, error: r.error }); continue; }
        const file = `images/${key}/${stem}.${r.ext}`;
        writeFileSync(join(OUT, file), r.buffer);
        images.push({ file, url: img.url, roles: img.roles, values: img.values,
          shrink: { engine: r.engine, from: slim(r.from), to: slim(r.to), ...(r.warning ? { warning: r.warning } : {}) } });
      } catch (e) {
        images.push({ file: null, url: img.url, roles: img.roles, values: img.values, shrink: null, error: e.message });
      }
    }
    entries.push(productEntry(src, images));
  }

  // ── 3. the plan, merged with any decisions already made ──
  const plan = mergePlan(oldPlan, entries);
  writeFileSync(planPath, JSON.stringify(plan, null, 2) + '\n');
  const all = Object.fromEntries(readdirSync(join(OUT, 'source')).filter((f) => f.endsWith('.json'))
    .map((f) => { const s = JSON.parse(readFileSync(join(OUT, 'source', f), 'utf8')); return [keyOf(s), s]; }));
  writeFileSync(join(OUT, 'review.html'), reviewHtml(plan, all));

  // ── 4. the report ──
  console.log(`Product import — ${unique.length} product(s) into ${relative(process.cwd(), OUT) || '.'}\n`);
  for (const e of entries) {
    const src = unique.find((p) => keyOf(p) === e.key);
    const shrunk = e.images.filter((i) => i.shrink && i.shrink.engine !== 'none');
    const failed = e.images.filter((i) => i.error);
    const amb = e.variants.filter((v) => !Array.isArray(v.source_values)).length;
    const dropped = e.options.filter((o) => o.drop).map((o) => o.source_name);
    console.log(`• ${src.facts.title}  [${e.key}]`);
    console.log(`    from: ${PLATFORM[src.platform] || src.platform}, by ${ROUTE[src.route] || src.route}${src.supplier ? '' : ' — a RETAILER\'s own content: the merchant must confirm they may use it (rights_confirmed)'}`);
    console.log(`    ${src.variants.length} variant(s)${src.options.length ? ` — ${src.options.map((o) => `${o.name}: ${o.values.length}`).join(', ')}` : ''}${src.image_option ? `; photo follows ${src.image_option}` : ''}${dropped.length ? `; dropped by default (one value): ${dropped.join(', ')}` : ''}${amb ? `; ${amb} to resolve by hand` : ''}`);
    console.log(`    ${e.images.length} image(s): ${e.images.filter((i) => i.decision === 'unreviewed').length} to review, ${e.images.filter((i) => i.decision === 'exclude').length} excluded by default (description images, failures)`);
    if (shrunk.length) console.log(`    shrunk ${shrunk.length}: ${shrunk.map((i) => `${kb(i.shrink.from.bytes)}→${kb(i.shrink.to.bytes)} (${i.shrink.engine})`).join(', ')}`);
    for (const f of failed) console.log(`    ✗ ${f.url}: ${f.error}`);
    const pr = src.price;
    console.log(`    source ${pr.kind === 'cost' ? 'cost' : 'price'} ${pr.min ?? '?'}${pr.max != null && pr.max !== pr.min ? `–${pr.max}` : ''} ${pr.currency || '(currency unknown)'} — reference only; never a store price`);
    if (src.facts.moq > 1) console.log(`    ⚠ minimum order on the source: ${src.facts.moq} — check it can be bought one at a time before selling it`);
  }
  console.log(`\nNext: open review.html, then fill plan.json (prices, copy, image decisions, variations${unique.some((p) => !p.supplier) ? ', rights' : ''}) and run import-apply.mjs.`);
  console.log(`Every image is at most ${kb(MAX_BYTES)}.`);
  return 0;
}

const slim = (p) => ({ format: p.format, width: p.width, height: p.height, bytes: p.bytes });
const kb = (b) => `${Math.round(b / 1024)} KB`;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function reviewHtml(plan, sources) {
  const cards = plan.products.map((p) => {
    const s = sources[p.key];
    if (!s) return '';
    const imgs = p.images.map((i) => `
      <figure class="${esc(i.decision)}">
        ${i.file ? `<img src="${esc(i.file)}" loading="lazy" alt="">` : '<div class="missing">not downloaded</div>'}
        <figcaption><b>${esc(i.file || '—')}</b><br>${esc(i.roles.join(' + '))}${i.values?.length ? ` · ${esc(i.values.join(', '))}` : ''}<br>
        ${i.shrink ? `${kb(i.shrink.from.bytes)} ${i.shrink.from.width}×${i.shrink.from.height} → ${kb(i.shrink.to.bytes)} ${i.shrink.to.width}×${i.shrink.to.height} (${esc(i.shrink.engine)})` : esc(i.error || '')}<br>
        <span class="dec">${esc(i.decision)}${i.reason ? ` — ${esc(i.reason)}` : ''}</span></figcaption>
      </figure>`).join('');
    const specs = s.facts.specs.length ? `<table>${s.facts.specs.map((x) => `<tr><th>${esc(x.name)}</th><td>${esc(x.value)}</td></tr>`).join('')}</table>` : '';
    return `
    <section>
      <h2>${esc(s.facts.title)}</h2>
      <p class="meta">${esc(PLATFORM[s.platform] || s.platform)} · ${esc(s.pid)}${s.product_sku ? ` · SKU ${esc(s.product_sku)}` : ''} · ${esc(ROUTE[s.route] || s.route)}${s.url ? ` · <a href="${esc(s.url)}">source page</a>` : ''}</p>
      ${s.supplier ? '' : '<p class="warn">A retailer\'s own content — use it only if the merchant confirms they may (rights_confirmed).</p>'}
      ${s.facts.moq > 1 ? `<p class="warn">Minimum order on the source: ${esc(s.facts.moq)}.</p>` : ''}
      <p class="meta">${esc(s.facts.category_path.join(' › '))}${s.facts.brand ? ` · brand: ${esc(s.facts.brand)}` : ''}${s.facts.material.length ? ` · material: ${esc(s.facts.material.join(', '))}` : ''}</p>
      <p class="meta">${s.options.map((o) => `${esc(o.name)}: ${esc(o.values.join(', '))}`).join('<br>')}</p>
      <p class="cost">Source ${s.price.kind === 'cost' ? 'cost' : 'price'} ${esc(s.price.min)}${s.price.max != null && s.price.max !== s.price.min ? `–${esc(s.price.max)}` : ''} ${esc(s.price.currency || '')} — reference for pricing, never shown to shoppers</p>
      ${specs ? `<details><summary>Specifications (facts to rewrite)</summary>${specs}</details>` : ''}
      ${s.facts.description_text ? `<details><summary>The source's description (facts to rewrite — never publish as-is)</summary><pre>${esc(s.facts.description_text)}</pre></details>` : ''}
      <div class="grid">${imgs}</div>
    </section>`;
  }).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Product import review</title><style>
body{font:14px/1.45 system-ui,sans-serif;margin:0;padding:16px;background:#f6f6f4;color:#1b1b1b}
section{background:#fff;border-radius:10px;padding:16px;margin:0 0 20px;box-shadow:0 1px 3px #0001}
h2{margin:0 0 6px;font-size:18px}.meta{margin:2px 0;color:#555}.cost{margin:8px 0;color:#8a4b00}.warn{margin:6px 0;color:#b00020;font-weight:600}
pre{white-space:pre-wrap;background:#fafafa;padding:8px;border-radius:6px;max-height:320px;overflow:auto}
table{border-collapse:collapse;margin:6px 0}th,td{text-align:left;padding:2px 10px 2px 0;vertical-align:top}th{color:#555;font-weight:500}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px;margin-top:12px}
figure{margin:0;border:2px solid #ddd;border-radius:8px;overflow:hidden;background:#fff}
figure.keep{border-color:#2e7d32}figure.exclude{border-color:#c62828;opacity:.6}
figure img{width:100%;aspect-ratio:1;object-fit:contain;background:#eee;display:block}
figcaption{font-size:12px;padding:6px;word-break:break-all}.dec{font-weight:600}.missing{aspect-ratio:1;display:grid;place-items:center;background:#eee}
</style></head><body><h1>Product import review</h1>
<p>Each photo is shown as it will be uploaded. Exclude watermarks, logos or brand marks, recognisable people, and text in another language. Decisions go in plan.json.</p>
${cards}</body></html>`;
}

main().then((code) => { process.exitCode = code; }, (e) => { console.error(`✗ ${e.message}`); process.exitCode = 1; });

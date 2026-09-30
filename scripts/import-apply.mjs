#!/usr/bin/env node
/**
 * import-apply.mjs — step 4 of a product import: write the reviewed plan into the store, as DRAFTS.
 *
 *   node import-apply.mjs <site-url> <api-key> [--plan product-import/plan.json] [--dry-run] [--publish]
 *
 *   --dry-run   every check, every read, and the list of writes it WOULD make. Writes nothing.
 *   --publish   after writing, publish each product and send its variations again (the shop's filter
 *               only counts options on published products, and publishing alone does not refresh it).
 *
 * It REFUSES, before the first write, while any of these holds (all are listed at once):
 *   rights    a product from a retailer's own store (not a supplier platform) lacks rights_confirmed: true
 *   price     a product or variant has no retail price, or a price is the source's own price, or at/below cost × fx
 *   copy      the title or description is missing or is the source's text as-is; no language set
 *   images    an image is unreviewed, kept without alt text, over the size ceiling, or excluded without a reason
 *   photos    the plan has no photo target, or a kept photo was not made at it by import-photos.mjs
 *   variants  an option is not mapped onto the store's variation library (nor dropped), or a split is unresolved;
 *             the store's type it would reuse is OPTIONAL (a shopper could order without choosing), or a type
 *             it would create has no error_msg
 *   door      the key lacks a scope it needs, a planned category does not exist, a slug belongs to another
 *             product, or a field this script sends is not in the store's own /openapi
 *
 * What it writes, per product: images (POST media, deduplicated — the files import-photos.mjs made), missing
 * categories, missing variation types (required, with the plan's error message) and options, the product
 * (created as a draft — or updated when record.json already has it), its variations and its priced combinations.
 * It never changes a variation type it did not create. record.json, beside the plan, is written after every product:
 * the source (platform + id + URL), the store's product id, each variant SKU and price, and every image with
 * its source and what was done to it. A re-run updates instead of duplicating, and an interrupted run resumes.
 *
 * Exit 0 = done (or dry run clean). Exit 1 = refused or failed (the reason is printed).
 */

import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { clapi } from './lib/clapi.mjs';
import { checkPlan, pricesFor, productBody, variationsBody, storeVariants, activeIdx, slugify, targetOf, libraryIssues, boxRatio } from './lib/plan.mjs';
import { MAX_BYTES } from './lib/images.mjs';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n) => { const i = argv.indexOf(n); return i !== -1 ? argv[i + 1] : null; };
const positional = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--plan');
const [SITE, KEY] = positional;
const PLAN = resolve(opt('--plan') || join('product-import', 'plan.json'));
const DIR = dirname(PLAN);
const DRY = flag('--dry-run');
const PUBLISH = flag('--publish');

const NEEDED = ['products', 'media', 'categories', 'global_variations', 'product_variations', 'product_variants'];
const sha = (b) => createHash('sha256').update(b).digest('hex');
const short = (s) => createHash('sha1').update(s).digest('hex').slice(0, 12);
const say = (s = '') => console.log(s);

async function main() {
  if (!SITE || !KEY) { console.error('usage: node import-apply.mjs <site-url> <api-key> [--plan product-import/plan.json] [--dry-run] [--publish]'); return 1; }
  if (!existsSync(PLAN)) { console.error(`✗ no plan at ${PLAN} — run import-fetch.mjs first`); return 1; }
  const plan = JSON.parse(readFileSync(PLAN, 'utf8'));
  const sources = {};
  for (const p of plan.products || []) {
    const f = join(DIR, p.source_file || `source/${p.key}.json`);
    if (existsSync(f)) sources[p.key] = JSON.parse(readFileSync(f, 'utf8'));
  }
  const recordPath = join(DIR, 'record.json');
  const record = existsSync(recordPath) ? JSON.parse(readFileSync(recordPath, 'utf8'))
    : { kind: 'import-record/1', site: null, products: {}, media: {} };
  const saveRecord = () => { if (!DRY) writeFileSync(recordPath, JSON.stringify(record, null, 2) + '\n'); };

  // ── 1. the plan's own gates — no network ──
  const fileBytes = (f) => { try { return statSync(join(DIR, f)).size; } catch { return null; } };
  const errors = checkPlan(plan, sources, { fileBytes, maxBytes: MAX_BYTES });

  // ── 2. the store's gates — reads only ──
  const api = clapi(SITE, KEY);
  const site = api.base.replace(/\/wp-json.*$/, '');
  record.site = record.site || site;
  if (record.site !== site) errors.push({ key: null, gate: 'door', message: `record.json belongs to ${record.site}, not this store — use a separate import folder per store` });
  const path = {};
  const catExists = {};
  const warnings = [];
  try {
    await storeGates(api, plan, record, path, catExists, errors, warnings);
  } catch (e) {
    errors.push({ key: null, gate: 'door', message: `${e.message} — the store's own checks could not run` });
  }
  for (const w of warnings) say(`  ! ${w}`);
  if (warnings.length) say();
  if (errors.length) {
    say(`import-apply: REFUSED — ${errors.length} thing(s) to fix before anything is written:\n`);
    for (const e of errors) say(`  ✗ [${e.gate}]${e.key ? ` ${e.key}` : ''}: ${e.message}`);
    return 1;
  }
  // media the products used before this run — to name the ones a re-import leaves unused (never deleted)
  const usedBefore = mediaInUse(record);

  // ── 3. the writes ──
  say(`import-apply ${DRY ? '(DRY RUN — nothing is written)' : ''} → ${record.site}\n`);
  const gvCache = {};
  for (const p of plan.products) {
    const src = sources[p.key];
    const rec = record.products[p.key] || { source: { platform: src.platform, product_id: src.pid, product_sku: src.product_sku, url: src.url, route: src.route }, images: [] };
    const prices = pricesFor(p, src, plan.pricing || {});
    say(`• ${p.copy.title}  [${p.key}]`);

    // images — what is uploaded is the file import-photos.mjs made (one format, ratio and size); the plan's gates
    // refused any kept photo without one
    const kept = p.images.filter((i) => i.decision === 'keep');
    const mediaFor = {};   // file -> media id
    const mediaUrl = {};   // file -> media URL (a photo swatch is drawn from its URL, not its id)
    let already = 0;
    const entries = [];
    for (const [n, img] of kept.entries()) {
      const bytes = readFileSync(join(DIR, img.final.file));
      const hash = sha(bytes);
      let m = record.media[hash];
      if (m) already++;
      if (!m && !DRY) {
        const body = { filename: `${p.copy.slug || slugify(p.copy.title)}-${String(n + 1).padStart(2, '0')}.jpg`, data_base64: bytes.toString('base64'), alt: img.alt, title: img.alt };
        const row = await api.post(path.media, body, `import-media-${hash.slice(0, 32)}`);
        m = record.media[hash] = { id: row.id, url: row.url };
      }
      mediaFor[img.file] = m?.id ?? `(new ${basename(img.file)})`;
      mediaUrl[img.file] = m?.url ?? null;
      entries.push({ file: img.file, uploaded: img.final.file, sha256: hash, media_id: m?.id ?? null, url: m?.url ?? null,
        source: { platform: src.platform, product_id: src.pid, values: img.values || [], original_url: img.source_url,
          ...(img.original_url ? { larger_original_url: img.original_url } : {}) },
        shrink: img.shrink, made: { target: img.final.target, changes: img.final.changes, edge: img.final.edge } });
    }
    // the product's photos are exactly these now; a photo it had before and no longer has is named below
    const replaced = (rec.images || []).filter((x) => x.media_id && !entries.some((e) => e.sha256 === x.sha256)).length;
    rec.images = entries;
    say(`    images: ${kept.length} kept (${already} already in the store's library)${replaced ? `; replaces ${replaced} photo(s) of the last import, which stay in the library` : ''}`);
    say(`    photos: ${photoLine(kept)}`);

    // categories
    for (const c of p.category?.create || []) {
      if (catExists[c.slug]) continue;
      say(`    category: create "${c.name}" (${c.slug})`);
      if (!DRY) await api.post(path.categories, { name: c.name, slug: c.slug, ...(c.parent_slug ? { parent_slug: c.parent_slug } : {}) }, `import-cat-${c.slug}`);
      catExists[c.slug] = true;
    }

    // the variation library — only for the options that stay
    const optionIds = {}; // optionIndex -> Map(source_value -> global option id)
    const gvIds = {};
    for (const oi of activeIdx(p)) {
      const o = p.options[oi];
      const g = o.global_variation;
      let gv = gvCache[g.slug];
      if (!gv) {
        const found = await api.get(path.global_variations, { slug: g.slug });
        gv = Array.isArray(found) && found[0] ? found[0] : null;
        if (gv && !gv.options) gv = await api.get(`${path.global_variations}/${gv.id}`);
        if (!gv) {
          // created REQUIRED, with the message a shopper reads when they order without choosing
          say(`    variation type: create "${g.title_in_product}" (${g.slug}, ${g.type}, required — "${g.error_msg}")`);
          gv = DRY ? { id: `(new ${g.slug})`, options: [] }
            : await api.post(path.global_variations, { slug: g.slug, title_in_product: g.title_in_product, type: g.type, is_required: 'yes', error_msg: String(g.error_msg).trim() }, `import-gv-${g.slug}`);
          gv.options = gv.options || [];
        }
        gvCache[g.slug] = gv;
      }
      gvIds[oi] = gv.id;
      const ids = new Map();
      for (const v of o.values.filter((x) => x.include !== false)) {
        const title = String(v.title).trim();
        let found = gv.options.find((x) => String(x.title).trim().toLowerCase() === title.toLowerCase());
        if (!found) {
          say(`    option: add "${title}" to ${g.slug}`);
          if (DRY) { found = { id: `(new ${title})`, title }; gv.options.push(found); }
          else {
            const after = await api.post(`${path.global_variations}/${gv.id}/options`, { title, ...(v.color_code ? { color_code: v.color_code } : {}) }, `import-gvo-${g.slug}-${short(title)}`);
            gv.options = after.options || gv.options;
            found = gv.options.find((x) => String(x.title).trim().toLowerCase() === title.toLowerCase());
            if (!found) throw new Error(`the store did not return option "${title}" after adding it to ${g.slug}`);
          }
        }
        ids.set(v.source_value, found.id);
      }
      optionIds[oi] = ids;
    }

    // the product. The gallery is EVERY kept photo, the featured one first: the product page shows the gallery
    // only (the featured image is for listings and cards), and a colour's photo switch can only jump to a photo
    // that is in the gallery — measured: a swatch pointing at the featured image did nothing.
    const galleryFiles = [p.featured, ...kept.map((i) => i.file).filter((f) => f !== p.featured)].filter(Boolean);
    const body = productBody(p, src, { prices, featuredId: mediaFor[p.featured], galleryIds: galleryFiles.map((f) => mediaFor[f]), create: !rec.product_id });
    if (rec.product_id) {
      say(`    product: update ${rec.product_id} — ${body.slug}, ${priceLine(prices)}`);
      if (!DRY) {
        try { await api.patch(`${path.products}/${rec.product_id}`, body); }
        catch (e) {
          if (e.status === 404) throw new Error(`product ${rec.product_id} (from record.json) no longer exists in the store — remove "${p.key}" from record.json to create it again`);
          throw e;
        }
      }
    } else {
      say(`    product: create draft — ${body.slug}, ${priceLine(prices)}`);
      if (!DRY) {
        const row = await api.post(path.products, body, `import-product-${p.key}-${short(JSON.stringify(body))}`);
        rec.product_id = row.id;
        rec.slug = body.slug;
        rec.status = 'draft';
        record.products[p.key] = rec;
        saveRecord(); // the product exists now: a failure below must not lose its id
      }
    }
    const productId = rec.product_id ?? '(new)';

    // its variations and priced combinations
    const active = activeIdx(p);
    if (active.length) {
      const media = Object.fromEntries(Object.keys(mediaFor).map((f) => [f, { id: mediaFor[f], url: mediaUrl[f] }]));
      const variations = variationsBody(p, productId, { gvIds, optionIds, media });
      const byVid = new Map((prices.variants || []).map((v) => [v.vid, v]));
      const chosen = storeVariants(p);
      const variants = {
        product_id: productId,
        variants: chosen.map((v) => {
          const pr = byVid.get(v.vid);
          return { option_ids: active.map((oi) => optionIds[oi].get(v.source_values[oi])),
            ...(pr?.combination_price != null ? { price: pr.combination_price } : {}),
            ...(v.sku ? { sku: v.sku } : {}) };
        }),
      };
      say(`    variations: ${active.map((oi) => `${p.options[oi].global_variation.slug} × ${p.options[oi].values.filter((x) => x.include !== false).length}`).join(', ')}; ${variants.variants.length} combination(s)`);
      if (!DRY) {
        await api.post(path.product_variations, variations);
        await api.post(path.product_variants, variants);
        rec.variations_body = variations;
        rec.variants = chosen.map((v) => ({ vid: v.vid, sku: v.sku, values: active.map((oi) => v.source_values[oi]), pays: byVid.get(v.vid)?.pays ?? null }));
      }
    }

    // publish
    if (PUBLISH) {
      say('    publish: status → publish, variations re-sent for the shop filter');
      if (!DRY) {
        await api.patch(`${path.products}/${productId}`, { status: 'publish' });
        if (rec.variations_body) await api.post(path.product_variations, rec.variations_body);
        rec.status = 'publish';
      }
    }
    rec.updated_at = new Date().toISOString();
    if (!DRY) { record.products[p.key] = rec; saveRecord(); }
  }
  say(DRY ? '\nDRY RUN: all checks pass; a real run would make exactly the writes above.' : `\nDone. record.json: ${recordPath}`);
  if (!DRY) {
    const inUse = mediaInUse(record);
    const unused = [...usedBefore].filter((id) => !inUse.has(id));
    if (unused.length) say(`${unused.length} photo(s) these products used before are no longer in them (media ids ${unused.join(', ')}). The import deletes nothing: remove them in the store's media library if nothing else uses them.`);
  }
  if (!DRY && !PUBLISH) say('The products are DRAFTS. Look at each one in the store, then run again with --publish.');
  return 0;
}

const priceLine = (pr) => pr.sale_price != null ? `${pr.sale_price} (was ${pr.regular_price})` : `${pr.regular_price}`;

/** Every store media id record.json says a product of this import uses. */
const mediaInUse = (record) => new Set(Object.values(record.products || {}).flatMap((r) => (r.images || []).map((i) => i.media_id)).filter((id) => id != null));

/** What the photos step did to a product's kept photos, in one line. */
function photoLine(kept) {
  const f = kept.map((i) => i.final);
  const t = f[0] ? `${f[0].to.width}×${f[0].to.height}` : '?';
  const n = (test) => f.filter(test).length;
  const parts = [
    [n((x) => x.changes.some((c) => c.startsWith('converted'))), 'converted to jpeg'],
    [n((x) => x.changes.some((c) => c.startsWith('enlarged'))), 'enlarged'],
    [n((x) => x.changes.some((c) => c.startsWith('reduced'))), 'reduced'],
    [n((x) => x.edge === 'plain'), 'padded on a plain edge'],
    [n((x) => x.edge === 'scene'), 'padded on a scene — look at them'],
  ].filter(([k]) => k).map(([k, what]) => `${k} ${what}`);
  return `${f.length} → jpeg ${t}${parts.length ? ` (${parts.join(', ')})` : ', none changed'}`;
}

/** The checks only the store can answer. Reads only; a failed read throws (it is never taken as "absent"). */
async function storeGates(api, plan, record, path, catExists, errors, warnings) {
  const me = await api.get('me');
  const res = me.resources || {};
  await listingRatioCheck(api, plan, res, warnings);
  for (const slug of NEEDED) {
    const r = res[slug];
    const scopes = r?.scopes || [];
    const missing = ['read', 'write'].filter((s) => !scopes.includes(s));
    if (!r || missing.length) errors.push({ key: null, gate: 'door', message: `this key cannot ${missing.length ? missing.join(' + ') : 'use'} "${slug}" — the store owner ticks it on the key (wp-admin → the plugin's API page)` });
    path[slug] = String(r?.path || slug.replace(/^product_/, 'product/'));
  }
  if (errors.some((e) => e.gate === 'door')) return; // without the scopes, the reads below are refused too
  errors.push(...(await openapiCheck(api, path)));

  const catSlugs = new Set();
  for (const p of plan.products || []) {
    for (const s of p.category?.slugs || []) catSlugs.add(s);
    for (const c of p.category?.create || []) if (c.parent_slug) catSlugs.add(c.parent_slug);
  }
  const creating = new Set((plan.products || []).flatMap((p) => (p.category?.create || []).map((c) => c.slug)));
  for (const s of new Set([...catSlugs, ...creating])) {
    const found = await api.get(path.categories, { slug: s });
    catExists[s] = Array.isArray(found) && found.length > 0;
  }
  for (const s of catSlugs) if (!catExists[s] && !creating.has(s)) errors.push({ key: null, gate: 'door', message: `category "${s}" does not exist in the store — use an existing slug, or add it to category.create` });

  for (const p of plan.products || []) {
    if (record.products[p.key]?.product_id || !p.copy?.title) continue;
    const slug = p.copy.slug || slugify(p.copy.title);
    const taken = await api.get(path.products, { slug });
    if (Array.isArray(taken) && taken.length) errors.push({ key: p.key, gate: 'door', message: `slug "${slug}" already belongs to product ${taken[0].id} ("${taken[0].title}") — choose another copy.slug` });
  }

  // The store's variation library: a reused type keeps its display type and its "required" (libraryIssues).
  const store = {};
  for (const p of plan.products || []) {
    for (const o of (p.options || []).filter((x) => !x.drop)) {
      const slug = o.global_variation?.slug;
      if (!slug || slug in store) continue;
      const found = await api.get(path.global_variations, { slug });
      store[slug] = Array.isArray(found) && found[0] ? found[0] : null;
    }
  }
  const lib = libraryIssues(plan, store);
  errors.push(...lib.errors);
  warnings.push(...lib.warnings);
}

/**
 * The store's listing cards crop every photo to their own image box. When that box's ratio is not the photos'
 * ratio, a warning names the design — the import changes no design. A key that cannot read designs skips this.
 */
async function listingRatioCheck(api, plan, res, warnings) {
  const t = targetOf(plan.photos);
  if (t.error) return; // the plan's own gate names it
  const door = res.section_manager_global_settings;
  if (!door || !(door.scopes || []).includes('read')) { warnings.push('this key cannot read the store\'s designs, so the listing\'s image ratio was not compared with photos.ratio'); return; }
  const base = String(door.path || 'section_manager/global_settings');
  const want = t.width / t.height;
  let designs;
  try { designs = await api.get(base, { type: 'plist1' }); } catch (e) { warnings.push(`the store's listing designs could not be read (${e.message}) — photos.ratio not compared`); return; }
  for (const d of (Array.isArray(designs) ? designs : []).filter((x) => x.is_active !== 'no')) {
    let one;
    try { one = await api.get(`${base}/plist1/${d.id}`); } catch { continue; }
    const box = boxRatio(one?.settings?.product_image_container_style);
    if (!box) continue; // a fixed-height box (aspect-ratio:custom) has no ratio to match
    if (Math.abs(box.ratio - want) / want > 0.02) {
      warnings.push(`listing design ${d.id} ("${d.title}") shows product photos in a ${box.label} box, the photos are made at ${plan.photos.ratio} — the listing will crop them. Make one match the other (the photos: photos.ratio, then import-photos.mjs again; or the listing's image box ratio)`);
    }
  }
}

// Every field this script can send, per door. Checked against the store's own /openapi, so a plugin that
// renamed or dropped one stops the run with its name instead of answering 400 halfway through a product.
const SENDS = [
  ['post', 'products', ['title', 'slug', 'status', 'category_slugs', 'regular_price', 'sale_price', 'sku', 'featured_image_id', 'gallery_image_ids', 'short_description', 'long_description', 'extra_description']],
  ['post', 'media', ['filename', 'data_base64', 'alt', 'title']],
  ['post', 'categories', ['name', 'slug', 'parent_slug']],
  ['post', 'global_variations', ['slug', 'title_in_product', 'type', 'is_required', 'error_msg']],
  ['post', 'product_variations', ['product_id', 'variations']],
  ['post', 'product_variants', ['product_id', 'variants']],
];

async function openapiCheck(api, path) {
  let spec;
  try { spec = await api.get('openapi'); } catch (e) {
    console.log(`  ! could not read /openapi (${e.message}) — fields not checked against the store`);
    return [];
  }
  const errs = [];
  for (const [method, slug, fields] of SENDS) {
    const op = spec?.paths?.[`/${path[slug]}`]?.[method];
    const props = op?.requestBody?.content?.['application/json']?.schema?.properties;
    if (!props) continue; // this door does not describe its body — nothing to compare against
    const gone = fields.filter((f) => !(f in props));
    if (gone.length) errs.push({ key: null, gate: 'door', message: `${method.toUpperCase()} /${path[slug]} no longer accepts ${gone.join(', ')} — this copy of the skill does not match this store's plugin version` });
  }
  return errs;
}

main().then((code) => { process.exitCode = code; }, (e) => { console.error(`\n✗ ${e.message}\n  record.json keeps everything written so far; fix the cause and run again — it resumes.`); process.exitCode = 1; });

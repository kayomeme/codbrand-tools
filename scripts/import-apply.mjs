#!/usr/bin/env node
/**
 * import-apply.mjs — step 4 of a product import: write the reviewed plan into the store, as DRAFTS.
 *
 *   node import-apply.mjs <site-url> --key-file <key file> [--plan product-import/plan.json] [--only <key,…>]
 *                         [--dry-run] [--publish]
 *
 *   --key-file  a file holding the store's API key (one line CL_API_KEY=…); or set CL_API_KEY. The key is
 *               REFUSED on the command line: it would stay in the shell's history and the conversation.
 *   --only      only these products (their plan keys, comma-separated) — for any run, --publish included.
 *   --dry-run   every check, every read, and the list of writes it WOULD make. Writes nothing.
 *   --publish   STATUS ONLY: publishes products this import already wrote, and sends each one's own current
 *               variations back (the shop's filter counts options on published products only, and publishing
 *               alone does not refresh it). It writes nothing else — a fix made in wp-admin during the draft
 *               review stays.
 *
 * It REFUSES, before the first write, while any of these holds (all are listed at once):
 *   rights    a product from a retailer's own store (not a supplier platform) lacks rights_confirmed: true
 *   price     a product or variant has no retail price, or a price is the source's own price, or at/below cost × fx
 *   copy      the title or description is missing or is the source's text as-is; no language set
 *   images    an image is unreviewed, kept without alt text, over the size ceiling, or excluded without a reason;
 *             the same file is kept twice
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
import { clapi, storeAccess } from './lib/clapi.mjs';
import { checkPlan, pricesFor, productBody, variationsBody, storeVariants, activeIdx, slugify, targetOf, libraryIssues, boxRatio, photoLinks, asReplaceRow } from './lib/plan.mjs';
import { MAX_BYTES } from './lib/images.mjs';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n) => { const i = argv.indexOf(n); return i !== -1 ? argv[i + 1] : null; };
const WITH_VALUE = ['--plan', '--key-file', '--only'];
const positional = argv.filter((a, i) => !a.startsWith('--') && !WITH_VALUE.includes(argv[i - 1]));
const PLAN = resolve(opt('--plan') || join('product-import', 'plan.json'));
const DIR = dirname(PLAN);
const DRY = flag('--dry-run');
const PUBLISH = flag('--publish');
const ONLY = opt('--only') ? new Set(opt('--only').split(',').map((s) => s.trim()).filter(Boolean)) : null;
const USAGE = 'usage: node import-apply.mjs <site-url> --key-file <key file> [--plan product-import/plan.json] [--only <key,…>] [--dry-run] [--publish]';

const NEEDED = ['products', 'media', 'categories', 'global_variations', 'product_variations', 'product_variants'];
const sha = (b) => createHash('sha256').update(b).digest('hex');
const short = (s) => createHash('sha1').update(s).digest('hex').slice(0, 12);
const say = (s = '') => console.log(s);

async function main() {
  const access = storeAccess({ positional, keyFile: opt('--key-file'), readFile: (f) => readFileSync(f, 'utf8') });
  if (access.error) { console.error(`✗ ${access.error}\n${USAGE}`); return 1; }
  if (!existsSync(PLAN)) { console.error(`✗ no plan at ${PLAN} — run import-fetch.mjs first`); return 1; }
  const fullPlan = JSON.parse(readFileSync(PLAN, 'utf8'));
  if (ONLY) {
    const unknown = [...ONLY].filter((k) => !(fullPlan.products || []).some((p) => p.key === k));
    if (unknown.length) { console.error(`✗ --only: no product ${unknown.join(', ')} in the plan — its keys are: ${(fullPlan.products || []).map((p) => p.key).join(', ')}`); return 1; }
  }
  // the products this run acts on; the plan file itself is never rewritten here
  const plan = { ...fullPlan, products: (fullPlan.products || []).filter((p) => !ONLY || ONLY.has(p.key)) };
  const sources = {};
  for (const p of plan.products) {
    const f = join(DIR, p.source_file || `source/${p.key}.json`);
    if (existsSync(f)) sources[p.key] = JSON.parse(readFileSync(f, 'utf8'));
  }
  const recordPath = join(DIR, 'record.json');
  const record = existsSync(recordPath) ? JSON.parse(readFileSync(recordPath, 'utf8'))
    : { kind: 'import-record/1', site: null, products: {}, media: {} };
  const saveRecord = () => { if (!DRY) writeFileSync(recordPath, JSON.stringify(record, null, 2) + '\n'); };
  const api = clapi(access.site, access.key);
  const site = api.base.replace(/\/wp-json.*$/, '');
  record.site = record.site || site;
  if (record.site !== site) { console.error(`✗ record.json belongs to ${record.site}, not this store — use a separate import folder per store`); return 1; }
  if (PUBLISH) return publishOnly(api, plan, record, saveRecord, site);

  // ── 1. the plan's own gates — no network ──
  const fileBytes = (f) => { try { return statSync(join(DIR, f)).size; } catch { return null; } };
  const errors = checkPlan(plan, sources, { fileBytes, maxBytes: MAX_BYTES, uploaded: (h) => Boolean(record.media?.[h]) });

  // ── 2. the store's gates — reads only ──
  const path = {};
  const catExists = {};
  const warnings = [];
  const activePlan = { ...plan, products: plan.products.filter((p) => !p.skip) };
  try {
    await storeGates(api, activePlan, record, path, catExists, errors, warnings);
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
  const totals = { created: 0, updated: 0, skipped: 0, photosUploaded: 0, photosReused: 0, kept: 0, candidates: 0, categories: 0, types: 0, options: 0, combinations: 0, readBackFailed: 0 };

  // ── 3. the writes ──
  say(`import-apply ${DRY ? '(DRY RUN — nothing is written)' : ''} → ${record.site}\n`);
  const gvCache = {};
  for (const p of plan.products) {
    if (p.skip) {
      totals.skipped++;
      const was = record.products[p.key]?.product_id;
      say(`• [${p.key}] skipped — ${p.skip_reason}${was ? ` (product ${was}, imported before, stays in the store as it is: set it to draft or delete it in wp-admin if it must go)` : ''}`);
      continue;
    }
    const src = sources[p.key];
    const rec = record.products[p.key] || { source: { platform: src.platform, product_id: src.pid, product_sku: src.product_sku, url: src.url, route: src.route }, images: [] };
    const prices = pricesFor(p, src, plan.pricing || {});
    say(`• ${p.copy.title}  [${p.key}]`);

    // images — what is uploaded is the file import-photos.mjs made (one format, ratio and size); the plan's gates
    // refused any kept photo without one. A file already in the store (record.json, by its hash) is not read
    // again, so a re-run does not need images/ for photos uploaded before.
    const kept = p.images.filter((i) => i.decision === 'keep');
    totals.kept += kept.length;
    totals.candidates += p.images.filter((i) => i.file).length;
    const mediaFor = {};   // file -> media id
    const mediaUrl = {};   // file -> media URL (a photo swatch is drawn from its URL, not its id)
    let already = 0;
    const entries = [];
    for (const [n, img] of kept.entries()) {
      const known = img.final.sha256 && record.media[img.final.sha256];
      const bytes = known ? null : readFileSync(join(DIR, img.final.file));
      const hash = known ? img.final.sha256 : sha(bytes);
      let m = record.media[hash];
      if (m) { already++; totals.photosReused++; }
      if (!m && !DRY) {
        const body = { filename: `${p.copy.slug || slugify(p.copy.title)}-${String(n + 1).padStart(2, '0')}.jpg`, data_base64: bytes.toString('base64'), alt: img.alt, title: img.alt };
        const row = await api.post(path.media, body, `import-media-${hash.slice(0, 32)}`);
        m = record.media[hash] = { id: row.id, url: row.url };
        totals.photosUploaded++;
      } else if (!m) totals.photosUploaded++;
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

    // categories — created once: a later product naming the same one reuses it. An image is one of this
    // product's kept photos (its upload is reused); a description is plain text (the store strips other tags).
    for (const c of p.category?.create || []) {
      if (catExists[c.slug]) continue;
      const img = c.image ? mediaFor[c.image] : null;
      say(`    category: create "${c.name}" (${c.slug})${c.description ? ', with a description' : ''}${img ? `, image ${basename(c.image)}` : ''}`);
      if (!DRY) {
        await api.post(path.categories, { name: c.name, slug: c.slug, ...(c.parent_slug ? { parent_slug: c.parent_slug } : {}),
          ...(c.description ? { description: String(c.description) } : {}), ...(Number.isInteger(img) ? { img_id: img } : {}) }, `import-cat-${c.slug}`);
      }
      catExists[c.slug] = true;
      totals.categories++;
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
          totals.types++;
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
          totals.options++;
          if (DRY) { found = { id: `(new ${title})`, title }; gv.options.push(found); }
          else {
            const after = await api.post(`${path.global_variations}/${gv.id}/options`, { title, ...(v.color_code ? { color_code: v.color_code } : {}) }, `import-gvo-${g.slug}-${short(title)}`);
            gv.options = after.options || gv.options;
            found = gv.options.find((x) => String(x.title).trim().toLowerCase() === title.toLowerCase());
            if (!found) throw new Error(`the store did not return option "${title}" after adding it to ${g.slug}`);
          }
        } else if (g.type === 'colorbox' && v.color_code && found.color_code && String(found.color_code).toLowerCase() !== String(v.color_code).toLowerCase()) {
          // reused from the store's library: this product shows its own colour (sent with its variations)
          say(`    option: reuse "${title}" — on this product ${v.color_code} (the store's "${title}" is ${found.color_code})`);
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
      totals.updated++;
      say(`    product: update ${rec.product_id} — ${body.slug}, ${priceLine(prices)} (its status does not change)`);
      if (!DRY) {
        try { await api.patch(`${path.products}/${rec.product_id}`, body); }
        catch (e) {
          if (e.status === 404) throw new Error(`product ${rec.product_id} (from record.json) no longer exists in the store — remove "${p.key}" from record.json to create it again`);
          throw e;
        }
      }
    } else {
      totals.created++;
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
    let chosen = [];
    if (active.length) {
      const media = Object.fromEntries(Object.keys(mediaFor).map((f) => [f, { id: mediaFor[f], url: mediaUrl[f] }]));
      const variations = variationsBody(p, productId, { gvIds, optionIds, media });
      const byVid = new Map((prices.variants || []).map((v) => [v.vid, v]));
      chosen = storeVariants(p);
      const variants = {
        product_id: productId,
        variants: chosen.map((v) => {
          const pr = byVid.get(v.vid);
          return { option_ids: active.map((oi) => optionIds[oi].get(v.source_values[oi])),
            ...(pr?.combination_price != null ? { price: pr.combination_price } : {}),
            ...(v.sku ? { sku: v.sku } : {}) };
        }),
      };
      totals.combinations += variants.variants.length;
      say(`    variations: ${active.map((oi) => `${p.options[oi].global_variation.slug} × ${p.options[oi].values.filter((x) => x.include !== false).length}`).join(', ')}; ${variants.variants.length} combination(s)`);
      for (const o of p.options.filter((x) => x.drop && x.values.length > 1)) say(`    dropped "${o.source_name}": the store sells "${o.keep_value}" only`);
      // every combination with the SKU the supplier is ordered by and the source's cost behind its price — a wrong
      // pick (the wrong set, a dearer variant) shows here before anything is written
      if (DRY) {
        const costOf = new Map(src.variants.map((v) => [v.vid, v.price]));
        for (const v of chosen) {
          const label = active.map((oi) => p.options[oi].values.find((x) => x.source_value === v.source_values[oi])?.title || v.source_values[oi]).join(' / ');
          say(`      ${label}  ·  SKU ${v.sku || '—'}  ·  source ${costOf.get(v.vid) ?? '?'} ${src.price?.currency || ''}  ·  sells at ${byVid.get(v.vid)?.pays ?? prices.sale_price ?? prices.regular_price}`);
        }
      }
      // which photo each value of the photo option switches to — the ones the tool linked are for a person to check
      for (const l of photoLinks(p)) {
        if (!l.image) say(`    ! ${l.option} "${l.title || l.value}" has no photo of its own: picking it keeps the photo on show`);
        else if (l.how === 'inferred') say(`    ${l.option} "${l.title || l.value}" → ${basename(l.image.file)} (linked by the tool — check it on the kept sheet)`);
      }
      if (!DRY) {
        await api.post(path.product_variations, variations);
        await api.post(path.product_variants, variants);
        rec.variations_body = variations;
        rec.variants = chosen.map((v) => ({ vid: v.vid, sku: v.sku, values: active.map((oi) => v.source_values[oi]), pays: byVid.get(v.vid)?.pays ?? null }));
      }
    }

    // read it back: what the store now holds, and where to look at it
    if (!DRY) {
      const back = await api.get(`${path.products}/${productId}`);
      const gallery = Array.isArray(back.gallery_image_ids) ? back.gallery_image_ids.map(String) : [];
      const sent = (body.gallery_image_ids || []).map(String);
      const combos = active.length ? await api.get(path.product_variants, { product_id: productId }) : [];
      const problems = [];
      // the store answers sale_price 0 for "no sale" (measured on dev1)
      const saleBack = Number(back.sale_price) > 0 ? Number(back.sale_price) : null;
      const saleSent = body.sale_price != null ? Number(body.sale_price) : null;
      if (Number(back.regular_price) !== Number(body.regular_price)) problems.push(`price ${back.regular_price}, sent ${body.regular_price}`);
      if (saleBack !== saleSent) problems.push(`sale price ${saleBack ?? 'none'}, sent ${saleSent ?? 'none'}`);
      if (gallery.join() !== sent.join()) problems.push(`gallery ${gallery.length} photo(s), sent ${sent.length}`);
      if (active.length && (Array.isArray(combos) ? combos.length : 0) !== chosen.length) problems.push(`${Array.isArray(combos) ? combos.length : '?'} combination(s), sent ${chosen.length}`);
      if (problems.length) totals.readBackFailed++;
      say(`    read back: ${back.status}, ${saleBack != null ? `${saleBack} (was ${back.regular_price})` : back.regular_price}, ${gallery.length} photo(s)${active.length ? `, ${chosen.length} combination(s)` : ''} ${problems.length ? `✗ ${problems.join('; ')}` : '✓'}`);
      say(`    look at it: ${back.url || `${site}/?post_type=product&p=${productId}&preview=true`}${back.url ? '' : '  (a draft: open it signed in to the store\'s admin)'}`);
      rec.status = back.status || rec.status;
    }
    rec.updated_at = new Date().toISOString();
    if (!DRY) { record.products[p.key] = rec; saveRecord(); }
  }

  say(`\n${DRY ? 'DRY RUN — would write' : 'Written'}: ${totals.created} product(s) created as drafts, ${totals.updated} updated (status unchanged), ${totals.skipped} skipped · photos: ${totals.kept} kept of ${totals.candidates} candidates, ${totals.photosUploaded} ${DRY ? 'to upload' : 'uploaded'}, ${totals.photosReused} already in the store · ${totals.categories} categor${totals.categories === 1 ? 'y' : 'ies'}, ${totals.types} variation type(s) and ${totals.options} option(s) created · ${totals.combinations} combination(s)`);
  if (DRY) { say('DRY RUN: all checks pass; a real run would make exactly the writes above.'); return 0; }
  say(`record.json: ${recordPath}`);
  if (totals.readBackFailed) say(`✗ ${totals.readBackFailed} product(s) read back different from what was sent — see "read back" above.`);
  const inUse = mediaInUse(record);
  const unused = [...usedBefore].filter((id) => !inUse.has(id));
  if (unused.length) say(`${unused.length} photo(s) these products used before are no longer in them (media ids ${unused.join(', ')}). The import deletes nothing: remove them in the store's media library if nothing else uses them.`);
  if (totals.created) say(`The ${totals.created} new product(s) are DRAFTS: look at each one (links above), then publish them with --publish${ONLY ? '' : ' (add --only <key,…> for some of them)'}.`);
  return totals.readBackFailed ? 1 : 0;
}

/**
 * --publish: STATUS ONLY. Publishes the products this import already wrote (record.json), and sends each one's own
 * CURRENT variations back as they are — the shop's filter counts options only on published products and publishing
 * alone does not refresh it. Nothing else is written, so a fix the merchant made in wp-admin during the draft review
 * stays (before, --publish re-applied the whole plan over it).
 */
async function publishOnly(api, plan, record, saveRecord, site) {
  const me = await api.get('me');
  const res = me.resources || {};
  const path = {};
  const missing = [];
  for (const slug of ['products', 'product_variations']) {
    if (!(res[slug]?.scopes || []).includes('write')) missing.push(slug);
    path[slug] = String(res[slug]?.path || slug.replace(/^product_/, 'product/'));
  }
  if (missing.length) { say(`import-apply --publish: REFUSED — this key cannot write ${missing.join(' + ')}`); return 1; }
  say(`import-apply --publish ${DRY ? '(DRY RUN — nothing is written) ' : ''}→ ${record.site} — status only: nothing else is written\n`);
  const notYet = [];
  let published = 0;
  for (const p of plan.products) {
    if (p.skip) { say(`• [${p.key}] skipped — ${p.skip_reason}`); continue; }
    const rec = record.products[p.key];
    if (!rec?.product_id) { notYet.push(p.key); continue; }
    say(`• ${p.copy?.title || p.key}  [${p.key}] → product ${rec.product_id}`);
    if (DRY) { published++; continue; }
    await api.patch(`${path.products}/${rec.product_id}`, { status: 'publish' });
    const current = await api.get(path.product_variations, { product_id: rec.product_id });
    const rows = Array.isArray(current) ? current : current?.items || [];
    if (rows.length) await api.post(path.product_variations, { product_id: rec.product_id, variations: rows.map(asReplaceRow) });
    const back = await api.get(`${path.products}/${rec.product_id}`);
    rec.status = back.status;
    rec.published_at = new Date().toISOString();
    record.products[p.key] = rec;
    saveRecord();
    published++;
    say(`    ${back.status === 'publish' ? '✓ published' : `✗ the store says "${back.status}"`}${rows.length ? ', its own variations sent back for the shop filter' : ''}: ${back.url || `${site}/?post_type=product&p=${rec.product_id}`}`);
  }
  if (notYet.length) say(`\nNot imported yet (run without --publish first): ${notYet.join(', ')}`);
  say(`\n${DRY ? 'DRY RUN — would publish' : 'Published'}: ${published} product(s).`);
  return notYet.length ? 1 : 0;
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
  ['post', 'categories', ['name', 'slug', 'parent_slug', 'description', 'img_id']],
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

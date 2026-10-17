// plan.mjs — the import plan: its skeleton, the checks that must pass before anything is written, the
// price maths, and the bodies sent to the store. Pure functions only (no network, no files), so every rule
// here is testable on its own.
//
// The plan is where each JUDGEMENT is recorded — retail price, rewritten copy, keep/exclude per image, the one
// ratio and size every photo is made at, how each source option maps onto the store's variation library, and
// (for a retailer's content) the merchant's confirmation that they may use it. `checkPlan` refuses until every one is made; that is the point of the
// file. A rule written only in prose can be skipped; this one cannot.

import { createHash } from 'node:crypto';

export const PLAN_KIND = 'import-plan/1';
export const GV_TYPES = ['buttons', 'colorbox', 'images', 'selectbox'];
export const EXCLUDE_REASONS = ['watermark', 'logo', 'person', 'foreign-text', 'duplicate', 'size-chart',
  'description-image', 'too-large', 'off-product', 'low-quality', 'other'];

/** One product's key, the same in the plan, the source file, the images folder and the record. */
export const keyOf = (src) => `${src.platform}-${String(src.pid).replace(/[^0-9A-Za-z._-]+/g, '-')}`;

// ── the skeleton ──────────────────────────────────────────────────────────────────────────────────

export function newPlan() {
  return {
    kind: PLAN_KIND,
    created_at: new Date().toISOString(),
    store: { language: null, country: null, currency: null },
    pricing: { fx: null, multiplier: null, step: null, minus: null, compare_ratio: null },
    photos: newPhotos(),
    products: [],
  };
}

// ── the photo target: ONE format, ONE ratio, ONE pixel size for every product photo ──────────────
// A listing crops every photo to its own ratio, and a store-setup check refuses a catalogue that mixes formats,
// ratios or sizes. The format is always JPEG (the one the shipped codec writes, and every browser shows).

export const MIN_LONG_EDGE = 1000;
export const LONG_EDGE_RANGE = [400, 2048];
export const newPhotos = () => ({ ratio: null, long_edge: null, min_long_edge: MIN_LONG_EDGE });

/**
 * The pixel size every photo is made at: "1:1" + 1000 → 1000×1000, "3:4" + 1600 → 1200×1600.
 * -> { key: "1:1@1000", width, height }   or   { error }
 */
export function targetOf(photos) {
  const m = String(photos?.ratio ?? '').trim().match(/^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/);
  const L = photos?.long_edge;
  if (!m || !(Number(m[1]) > 0) || !(Number(m[2]) > 0)) return { error: 'photos.ratio is not set — "W:H", e.g. "1:1" (the ratio of the store\'s listing cards, or the one the merchant chose)' };
  if (!Number.isInteger(L) || L < LONG_EDGE_RANGE[0] || L > LONG_EDGE_RANGE[1]) return { error: `photos.long_edge is not set — a whole number of pixels from ${LONG_EDGE_RANGE[0]} to ${LONG_EDGE_RANGE[1]}, the long side every photo is made at` };
  const w = Number(m[1]), h = Number(m[2]);
  const width = w >= h ? L : Math.round((L * w) / h);
  const height = w >= h ? Math.round((L * h) / w) : L;
  return { key: `${m[1]}:${m[2]}@${L}`, width, height };
}

/**
 * The option whose values the photos follow when no single option decides every variant photo (a colour AND a
 * blade count each change it): the one with the most photographed values. null when variants have no photos of
 * their own, or all share one.
 */
export function guessPhotoOption(src) {
  const withPhoto = (src.variants || []).filter((v) => v.image && Array.isArray(v.values));
  if (new Set(withPhoto.map((v) => v.image)).size < 2) return null;
  let best = null, most = 1;
  (src.options || []).forEach((o, i) => {
    const n = new Set(withPhoto.map((v) => v.values[i])).size;
    if (n > most) { most = n; best = o.name; }
  });
  return best;
}

/**
 * The plan entry for one fetched product. `images` are the files import-fetch saved, in source order:
 * [{ file, url, roles, values, combos?, shrink: {engine, from, to} | null, duplicate_of?, error? }]
 */
export function productEntry(src, images) {
  const main = images.find((i) => i.roles.includes('main') && !i.error && !i.duplicate_of) || images.find((i) => !i.error);
  const key = keyOf(src);
  const description = (i) => i.roles.every((r) => r === 'description');
  return {
    key,
    platform: src.platform,
    pid: src.pid,
    source_file: `source/${key}.json`,
    // A retailer's own photos and text are not provided for reselling: the merchant must say they may use them.
    ...(src.supplier ? {} : { rights_confirmed: null }),
    // The description's caveats (facts.notes) must reach the copy: refused until notes_checked is true.
    ...(src.facts?.notes?.length ? { notes_checked: null } : {}),
    copy: { language: null, title: null, slug: null, short_description: null, long_description: null, specs_html: null },
    price: { price: null, compare_at: null },
    variant_prices: {},
    category: { slugs: [], create: [] },
    featured: main ? main.file : null,
    // The option whose values the photos follow — picking one of its values switches to that value's photo.
    photo_option: src.image_option || guessPhotoOption(src),
    images: images.map((i) => ({
      file: i.file,
      source_url: i.url,
      ...(i.original_url ? { original_url: i.original_url } : {}),
      roles: i.roles,
      values: i.values,
      ...(i.combos ? { combos: i.combos } : {}),
      decision: i.error || i.duplicate_of || description(i) ? 'exclude' : 'unreviewed',
      reason: i.error ? 'too-large' : i.duplicate_of ? 'duplicate' : description(i) ? 'description-image' : null,
      ...(i.duplicate_of ? { duplicate_of: i.duplicate_of } : {}),
      alt: null,
      shrink: i.shrink || null,
      ...(i.error ? { error: i.error } : {}),
    })),
    options: src.options.map((o) => ({
      source_name: o.name,
      // An option with one value ("One size", "custom") is not a choice for a shopper: dropped by default.
      drop: o.values.length < 2,
      // error_msg: what a shopper reads when they order without choosing — needed when the import creates the type.
      global_variation: { slug: null, title_in_product: null, type: o.name === src.image_option ? 'images' : 'buttons', error_msg: null },
      values: o.values.map((v) => ({ source_value: v, include: true, title: null, color_code: null })),
    })),
    variants: src.variants.map((v) => ({
      vid: v.vid,
      sku: v.sku,
      source_values: v.values,
      ...(v.ambiguous ? { candidates: v.candidates } : {}),
    })),
  };
}

/** Re-fetching keeps every decision already made; only products new to the plan get a fresh entry. */
export function mergePlan(plan, entries) {
  const out = plan && plan.kind === PLAN_KIND ? plan : newPlan();
  out.photos = { ...newPhotos(), ...(out.photos || {}) }; // a plan written before the photo target existed
  for (const e of entries) {
    const i = out.products.findIndex((p) => p.key === e.key);
    if (i === -1) { out.products.push(e); continue; }
    const old = out.products[i];
    e.images = e.images.map((img) => {
      const prev = old.images.find((x) => x.source_url === img.source_url);
      // the photos step's result stays with the file it was made from (import-photos checks it is still current);
      // a photo's `values` set in the plan stay too — a re-fetch used to reset them to the source's, which
      // unlinked a clean shot from the colour it stood in for (measured 30-09-2026)
      return prev ? { ...img, decision: prev.decision, reason: prev.reason, alt: prev.alt, values: prev.values ?? img.values,
        ...(prev.final && prev.file === img.file ? { final: prev.final } : {}) } : img;
    });
    const kept = (k) => (k in old ? { [k]: old[k] } : {});
    out.products[i] = { ...e, copy: old.copy, price: old.price, variant_prices: old.variant_prices,
      category: old.category, featured: old.featured ?? e.featured,
      ...kept('rights_confirmed'), ...kept('notes_checked'), ...kept('skip'), ...kept('skip_reason'), ...kept('kept_sheet'),
      photo_option: old.photo_option ?? e.photo_option,
      options: e.options.map((o) => old.options.find((x) => x.source_name === o.source_name) ?? o),
      variants: e.variants.map((v) => old.variants.find((x) => x.vid === v.vid) ?? v) };
  }
  return out;
}

// ── text helpers ──────────────────────────────────────────────────────────────────────────────────

const stripTags = (h) => String(h ?? '').replace(/<[^>]+>/g, ' ');
const words = (s) => stripTags(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .split(/[^\p{L}\p{N}]+/u).filter(Boolean);
export const normText = (s) => words(s).join(' ');

/** Share of the NEW text's 3-word runs that also occur in the source's text (0 = nothing copied, 1 = all). */
export function copiedShare(newText, srcText) {
  const shingles = (w) => { const s = new Set(); for (let i = 0; i + 2 < w.length; i++) s.add(`${w[i]} ${w[i + 1]} ${w[i + 2]}`); return s; };
  const a = shingles(words(newText));
  if (a.size === 0) return 0;
  const b = shingles(words(srcText));
  let hit = 0;
  for (const x of a) if (b.has(x)) hit++;
  return hit / a.size;
}
export const COPY_LIMIT = 0.5;

export function slugify(s) {
  return String(s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80).replace(/-+$/, '');
}

// ── options and variants ──────────────────────────────────────────────────────────────────────────

/** Indexes of the options that stay (not dropped). */
export const activeIdx = (p) => p.options.map((o, i) => (o.drop ? -1 : i)).filter((i) => i >= 0);

/** Is every value of this variant still offered (dropped options do not count)? */
export const included = (p, v) => activeIdx(p).every((i) =>
  p.options[i].values.find((x) => x.source_value === v.source_values?.[i])?.include !== false);

/**
 * The variants the store gets: resolved, included, one per combination of the options that stay.
 *
 * A dropped option with several values ("Blades": 4 or 6; "Set": 3 pieces or 5) must name the ONE value the store
 * sells, `keep_value`: only that value's variants are kept, so each combination carries the right SKU and cost.
 * Without it the first variant used to be kept silently — measured on a real import: a knife holder sold its
 * 3-piece set, cost 162, for 149. `checkPlan` refuses a drop without it; here a missing one still falls back to
 * the first variant so that a dry run can show what would happen.
 */
export function storeVariants(p) {
  const pinned = p.options.map((o, i) => (o.drop && o.values.length > 1 && o.keep_value != null ? [i, o.keep_value] : null)).filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const v of p.variants) {
    if (!Array.isArray(v.source_values) || !included(p, v)) continue;
    if (pinned.some(([i, keep]) => v.source_values[i] !== keep)) continue;
    const k = activeIdx(p).map((i) => v.source_values[i]).join('\u0000');
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out;
}

// ── prices ────────────────────────────────────────────────────────────────────────────────────────

const round = (x, step, minus) => {
  if (!(step > 0)) return Math.round(x * 100) / 100;
  const r = Math.ceil(x / step - 1e-9) * step - (Number(minus) || 0);
  return Math.round(r * 100) / 100;
};
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

/** The plan's exchange rate for a source currency: one number for every source, or { "USD": 10.1, … }. */
export const fxFor = (fx, currency) => (isNum(fx) ? fx : fx && typeof fx === 'object' && isNum(fx[currency]) ? fx[currency] : null);

/**
 * What the shopper pays per variant, and what the store is sent.
 *
 * The store has no compare-at field: `regular_price` is the crossed-out price and `sale_price` the one
 * paid. A combination's price stands in for the REGULAR price and the product's saving still comes off
 * it, so with a compare-at price every combination is sent `base + saving` and the shopper pays `base`.
 */
export function pricesFor(p, src, pricing = {}) {
  const errors = [];
  const vs = p.options.length ? storeVariants(p) : p.variants;
  const byVid = new Map(src.variants.map((v) => [v.vid, v]));
  const fx = fxFor(pricing.fx, src.price?.currency);
  const isCost = src.price?.kind === 'cost';
  const bases = vs.map((v) => {
    const srcPrice = byVid.get(v.vid)?.price ?? src.price?.min ?? null;
    let base = p.variant_prices?.[v.vid]?.price ?? p.price?.price ?? null;
    let from = base != null ? 'plan' : null;
    if (base == null && isCost && fx != null && isNum(pricing.multiplier) && srcPrice != null) {
      base = round(srcPrice * fx * pricing.multiplier, pricing.step, pricing.minus);
      from = 'rule';
    }
    return { vid: v.vid, sku: v.sku, srcPrice, base: base == null ? null : Number(base), from };
  });
  if (!bases.length) {
    const base = p.price?.price ?? null;
    bases.push({ vid: null, sku: null, srcPrice: src.price?.min ?? null, base: base == null ? null : Number(base), from: base != null ? 'plan' : null });
  }
  const unpriced = bases.filter((b) => b.base == null || !isNum(b.base));
  if (unpriced.length && unpriced.length === bases.length) {
    errors.push(`no retail price set${bases.length > 1 ? ` for any of its ${bases.length} variants` : ''} — set price.price, variant_prices, or the plan's pricing rule${isCost ? '' : ' (a rule applies to supplier costs only)'}`);
  }
  for (const b of bases) {
    const where = b.vid ? `variant ${b.sku || b.vid}` : 'the product';
    if (b.base == null || !isNum(b.base)) { if (unpriced.length < bases.length) errors.push(`no retail price for ${where} — set it in variant_prices, or set price.price`); continue; }
    if (b.base <= 0) errors.push(`${where}: price ${b.base} must be above 0`);
    if (b.srcPrice != null && Math.abs(b.base - b.srcPrice) < 0.005) {
      errors.push(`${where}: ${b.base} is the source's own ${isCost ? 'cost' : 'selling'} price, not this store's retail price`);
    }
    if (isCost && b.srcPrice != null && fx != null && b.base <= b.srcPrice * fx) {
      errors.push(`${where}: ${b.base} is at or below cost (${b.srcPrice} ${src.price.currency || ''} × fx ${fx} = ${Math.round(b.srcPrice * fx * 100) / 100})`);
    }
  }
  if (errors.length) return { errors };

  const low = Math.min(...bases.map((b) => b.base));
  let compare = p.price?.compare_at ?? null;
  // The rule's crossed-out price belongs to prices the RULE made. A price set by hand with no compare_at has
  // no crossed-out price (measured: a hand-set 790 came out "was 1109" before this).
  if (compare == null && isNum(pricing.compare_ratio) && bases.every((b) => b.from === 'rule')) {
    compare = round(low * pricing.compare_ratio, pricing.step, pricing.minus);
  }
  if (compare != null && !(Number(compare) > low)) errors.push(`compare_at ${compare} must be above the lowest price ${low}`);
  if (errors.length) return { errors };

  const regular = compare != null ? Number(compare) : low;
  const sale = compare != null ? low : null;
  const saving = compare != null ? regular - low : 0;
  const uniform = bases.every((b) => b.base === low);
  return {
    errors: [],
    regular_price: regular,
    sale_price: sale,
    variants: bases.filter((b) => b.vid).map((b) => ({
      vid: b.vid, pays: b.base, from: b.from,
      combination_price: uniform ? null : Math.round((b.base + saving) * 100) / 100,
    })),
  };
}

// ── the gates ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Every refusal, before any write. `ctx.fileBytes(file)` returns the size of a saved image or null;
 * `ctx.uploaded(sha256)` says whether record.json already has that file in the store (then it need not be on disk).
 * -> [{ key, gate, message }]   (empty = safe to apply)
 */
export function checkPlan(plan, sources, ctx = {}) {
  const errs = [];
  const err = (key, gate, message) => errs.push({ key, gate, message });
  if (plan?.kind !== PLAN_KIND) return [{ key: null, gate: 'plan', message: 'this is not an import plan (kind)' }];
  const maxBytes = ctx.maxBytes ?? 450 * 1024;
  const target = targetOf(plan.photos);
  if (target.error) err(null, 'photos', `${target.error}; then run import-photos.mjs`);

  for (const p of plan.products) {
    // SKIP — a fetched product the merchant does not want: nothing is checked or written for it
    if (p.skip) {
      if (!String(p.skip_reason ?? '').trim()) err(p.key, 'plan', 'skip: true needs a skip_reason — why this product is left out');
      continue;
    }
    const src = sources[p.key];
    if (!src) { err(p.key, 'plan', `no fetched source for ${p.key} (${p.source_file})`); continue; }

    // RIGHTS — a retailer's own photos and text
    if (!src.supplier && p.rights_confirmed !== true) {
      err(p.key, 'rights', `photos and text come from ${hostOf(src.url) || src.platform}, a retailer's own store, not a supplier — set rights_confirmed: true only after the merchant confirms they may use them`);
    }

    // PRICE
    for (const m of pricesFor(p, src, plan.pricing || {}).errors) err(p.key, 'price', m);

    // COPY
    const c = p.copy || {};
    if (!(c.language || plan.store?.language)) err(p.key, 'copy', 'copy.language (or store.language) is not set — the language the copy is written in');
    if (!c.title || !String(c.title).trim()) err(p.key, 'copy', 'copy.title is empty — write the product title for this store');
    else if (normText(c.title) === normText(src.facts.title)) err(p.key, 'copy', 'copy.title is the source\'s title as-is — rewrite it');
    if (!c.long_description || !stripTags(c.long_description).trim()) err(p.key, 'copy', 'copy.long_description is empty — write the description from the facts');
    for (const f of ['long_description', 'short_description']) {
      const share = c[f] ? copiedShare(c[f], src.facts.description_text) : 0;
      if (share >= COPY_LIMIT) err(p.key, 'copy', `copy.${f} repeats the source's description (${Math.round(share * 100)}% of its 3-word runs) — rewrite it`);
    }
    const slug = c.slug || slugify(c.title);
    if (c.title && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) err(p.key, 'copy', `copy.slug "${slug}" — set a slug of a-z, 0-9 and "-" (a title in another script needs one written)`);
    // The description's caveats: a copy without "cup not included" promises a cup, and the parcel is refused.
    if (src.facts?.notes?.length && p.notes_checked !== true) {
      err(p.key, 'copy', `the source says: ${src.facts.notes.map((n) => `"${n}"`).join(' · ')} — the copy must tell the shopper what is (and is not) in the parcel and any sizing warning, and promise nothing these contradict; then set notes_checked: true`);
    }

    // IMAGES
    const unreviewed = p.images.filter((i) => !['keep', 'exclude'].includes(i.decision));
    if (unreviewed.length) err(p.key, 'images', `${unreviewed.length} image(s) not reviewed: ${unreviewed.map((i) => i.file || i.source_url).join(', ')} — set decision "keep" or "exclude" on each`);
    for (const i of p.images) {
      if (i.decision === 'exclude' && !i.reason) err(p.key, 'images', `${i.file || i.source_url}: excluded without a reason`);
      if (i.decision !== 'keep') continue;
      if (i.error) err(p.key, 'images', `${i.file || i.source_url}: cannot be kept — ${i.error}`);
      if (!i.alt || !String(i.alt).trim()) err(p.key, 'images', `${i.file}: kept without alt text — describe it in the store's language`);
      const bytes = ctx.fileBytes ? ctx.fileBytes(i.file) : null;
      // a photo already made and in the store needs neither file on disk (a re-run after images/ was cleared)
      const inStore = i.final?.sha256 && ctx.uploaded?.(i.final.sha256);
      if (ctx.fileBytes && bytes == null && !inStore) err(p.key, 'images', `${i.file}: file missing`);
      if (bytes != null && bytes > maxBytes) err(p.key, 'images', `${i.file}: ${Math.round(bytes / 1024)} KB is over the ${Math.round(maxBytes / 1024)} KB ceiling`);
    }
    const kept = p.images.filter((i) => i.decision === 'keep');
    if (!kept.length) err(p.key, 'images', 'no image kept — a product needs at least one');
    // the same file kept twice is the same photo twice in the gallery (copies kept before a re-fetch found them)
    for (const files of keptCopies(p.images)) {
      const others = files.length > 2 ? 'the others' : 'the other';
      err(p.key, 'images', `${files.join(' = ')} are the same file, and each is kept — the gallery would show it ${files.length === 2 ? 'twice' : `${files.length} times`}: keep one and exclude ${others} with reason "duplicate"; a colour an excluded copy stands for (its "values") goes on the one kept — then check the dry run's colour lines`);
    }
    if (p.featured && kept.length && !kept.some((i) => i.file === p.featured)) err(p.key, 'images', `featured image ${p.featured} is not kept — point "featured" at a kept image`);

    // PHOTOS — what is uploaded is the photos step's file, made at the plan's one ratio and size
    if (!target.error) {
      const notMade = kept.filter((i) => !i.error && (i.final?.target !== target.key || !i.final?.file));
      if (notMade.length) err(p.key, 'photos', `${notMade.length} kept photo(s) not made at ${target.key} yet (${notMade.map((i) => i.file).join(', ')}) — run import-photos.mjs`);
      for (const i of kept.filter((x) => x.final?.target === target.key && x.final?.file)) {
        const bytes = ctx.fileBytes ? ctx.fileBytes(i.final.file) : null;
        const uploaded = i.final.sha256 && ctx.uploaded?.(i.final.sha256);
        if (ctx.fileBytes && bytes == null && !uploaded) err(p.key, 'photos', `${i.final.file}: file missing — run import-photos.mjs`);
        if (bytes != null && bytes > maxBytes) err(p.key, 'photos', `${i.final.file}: ${Math.round(bytes / 1024)} KB is over the ${Math.round(maxBytes / 1024)} KB ceiling`);
      }
      // The kept sheet: the photos exactly as they will be uploaded, drawn as one image an agent can open. It
      // must have been drawn from THIS kept set — a photo kept, excluded or re-made since makes it stale.
      if (!notMade.length && kept.length && p.kept_sheet?.fingerprint !== keptFingerprint(p, target.key)) {
        err(p.key, 'photos', `the kept sheet is missing or older than the kept photos — run import-photos.mjs, then OPEN sheets/${p.key}-kept-1.jpg (and any -kept-2 …) and look at every photo before applying`);
      }
    }

    // VARIANTS — a dropped option with several values names the one the store sells (see storeVariants)
    for (const o of p.options) {
      if (!o.drop || o.values.length < 2 || o.values.some((x) => x.source_value === o.keep_value)) continue;
      err(p.key, 'variants', `option "${o.source_name}" is dropped but has ${o.values.length} values (${o.values.map((x) => `"${x.source_value}"`).join(', ')}) — set keep_value to the ONE the store sells; each combination then takes that variant's SKU and cost, not the first variant's`);
    }
    for (const oi of activeIdx(p)) {
      const o = p.options[oi];
      const g = o.global_variation || {};
      if (!g.slug || !/^[a-z0-9_-]+$/.test(g.slug)) err(p.key, 'variants', `option "${o.source_name}": global_variation.slug is not set (reuse one from GET /global_variations, or name a new one) — or set drop: true`);
      if (!g.title_in_product) err(p.key, 'variants', `option "${o.source_name}": global_variation.title_in_product is not set (the label shoppers see, in the store's language)`);
      if (!GV_TYPES.includes(g.type)) err(p.key, 'variants', `option "${o.source_name}": type must be one of ${GV_TYPES.join(', ')}`);
      const titles = new Map();
      for (const v of o.values.filter((x) => x.include !== false)) {
        if (!v.title || !String(v.title).trim()) { err(p.key, 'variants', `option "${o.source_name}" value "${v.source_value}": title is not set`); continue; }
        const k = String(v.title).trim().toLowerCase();
        if (titles.has(k)) err(p.key, 'variants', `option "${o.source_name}": "${titles.get(k)}" and "${v.source_value}" both become "${v.title}" — two variants would collide; exclude one or name them apart`);
        titles.set(k, v.source_value);
        if (g.type === 'colorbox' && !/^#[0-9a-f]{6}$/i.test(v.color_code || '')) err(p.key, 'variants', `option "${o.source_name}" value "${v.source_value}": colorbox needs color_code "#rrggbb"`);
        if (g.type === 'images' && !swatchImage(p, oi, v.source_value)) err(p.key, 'variants', `option "${o.source_name}" value "${v.source_value}": image swatches need a KEPT photo of this value`);
      }
    }
    for (const v of p.variants) {
      if (!Array.isArray(v.source_values) || v.source_values.length !== p.options.length) {
        err(p.key, 'variants', `variant ${v.sku || v.vid}: source_values not resolved${v.candidates ? ` — pick one of ${JSON.stringify(v.candidates)}` : ''}`);
        continue;
      }
      v.source_values.forEach((val, i) => {
        if (!p.options[i].values.some((x) => x.source_value === val)) err(p.key, 'variants', `variant ${v.sku || v.vid}: "${val}" is not a value of option "${p.options[i].source_name}"`);
      });
    }
    const sold = storeVariants(p);
    if (activeIdx(p).length && !sold.length) err(p.key, 'variants', 'every variant is excluded');
    else if (sold.length) {
      // a value the store would offer with nothing to sell behind it (e.g. a colour made only with the blade
      // count that keep_value left out)
      for (const oi of activeIdx(p)) {
        for (const v of p.options[oi].values.filter((x) => x.include !== false)) {
          if (!sold.some((s) => s.source_values[oi] === v.source_value)) err(p.key, 'variants', `option "${p.options[oi].source_name}" value "${v.source_value}" has no variant left to sell — exclude it (include: false), or keep another value of the dropped option`);
        }
      }
    }

    // CATEGORY (existence is checked against the store at apply time)
    for (const cc of p.category?.create || []) {
      if (!cc.name || !cc.slug) err(p.key, 'category', 'each category.create entry needs a name and a slug');
      if (cc.image && !kept.some((i) => i.file === cc.image)) err(p.key, 'category', `category "${cc.slug}": image ${cc.image} is not one of this product's kept photos — name a kept photo's file, or leave image out`);
    }
  }
  return errs;
}

const hostOf = (u) => { try { return new URL(u).host; } catch { return ''; } };

/**
 * What the store's variation library means for the plan's types. `store` maps each planned slug to the store's
 * type — { type, is_required, error_msg } — or null when the store has none (the import will create it).
 * -> { errors: [{ key, gate, message }], warnings: [string] }
 *
 * A reused type keeps ITS display type: planning "images" on the store's colorbox "color" would upload swatch
 * photos the store never shows. And ITS "required": the store takes "required" from the library type only — the
 * per-product override the api lists is dropped on write and never read by the product page (plugin read
 * 30-09-2026). An optional type lets a shopper order without choosing, and the order then does not say which
 * colour or size. The import never changes a type it did not create, so it asks.
 */
export function libraryIssues(plan, store) {
  const errors = [], warnings = [];
  const usedBy = new Map(), first = new Map();
  for (const p of plan.products || []) {
    for (const o of (p.options || []).filter((x) => !x.drop)) {
      const g = o.global_variation || {};
      if (!g.slug) continue;
      usedBy.set(g.slug, [...new Set([...(usedBy.get(g.slug) || []), p.key])]);
      if (!first.has(g.slug)) first.set(g.slug, { g, key: p.key });
      const existing = store[g.slug];
      if (existing && existing.type && g.type && existing.type !== g.type) {
        errors.push({ key: p.key, gate: 'door', message: `the store's variation type "${g.slug}" is "${existing.type}", the plan says "${g.type}" — set type "${existing.type}" to reuse it, or choose another slug` });
      }
    }
  }
  for (const [slug, { g, key }] of first) {
    const who = usedBy.get(slug);
    const existing = store[slug];
    if (existing) {
      if (existing.is_required !== 'yes') {
        errors.push({ key: null, gate: 'variants', message: `the store's variation type "${slug}" is OPTIONAL (is_required: ${existing.is_required || 'not set'}) — a shopper could order ${who.length > 1 ? `these ${who.length} products` : 'this product'} (${who.join(', ')}) without choosing, and the order would not say which one. The import never changes a type it did not create. Ask the merchant: either they make "${slug}" required in the store's admin (Products → Variations → Edit on "${slug}" → "Is Required" → Yes; it applies to every product that uses it), or give this option a NEW slug and the import creates that type as required (the shop's filter then lists it as a separate group)` });
      } else if (!String(existing.error_msg ?? '').trim()) {
        warnings.push(`the store's variation type "${slug}" is required but has no message: a shopper who orders without choosing is stopped without being told why — the merchant can add one in the store's admin (Products → Variations → Edit on "${slug}" → "Error Message")`);
      }
      // A type's label is the store's, on every product that uses it — the store has no per-product label.
      if (existing.title_in_product && g.title_in_product && String(existing.title_in_product).trim() !== String(g.title_in_product).trim()) {
        warnings.push(`the store's type "${slug}" is labelled "${existing.title_in_product}" on every product — your label "${g.title_in_product}" is not used (a type's label cannot be set per product): reuse a type labelled the way you want, or give this option a new slug`);
      }
    } else if (!String(g.error_msg ?? '').trim()) {
      errors.push({ key, gate: 'variants', message: `variation type "${slug}" will be created, as required: set global_variation.error_msg — what a shopper reads when they order without choosing, in the store's language (e.g. "Choisissez une taille")` });
    }
  }
  return { errors, warnings };
}

/** The ratio (width / height) of a listing's image box from its style ("aspect-ratio:1/1;…"), or null (a fixed height). */
export function boxRatio(style) {
  const m = String(style ?? '').match(/aspect-ratio\s*:\s*(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/);
  return m && Number(m[2]) > 0 ? { ratio: Number(m[1]) / Number(m[2]), label: `${m[1]}:${m[2]}` } : null;
}

/**
 * The kept photo that shows one value of an option (image swatches and photo switching), and how it was found:
 *   'set'      — the photo's `values` name the value: the source's own variant photo, or one set in the plan
 *                (that is how a clean gallery shot replaces a variant photo that had to be excluded). The
 *                source's variant photo wins when both are kept.
 *   'inferred' — for the plan's photo_option only, when no photo names the value: a kept variant photo given for
 *                a combination with that value (`combos`) — the combination the store sells when a dropped
 *                option has a keep_value, else the first. This is what links each colour to its photo when two
 *                options change the photo (measured on a real import: 4 products whose colour picks switched
 *                nothing). The dry run shows these links for a person to check.
 */
export function valueImageHow(p, optionIndex, value) {
  const o = p.options[optionIndex];
  if (!o) return null;
  const kept = p.images.filter((i) => i.decision === 'keep');
  const named = kept.filter((i) => (i.values || []).includes(value));
  const pick = named.find((i) => i.roles.includes('variant')) || named[0];
  if (pick) return { image: pick, how: 'set' };
  if (o.source_name !== p.photo_option) return null;
  const pinned = p.options.map((x, i) => (x.drop && x.keep_value != null ? [i, x.keep_value] : null)).filter(Boolean);
  const shows = kept.filter((i) => (i.combos || []).some((c) => c[optionIndex] === value));
  const sold = shows.find((i) => i.combos.some((c) => c[optionIndex] === value && pinned.every(([j, k]) => c[j] === k)));
  const found = sold || shows[0];
  return found ? { image: found, how: 'inferred' } : null;
}
export const valueImage = (p, optionIndex, value) => valueImageHow(p, optionIndex, value)?.image || null;
export function swatchImage(p, optionIndex, value) {
  return p.options[optionIndex]?.global_variation?.type === 'images' ? valueImage(p, optionIndex, value) : null;
}

/** Each offered value of the plan's photo_option, its photo and how it was found (image null: none of its own). */
export function photoLinks(p) {
  const oi = p.options.findIndex((o) => o.source_name === p.photo_option && !o.drop);
  if (oi < 0) return [];
  return p.options[oi].values.filter((v) => v.include !== false).map((v) => {
    const found = valueImageHow(p, oi, v.source_value);
    return { option: p.photo_option, value: v.source_value, title: v.title, image: found?.image || null, how: found?.how || null };
  });
}

/** The kept photos in gallery order — the featured one first: the order they are uploaded and shown. */
export function galleryOrder(p) {
  const kept = p.images.filter((i) => i.decision === 'keep');
  return [...kept.filter((i) => i.file === p.featured), ...kept.filter((i) => i.file !== p.featured)];
}

/** What a kept sheet must have been drawn from: the made files, in gallery order, at the photo target. */
export function keptFingerprint(p, targetKey) {
  const parts = [targetKey, ...galleryOrder(p).map((i) => `${i.file}=${i.final?.sha256 || ''}`)];
  return createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 16);
}

/**
 * Photos of one product that are the same file at two URLs (measured on a real import: one product had two such
 * pairs, shown as duplicate slides). The first keeps the roles, values and combos of both; the other is marked
 * `duplicate_of` and starts excluded. `hashOf(image)` returns a saved file's hash, or null.
 */
export function foldTwins(images, hashOf) {
  const first = new Map();
  for (const img of images) {
    const h = img.file && !img.error ? hashOf(img) : null;
    if (!h) continue;
    const twin = first.get(h);
    if (!twin) { first.set(h, img); continue; }
    for (const r of img.roles) if (!twin.roles.includes(r)) twin.roles.push(r);
    for (const v of img.values || []) if (!twin.values.includes(v)) twin.values.push(v);
    for (const c of img.combos || []) {
      twin.combos = twin.combos || [];
      if (!twin.combos.some((x) => x.join('\u0000') === c.join('\u0000'))) twin.combos.push(c);
    }
    img.duplicate_of = twin.file;
  }
  return images;
}

/**
 * The same file KEPT more than once. A copy found by a fresh fetch starts excluded, but a decision made before
 * stays (a re-fetch never changes one), so copies kept before the fetch found them stay kept — the same photo twice
 * in the gallery. -> [[file, file, …], …]: the kept copies of each file kept twice or more.
 */
export function keptCopies(images) {
  const sets = new Map(); // the first copy (the one the others are duplicate_of) -> the kept copies
  for (const i of images) {
    if (!i.file) continue;
    const first = i.duplicate_of || i.file;
    if (!sets.has(first)) sets.set(first, []);
    if (i.decision === 'keep') sets.get(first).push(i.file);
  }
  return [...sets.values()].filter((kept) => kept.length > 1);
}

// ── what the store is sent ────────────────────────────────────────────────────────────────────────

/**
 * Body for POST /product/variations. `gvIds[optionIndex]` is the library type id, `optionIds[optionIndex]` a
 * Map(source_value -> library option id), `media[file]` { id, url } of each uploaded photo.
 *
 * A photo swatch needs BOTH `img_id` and `img_url`: the storefront draws the swatch from img_url and matches the
 * gallery by img_id, and the store does not derive one from the other (measured on dev1: with img_id alone every
 * swatch rendered an empty src). `gallery_img_id` makes picking a value switch the main photo, on any type.
 *
 * A colour dot carries the plan's own `color_code` for THIS product: a value reused from the store's library
 * ("Red") otherwise shows the library's colour (#ff0000) on a burgundy product. The store keeps an option's
 * colour per product and draws it (plugin read 16-10-2026); it stores nothing when it equals the library's.
 */
export function variationsBody(p, productId, { gvIds, optionIds, media }) {
  return {
    product_id: productId,
    variations: activeIdx(p).map((oi) => ({
      global_variation_id: gvIds[oi],
      is_active: 'yes',
      options: p.options[oi].values.filter((x) => x.include !== false).map((v) => {
        const photo = valueImage(p, oi, v.source_value);
        const m = photo ? media[photo.file] : null;
        const type = p.options[oi].global_variation.type;
        const swatch = m?.id && type === 'images';
        return { global_option_id: optionIds[oi].get(v.source_value),
          ...(type === 'colorbox' && /^#[0-9a-f]{6}$/i.test(v.color_code || '') ? { color_code: v.color_code } : {}),
          ...(swatch ? { img_id: m.id, img_url: m.url } : {}),
          ...(m?.id ? { gallery_img_id: m.id } : {}) };
      }),
    })),
  };
}

/** A row from GET /product/variations, as POST /product/variations takes it back — the product's own choices. */
export const asReplaceRow = (row) => ({
  global_variation_id: row.global_variation_id,
  is_active: row.is_active === 'no' ? 'no' : 'yes',
  options: (row.options || []).map((o) => ({ global_option_id: o.global_option_id,
    ...['title', 'color_code', 'img_url'].reduce((a, k) => (o[k] != null && o[k] !== '' ? { ...a, [k]: o[k] } : a), {}),
    ...['img_id', 'gallery_img_id'].reduce((a, k) => (o[k] ? { ...a, [k]: o[k] } : a), {}) })),
});

/** The product SKU: the source's product SKU, or the variant SKU when only one variant is left. */
export function productSku(p, src) {
  const vs = p.options.length ? storeVariants(p) : p.variants;
  if (!activeIdx(p).length && vs.length === 1 && vs[0].sku) return vs[0].sku;
  return src.product_sku || '';
}

/** Body for POST /products (create) or PATCH /products/{id} (update: no status, so a published product stays published). */
export function productBody(p, src, { prices, featuredId, galleryIds, create }) {
  const c = p.copy;
  const body = {
    title: String(c.title).trim(),
    slug: c.slug || slugify(c.title),
    ...(create ? { status: 'draft' } : {}),
    category_slugs: [...new Set([...(p.category?.slugs || []), ...(p.category?.create || []).map((x) => x.slug)])],
    regular_price: prices.regular_price,
    sale_price: prices.sale_price,
    sku: productSku(p, src),
    featured_image_id: featuredId || 0,
    gallery_image_ids: galleryIds,
    long_description: c.long_description,
  };
  if (c.short_description) body.short_description = c.short_description;
  if (c.specs_html) body.extra_description = c.specs_html;
  if (create && body.sale_price == null) delete body.sale_price;
  return body;
}

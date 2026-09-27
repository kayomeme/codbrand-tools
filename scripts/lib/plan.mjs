// plan.mjs — the import plan: its skeleton, the checks that must pass before anything is written, the
// price maths, and the bodies sent to the store. Pure functions only (no network, no files), so every rule
// here is testable on its own.
//
// The plan is where each JUDGEMENT is recorded — retail price, rewritten copy, keep/exclude per image, how
// each source option maps onto the store's variation library, and (for a retailer's content) the merchant's
// confirmation that they may use it. `checkPlan` refuses until every one is made; that is the point of the
// file. A rule written only in prose can be skipped; this one cannot.

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
    products: [],
  };
}

/**
 * The plan entry for one fetched product. `images` are the files import-fetch saved, in source order:
 * [{ file, url, roles, values, shrink: {engine, from, to} | null, error? }]
 */
export function productEntry(src, images) {
  const main = images.find((i) => i.roles.includes('main') && !i.error) || images.find((i) => !i.error);
  const key = keyOf(src);
  return {
    key,
    platform: src.platform,
    pid: src.pid,
    source_file: `source/${key}.json`,
    // A retailer's own photos and text are not provided for reselling: the merchant must say they may use them.
    ...(src.supplier ? {} : { rights_confirmed: null }),
    copy: { language: null, title: null, slug: null, short_description: null, long_description: null, specs_html: null },
    price: { price: null, compare_at: null },
    variant_prices: {},
    category: { slugs: [], create: [] },
    featured: main ? main.file : null,
    images: images.map((i) => ({
      file: i.file,
      source_url: i.url,
      roles: i.roles,
      values: i.values,
      decision: i.error ? 'exclude' : i.roles.every((r) => r === 'description') ? 'exclude' : 'unreviewed',
      reason: i.error ? 'too-large' : i.roles.every((r) => r === 'description') ? 'description-image' : null,
      alt: null,
      shrink: i.shrink || null,
      ...(i.error ? { error: i.error } : {}),
    })),
    options: src.options.map((o) => ({
      source_name: o.name,
      // An option with one value ("One size", "custom") is not a choice for a shopper: dropped by default.
      drop: o.values.length < 2,
      global_variation: { slug: null, title_in_product: null, type: o.name === src.image_option ? 'images' : 'buttons' },
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
  for (const e of entries) {
    const i = out.products.findIndex((p) => p.key === e.key);
    if (i === -1) { out.products.push(e); continue; }
    const old = out.products[i];
    e.images = e.images.map((img) => {
      const prev = old.images.find((x) => x.source_url === img.source_url);
      return prev ? { ...img, decision: prev.decision, reason: prev.reason, alt: prev.alt } : img;
    });
    out.products[i] = { ...e, copy: old.copy, price: old.price, variant_prices: old.variant_prices,
      category: old.category, featured: old.featured ?? e.featured,
      ...('rights_confirmed' in old ? { rights_confirmed: old.rights_confirmed } : {}),
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
 * The variants the store gets: resolved, included, one per combination of the options that stay. Dropping
 * an option with several values ("Ships from") can leave two variants with the same combination; the first
 * one is kept.
 */
export function storeVariants(p) {
  const seen = new Set();
  const out = [];
  for (const v of p.variants) {
    if (!Array.isArray(v.source_values) || !included(p, v)) continue;
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
 * Every refusal, before any write. `ctx.fileBytes(file)` returns the size of a saved image or null.
 * -> [{ key, gate, message }]   (empty = safe to apply)
 */
export function checkPlan(plan, sources, ctx = {}) {
  const errs = [];
  const err = (key, gate, message) => errs.push({ key, gate, message });
  if (plan?.kind !== PLAN_KIND) return [{ key: null, gate: 'plan', message: 'this is not an import plan (kind)' }];
  const maxBytes = ctx.maxBytes ?? 450 * 1024;

  for (const p of plan.products) {
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

    // IMAGES
    const unreviewed = p.images.filter((i) => !['keep', 'exclude'].includes(i.decision));
    if (unreviewed.length) err(p.key, 'images', `${unreviewed.length} image(s) not reviewed: ${unreviewed.map((i) => i.file || i.source_url).join(', ')} — set decision "keep" or "exclude" on each`);
    for (const i of p.images) {
      if (i.decision === 'exclude' && !i.reason) err(p.key, 'images', `${i.file || i.source_url}: excluded without a reason`);
      if (i.decision !== 'keep') continue;
      if (i.error) err(p.key, 'images', `${i.file || i.source_url}: cannot be kept — ${i.error}`);
      if (!i.alt || !String(i.alt).trim()) err(p.key, 'images', `${i.file}: kept without alt text — describe it in the store's language`);
      const bytes = ctx.fileBytes ? ctx.fileBytes(i.file) : null;
      if (ctx.fileBytes && bytes == null) err(p.key, 'images', `${i.file}: file missing`);
      if (bytes != null && bytes > maxBytes) err(p.key, 'images', `${i.file}: ${Math.round(bytes / 1024)} KB is over the ${Math.round(maxBytes / 1024)} KB ceiling`);
    }
    const kept = p.images.filter((i) => i.decision === 'keep');
    if (!kept.length) err(p.key, 'images', 'no image kept — a product needs at least one');
    if (p.featured && kept.length && !kept.some((i) => i.file === p.featured)) err(p.key, 'images', `featured image ${p.featured} is not kept — point "featured" at a kept image`);

    // VARIANTS
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
    if (activeIdx(p).length && !storeVariants(p).length) err(p.key, 'variants', 'every variant is excluded');

    // CATEGORY (existence is checked against the store at apply time)
    for (const cc of p.category?.create || []) {
      if (!cc.name || !cc.slug) err(p.key, 'category', 'each category.create entry needs a name and a slug');
    }
  }
  return errs;
}

const hostOf = (u) => { try { return new URL(u).host; } catch { return ''; } };

/**
 * The kept photo that shows one value of an option (used for image swatches and photo switching). A photo's
 * `values` can be set in the plan: that is how a clean gallery shot replaces a variant photo that had to be
 * excluded (a logo, a watermark). The source's own variant photo wins when both are kept.
 */
export function valueImage(p, optionIndex, value) {
  if (!p.options[optionIndex]) return null;
  const kept = p.images.filter((i) => i.decision === 'keep' && (i.values || []).includes(value));
  return kept.find((i) => i.roles.includes('variant')) || kept[0] || null;
}
export function swatchImage(p, optionIndex, value) {
  return p.options[optionIndex]?.global_variation?.type === 'images' ? valueImage(p, optionIndex, value) : null;
}

// ── what the store is sent ────────────────────────────────────────────────────────────────────────

/**
 * Body for POST /product/variations. `gvIds[optionIndex]` is the library type id, `optionIds[optionIndex]` a
 * Map(source_value -> library option id), `media[file]` { id, url } of each uploaded photo.
 *
 * A photo swatch needs BOTH `img_id` and `img_url`: the storefront draws the swatch from img_url and matches the
 * gallery by img_id, and the store does not derive one from the other (measured on dev1: with img_id alone every
 * swatch rendered an empty src). `gallery_img_id` makes picking a value switch the main photo, on any type.
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
        const swatch = m?.id && p.options[oi].global_variation.type === 'images';
        return { global_option_id: optionIds[oi].get(v.source_value),
          ...(swatch ? { img_id: m.id, img_url: m.url } : {}),
          ...(m?.id ? { gallery_img_id: m.id } : {}) };
      }),
    })),
  };
}

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

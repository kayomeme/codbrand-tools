// product.mjs — the ONE product shape every source is turned into, and the helpers every source shares.
//
// Each file in sources/ knows one platform's field names and nothing else; it hands its raw data to
// `buildProduct` and gets back the same normalised product, so nothing downstream knows where it came from:
//
//   {
//     schema: 'product/1', platform, route: 'api' | 'fetch' | 'page', supplier: true | false,
//     pid, product_sku, url, fetched_at,
//     facts:  { title, description_text, description_html, category_path[], specs[{name,value}], material[],
//               packing[], properties[], weight_g, hs_code, brand, moq },     <- for the REWRITE, never as-is
//     price:  { kind: 'cost' | 'retail', currency, min, max },              <- reference only, never a price
//     options: [{ name, values[] }],
//     image_option: <option whose value decides the photo> | null,
//     variants: [{ vid, sku, key, values[] | null, price, image, ambiguous, candidates? }],
//     images:   [{ url, roles[] ('main'|'gallery'|'variant'|'description'), values[] }]
//   }
//
// `supplier` is true for platforms whose photos and descriptions are provided for reselling their products
// (CJdropshipping, AliExpress, Alibaba). Anything else — a brand's or another retailer's own store — is not,
// and the import refuses those products until the merchant confirms they may use that content.

export const SUPPLIERS = new Set(['cjdropshipping', 'aliexpress', 'alibaba']);

export const num = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const m = String(v ?? '').match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
};

/** "4.81 -- 10.87", "8.13-8.62", 10.42, "10.42" -> { min, max } */
export function priceRange(v) {
  const all = String(v ?? '').match(/\d+(?:\.\d+)?/g);
  if (!all) return { min: null, max: null };
  const n = all.map(Number);
  return { min: Math.min(...n), max: Math.max(...n) };
}

/** A list of names, whatever shape a source sent it in (array, JSON string, one object, "a, b"). */
export function names(v) {
  if (v == null || v === '') return [];
  if (Array.isArray(v)) return v.flatMap(names);
  if (typeof v === 'object') return [String(v.nameEn ?? v.name ?? '').trim()].filter(Boolean);
  const s = String(v).trim();
  if (s.startsWith('[') || s.startsWith('{')) {
    try { return names(JSON.parse(s)); } catch { /* not JSON — a plain string */ }
  }
  return s.split(/[,;]/).map((x) => x.trim()).filter(Boolean);
}

// Named HTML entities, case-sensitive (&Eacute; is É, &eacute; is é): the markup ones, punctuation, and every
// accented Latin letter — supplier descriptions in French, Spanish or German arrive full of them.
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', laquo: '«', raquo: '»', deg: '°',
  copy: '©', reg: '®', trade: '™', hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  euro: '€', pound: '£', times: '×', middot: '·', bull: '•', szlig: 'ß', iexcl: '¡', iquest: '¿', ordm: 'º', ordf: 'ª' };
const ACCENTS = { grave: '̀', acute: '́', circ: '̂', tilde: '̃', uml: '̈', ring: '̊', cedil: '̧' };
for (const base of 'AEIOUYNCaeiouync') {
  for (const [name, mark] of Object.entries(ACCENTS)) {
    const ch = (base + mark).normalize('NFC');
    if (ch.length === 1) ENTITIES[base + name] = ch;
  }
}
Object.assign(ENTITIES, { AElig: 'Æ', aelig: 'æ', OElig: 'Œ', oelig: 'œ', Oslash: 'Ø', oslash: 'ø', ETH: 'Ð', eth: 'ð', THORN: 'Þ', thorn: 'þ' });
export const decodeEntities = (s) => String(s ?? '').replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
  if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  return ENTITIES[e] ?? ENTITIES[e.toLowerCase()] ?? m;
});

export function htmlToText(html) {
  return decodeEntities(String(html ?? '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ''))
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function descriptionImages(html) {
  return [...String(html ?? '').matchAll(/<img[^>]+src\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]);
}

/** One image URL, the same way everywhere: absolute https, no query (sources add processing params). */
export function cleanUrl(u, base) {
  if (!u) return null;
  let s = String(typeof u === 'object' ? u.url ?? u.src ?? u.contentUrl ?? '' : u).trim();
  if (!s) return null;
  if (s.startsWith('//')) s = 'https:' + s;
  try {
    const x = new URL(s, base || undefined); // a null base would make every URL invalid
    x.search = '';
    x.hash = '';
    if (x.protocol === 'http:') x.protocol = 'https:';
    return x.protocol === 'https:' ? x.href : null;
  } catch { return null; }
}

// Letter sizes in wearing order. Sources list them as they were entered ("L, M, S, XL …"), and the store shows
// options in the order they are sent, so a list made ONLY of sizes is put in order; anything else is left
// exactly as the source gave it.
const SIZE_RANK = { XXS: 0, '2XS': 0, XS: 1, S: 2, M: 3, L: 4, XL: 5, XXL: 6, '2XL': 6, XXXL: 7, '3XL': 7, XXXXL: 8, '4XL': 8, XXXXXL: 9, '5XL': 9, '6XL': 10 };
export function sortSizes(values) {
  const rank = (v) => SIZE_RANK[String(v).replace(/\s+/g, '').toUpperCase()] ?? (/^\d+(\.\d+)?$/.test(String(v).trim()) ? 100 + Number(v) : null);
  if (values.length < 2 || !values.every((v) => rank(v) != null)) return values;
  return [...values].sort((a, b) => rank(a) - rank(b));
}

/**
 * Split each variant key ("Black-XL") into one value per option ("Color-Size").
 *
 * Some sources join values with "-", so a value that contains one ("2-3Y", "T-Shirt") cannot be split
 * blindly. A key with exactly one part per option splits directly; any other key is matched against the values
 * the direct splits established, position by position. One best split with at most one new value resolves it;
 * anything else stays `ambiguous` with the candidates listed, and the apply step refuses it until someone
 * picks one.
 */
export function splitVariantKeys(optionNames, keys) {
  const n = optionNames.length;
  const known = optionNames.map(() => new Set());
  const direct = keys.map((k) => {
    const key = String(k ?? '').trim();
    if (n === 0) return [];
    if (n === 1) return key ? [key] : null;
    const parts = key.split('-').map((p) => p.trim());
    return parts.length === n && parts.every(Boolean) ? parts : null;
  });
  direct.forEach((v) => v && v.forEach((x, i) => known[i].add(x)));

  return keys.map((k, idx) => {
    if (direct[idx]) return { values: direct[idx], ambiguous: false };
    const parts = String(k ?? '').split('-').map((p) => p.trim());
    const candidates = compositions(parts, n);
    const score = (c) => c.filter((v, i) => known[i].has(v)).length;
    const best = Math.max(0, ...candidates.map(score));
    const top = candidates.filter((c) => score(c) === best);
    if (top.length === 1 && best >= n - 1) return { values: top[0], ambiguous: false };
    return { values: null, ambiguous: true, candidates: (best > 0 ? top : candidates).slice(0, 12) };
  });
}

// Every way to cut `parts` into `n` contiguous, non-empty groups, each re-joined with "-".
function compositions(parts, n) {
  if (n <= 0 || parts.length < n) return [];
  if (n === 1) return [[parts.join('-')]];
  const out = [];
  for (let i = 1; i <= parts.length - n + 1; i++) {
    for (const rest of compositions(parts.slice(i), n - 1)) out.push([parts.slice(0, i).join('-'), ...rest]);
  }
  return out;
}

/**
 * The normalised product. `rawVariants` carry either `values` (already one per option) or a joined `key`
 * that is split here. Prices are the SOURCE's figures: `priceKind` says whether they are a supplier's cost
 * or another store's retail price.
 */
export function buildProduct({ platform, route, pid, productSku, url, title, descriptionHtml = '', categoryPath = [],
  specs = [], material, packing, properties, weight, hsCode, brand, moq, optionNames = [], currency = null,
  priceKind, price = {}, mainImage, gallery = [], rawVariants = [] }) {
  const needSplit = rawVariants.some((v) => !Array.isArray(v.values));
  const split = needSplit ? splitVariantKeys(optionNames, rawVariants.map((v) => v.key)) : null;
  const variants = rawVariants.map((v, i) => {
    const s = Array.isArray(v.values) ? { values: v.values.map((x) => String(x).trim()), ambiguous: false } : split[i];
    return {
      vid: String(v.vid ?? ''),
      sku: String(v.sku ?? ''),
      key: String(v.key ?? (Array.isArray(v.values) ? v.values.join(' / ') : '')),
      values: s.values,
      price: num(v.price),
      image: cleanUrl(v.image, url),
      ambiguous: s.ambiguous,
      ...(s.candidates ? { candidates: s.candidates } : {}),
    };
  });

  const options = optionNames.map((name, i) => {
    const seen = [];
    for (const v of variants) if (v.values && !seen.includes(v.values[i])) seen.push(v.values[i]);
    return { name, values: sortSizes(seen) };
  });

  // The option whose value decides the photo: every value of it maps to one image, and the images differ.
  let imageOption = null;
  for (let i = 0; i < options.length && !imageOption; i++) {
    const byValue = new Map();
    let consistent = true;
    for (const v of variants) {
      if (!v.values || !v.image) continue;
      const k = v.values[i];
      if (byValue.has(k) && byValue.get(k) !== v.image) { consistent = false; break; }
      byValue.set(k, v.image);
    }
    if (consistent && byValue.size > 1 && new Set(byValue.values()).size > 1) imageOption = options[i].name;
  }

  const images = [];
  const add = (u, role, value) => {
    const c = cleanUrl(u, url);
    if (!c) return;
    let img = images.find((x) => x.url === c);
    if (!img) { img = { url: c, roles: [], values: [] }; images.push(img); }
    if (!img.roles.includes(role)) img.roles.push(role);
    if (value && !img.values.includes(value)) img.values.push(value);
  };
  if (mainImage) add(mainImage, 'main');
  for (const g of gallery) add(g, 'gallery');
  const io = imageOption ? optionNames.indexOf(imageOption) : -1;
  for (const v of variants) if (v.image) add(v.image, 'variant', io >= 0 && v.values ? v.values[io] : null);
  for (const d of descriptionImages(descriptionHtml)) add(d, 'description');

  const prices = variants.map((v) => v.price).filter((c) => c != null);
  return {
    schema: 'product/1',
    platform,
    route,
    supplier: SUPPLIERS.has(platform),
    pid: String(pid),
    product_sku: String(productSku ?? ''),
    url: url || null,
    fetched_at: new Date().toISOString(),
    facts: {
      title: String(title ?? '').trim(),
      description_text: htmlToText(descriptionHtml),
      description_html: String(descriptionHtml ?? ''),
      category_path: categoryPath,
      specs: specs.filter((s) => s && s.name && s.value != null && String(s.value).trim() !== '')
        .map((s) => ({ name: String(s.name).trim(), value: String(s.value).trim() })),
      material: names(material),
      packing: names(packing),
      properties: names(properties),
      weight_g: weight == null || weight === '' ? null : String(weight),
      hs_code: hsCode ? String(hsCode) : null,
      brand: brand ? String(brand) : null,
      moq: moq ? Number(moq) : null,
    },
    price: {
      kind: priceKind || (SUPPLIERS.has(platform) ? 'cost' : 'retail'),
      currency: currency || null,
      min: prices.length ? Math.min(...prices) : price.min ?? null,
      max: prices.length ? Math.max(...prices) : price.max ?? null,
    },
    options,
    image_option: imageOption,
    variants,
    images,
  };
}

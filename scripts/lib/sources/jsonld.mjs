// sources/jsonld.mjs — ANY product page that describes its product with schema.org data (JSON-LD `Product`
// or `ProductGroup`), which most shops publish for search engines — plus the page's Open Graph tags.
//
// It gives what the page declares and no more: name, description, photos, SKU, brand, price, and — when the
// page uses a ProductGroup — its variants (`variesBy` + `hasVariant`). Whatever it lacks, the agent fills in
// the plan by reading the page. Treated as a retailer's own content: prices are retail, and the import
// refuses the product until the merchant confirms they may use its photos and text.

import { buildProduct, decodeEntities } from '../product.mjs';

const flat = (x) => (Array.isArray(x) ? x.flatMap(flat) : x && typeof x === 'object' && x['@graph'] ? flat(x['@graph']) : x ? [x] : []);
const types = (o) => [].concat(o?.['@type'] || []).map(String);
export const isProductNode = (o) => types(o).some((t) => /^(Product|ProductGroup)$/i.test(t));

/** Every JSON-LD object in an HTML page, @graph and arrays flattened. */
export function jsonLdFromHtml(html) {
  return [...String(html).matchAll(/<script[^>]+type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)]
    .flatMap((m) => { try { return flat(JSON.parse(m[1].trim())); } catch { return []; } });
}
/** Open Graph tags of an HTML page: { title, image, description, … } */
export function ogFromHtml(html) {
  const out = {};
  for (const m of String(html).matchAll(/<meta[^>]+(?:property|name)\s*=\s*["']og:([^"']+)["'][^>]*>/gi)) {
    const c = m[0].match(/content\s*=\s*["']([^"']*)["']/i);
    if (c && !(m[1] in out)) out[m[1]] = decodeEntities(c[1]);
  }
  return out;
}

const imagesOf = (v) => [].concat(v || []).map((x) => (typeof x === 'string' ? x : x?.url || x?.contentUrl)).filter(Boolean);
const text = (v) => (v == null ? null : typeof v === 'object' ? v.name ?? v['@value'] ?? null : String(v));
function offerOf(o) {
  const offers = [].concat(o?.offers || []);
  const prices = [];
  let currency = null;
  for (const off of offers) {
    for (const k of ['price', 'lowPrice', 'highPrice']) if (off?.[k] != null && !Number.isNaN(Number(off[k]))) prices.push(Number(off[k]));
    if (off?.priceSpecification?.price != null) prices.push(Number(off.priceSpecification.price));
    currency = currency || off?.priceCurrency || off?.priceSpecification?.priceCurrency || null;
  }
  return { price: prices.length ? Math.min(...prices) : null, max: prices.length ? Math.max(...prices) : null, currency };
}
// "https://schema.org/color" -> "color" -> "Color"
const propName = (v) => String(v).split(/[/#]/).pop();
const label = (p) => p.charAt(0).toUpperCase() + p.slice(1).replace(/([a-z])([A-Z])/g, '$1 $2');

/** A capture or fetch result: data is { jsonld: [...], og: {...} }. */
export function fromJsonLd(c, route = 'page') {
  const nodes = flat(c?.data?.jsonld || []);
  const group = nodes.find((n) => types(n).some((t) => /^ProductGroup$/i.test(t)));
  const prod = group || nodes.find(isProductNode);
  if (!prod) throw new Error('no schema.org Product on this page');
  const og = c?.data?.og || {};
  const variantsLd = [].concat(group?.hasVariant || prod.hasVariant || []).filter((v) => v && typeof v === 'object');
  const props = [].concat(group?.variesBy || []).map(propName).filter(Boolean);
  const top = offerOf(prod);
  const rawVariants = variantsLd.length && props.length
    ? variantsLd.map((v, i) => ({
        vid: String(v.sku || v['@id'] || i),
        sku: v.sku || '',
        values: props.map((p) => text(v[p]) || text([].concat(v.additionalProperty || []).find((a) => String(a?.name).toLowerCase() === p.toLowerCase())?.value) || ''),
        price: offerOf(v).price,
        image: imagesOf(v.image)[0] || null,
      })).filter((v) => v.values.every(Boolean))
    : [{ vid: String(prod.sku || prod['@id'] || c.url || 'product'), sku: prod.sku || '', values: [], price: top.price, image: null }];
  const firstVariantOffer = variantsLd.map(offerOf).find((o) => o.currency);
  const url = c.url ? String(c.url).split('#')[0] : null;
  // The page's own name in its URL ("…/orbit-terrarium-large/") when it declares no SKU or id.
  const slugOfUrl = (() => { try { return new URL(url).pathname.split('/').filter(Boolean).pop() || null; } catch { return null; } })();
  return buildProduct({
    platform: 'jsonld',
    route,
    pid: String(prod.productGroupID || prod.sku || slugOfUrl || prod['@id'] || 'product').replace(/[^0-9A-Za-z._-]+/g, '-').slice(0, 80),
    productSku: prod.productGroupID || prod.sku || '',
    url,
    title: text(prod.name) || og.title,
    descriptionHtml: text(prod.description) || og.description || '',
    categoryPath: prod.category ? [text(prod.category)] : [],
    specs: [...(prod.material ? [{ name: 'Material', value: text(prod.material) }] : []),
      ...[].concat(prod.additionalProperty || []).map((a) => ({ name: a?.name, value: text(a?.value) }))],
    brand: text(prod.brand),
    optionNames: rawVariants.length && rawVariants[0].values.length ? props.map(label) : [],
    currency: top.currency || firstVariantOffer?.currency || null,
    priceKind: 'retail',
    price: { min: top.price, max: top.max },
    mainImage: imagesOf(prod.image)[0] || og.image,
    gallery: [...imagesOf(prod.image), ...(og.image ? [og.image] : [])],
    rawVariants,
  });
}

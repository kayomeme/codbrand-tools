// sources/woocommerce.mjs — a WooCommerce store. The ONE file that knows WooCommerce's product page.
//
// A standard WooCommerce product page carries everything in its HTML: the product's schema.org data (name,
// description, photo, price) and, for a product with options, `data-product_variations` on its variations form
// — every variation's attributes, price, crossed-out price, SKU and photo — plus one <select> per attribute
// with the shopper-facing labels. So it is read by a plain fetch of the page, or by page-capture.js.
// (A product with very many variations loads them on demand instead; then only the schema.org data is there.)
//
// A WooCommerce store is a RETAILER: retail prices, and its own photos and text — the import refuses the
// product until the merchant confirms they may use them.

import { buildProduct, decodeEntities, htmlToText } from '../product.mjs';
import { jsonLdFromHtml, ogFromHtml, isProductNode } from './jsonld.mjs';

const humanize = (s) => {
  const t = String(s).replace(/^attribute_/, '').replace(/^pa_/, '').replace(/[-_]+/g, ' ').trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
};

/** The capture shape, from a fetched product page's HTML. null when the page is not a WooCommerce product. */
export function wooCaptureFromHtml(html, url) {
  const s = String(html);
  if (!/woocommerce/i.test(s)) return null;
  let variations = null;
  const m = s.match(/data-product_variations\s*=\s*"([^"]*)"/);
  if (m) { try { variations = JSON.parse(decodeEntities(m[1])); } catch { variations = null; } }
  const selects = [...s.matchAll(/<select[^>]*name\s*=\s*"(attribute_[^"]+)"[^>]*>([\s\S]*?)<\/select>/gi)].map((sel) => ({
    name: sel[1],
    label: '',
    options: [...sel[2].matchAll(/<option[^>]*value\s*=\s*"([^"]*)"[^>]*>([\s\S]*?)<\/option>/gi)]
      .filter((o) => o[1]).map((o) => ({ value: decodeEntities(o[1]), text: htmlToText(o[2]) })),
  }));
  const gallery = [...s.matchAll(/woocommerce-product-gallery__image[^>]*>\s*<a[^>]+href\s*=\s*"([^"]+)"/gi)].map((g) => decodeEntities(g[1]));
  const jsonld = jsonLdFromHtml(s);
  if (!variations && !jsonld.some(isProductNode)) return null;
  const id = (s.match(/data-product_id\s*=\s*"(\d+)"/) || s.match(/name\s*=\s*"add-to-cart"\s+value\s*=\s*"(\d+)"/) || [])[1];
  return { platform: 'woocommerce', id: id || url, url, data: { variations, selects, gallery, jsonld, og: ogFromHtml(s) } };
}

export function fromWoo(c, route = 'page') {
  const d = c?.data || {};
  const ld = (d.jsonld || []).find(isProductNode) || {};
  const offers = [].concat(ld.offers || []);
  const currency = offers.find((o) => o?.priceCurrency)?.priceCurrency || null;
  const vars = Array.isArray(d.variations) ? d.variations.filter((v) => v && v.variation_is_active !== false && v.is_in_stock !== false) : [];
  const attrKeys = vars.length
    ? [...new Set(vars.flatMap((v) => Object.keys(v.attributes || {})))]
    : (d.selects || []).map((x) => x.name);
  const sel = new Map((d.selects || []).map((x) => [x.name, x]));
  const valueText = (key, value) => sel.get(key)?.options.find((o) => o.value === value)?.text || humanize(value);

  // A variation attribute left empty means "any value": it stands for every option of that <select>.
  const rawVariants = [];
  for (const v of vars) {
    let combos = [[]];
    for (const key of attrKeys) {
      const val = v.attributes?.[key];
      const choices = val ? [val] : (sel.get(key)?.options || []).map((o) => o.value);
      combos = combos.flatMap((cmb) => choices.map((ch) => [...cmb, ch]));
    }
    for (const cmb of combos) {
      rawVariants.push({
        vid: `${v.variation_id}${combos.length > 1 ? `-${cmb.join('-')}` : ''}`,
        sku: v.sku || `WC-${c.id}-${v.variation_id}`,
        values: cmb.map((val, i) => valueText(attrKeys[i], val)),
        price: v.display_price,
        image: v.image?.full_src || v.image?.url || v.image?.src || null,
      });
    }
  }
  const ldPrice = offers.map((o) => Number(o?.price ?? o?.lowPrice)).filter((n) => !Number.isNaN(n));
  if (!rawVariants.length) rawVariants.push({ vid: String(c.id), sku: ld.sku || '', values: [], price: ldPrice.length ? Math.min(...ldPrice) : null, image: null });

  const ldImages = [].concat(ld.image || []).map((x) => (typeof x === 'string' ? x : x?.url)).filter(Boolean);
  return buildProduct({
    platform: 'woocommerce',
    route,
    pid: String(c.id).replace(/[^0-9A-Za-z._-]+/g, '-'),
    productSku: ld.sku || `WC-${c.id}`,
    url: c.url || null,
    title: ld.name || d.og?.title,
    descriptionHtml: ld.description || d.og?.description || '',
    brand: typeof ld.brand === 'object' ? ld.brand?.name : ld.brand,
    optionNames: vars.length ? attrKeys.map((k) => sel.get(k)?.label || humanize(k)) : [],
    currency,
    priceKind: 'retail',
    mainImage: ldImages[0] || d.og?.image,
    gallery: [...(d.gallery || []), ...ldImages],
    rawVariants,
  });
}

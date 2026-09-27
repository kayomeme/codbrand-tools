// sources/cj.mjs — CJdropshipping. The ONE file that knows CJ's field names, for both of its routes:
//   the official API (GET /api2.0/v1/product/query, with the merchant's access token), and
//   the product page (window.productDetailData, captured by page-capture.js in a browser).
// CJ's docs disagree with themselves on types (a list as an array, a JSON string or one object; a price as a
// number, a string or a range "4.81 -- 10.87"), so every reader accepts all of them.

import { buildProduct, priceRange } from '../product.mjs';

export const isCjUrl = (u) => /(^|\.)cjdropshipping\.(com|cn)$/i.test(hostOf(u));
const hostOf = (u) => { try { return new URL(u).host; } catch { return ''; } };

/** The CJ product id inside a product URL (…-p-<pid>.html), or the argument itself. */
export function cjPidFrom(arg) {
  const m = String(arg).match(/-p-([0-9A-Za-z-]+?)\.html/);
  return m ? m[1] : String(arg).trim();
}
/** A bare CJ product id (numeric or UUID-shaped) or a CJ SKU. */
export const looksLikeCjId = (s) => /^(\d{15,22}|[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}|CJ[A-Z0-9-]{6,})$/i.test(String(s).trim());

const optionNamesOf = (v) => String(v ?? '').split('-').map((s) => s.trim()).filter(Boolean);
const list = (v) => {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string' && v.trim().startsWith('[')) { try { return JSON.parse(v); } catch { return []; } }
  return v ? [v] : [];
};

/** Route 1 — the `data` of GET /api2.0/v1/product/query. */
export function fromCjApi(d, url = null) {
  if (!d || typeof d !== 'object' || !d.pid) throw new Error('not a CJ product (no pid in the API response)');
  return buildProduct({
    platform: 'cjdropshipping',
    route: 'api',
    pid: d.pid,
    productSku: d.productSku,
    url,
    title: d.productNameEn,
    descriptionHtml: d.description,
    categoryPath: d.categoryName ? String(d.categoryName).split('>').map((s) => s.trim()).filter(Boolean) : [],
    material: d.materialNameEnSet ?? d.materialNameEn,
    packing: d.packingNameEnSet ?? d.packingNameEn,
    properties: d.productProEnSet ?? d.productProEn,
    weight: d.productWeight,
    hsCode: d.entryCode,
    optionNames: optionNamesOf(d.productKeyEn),
    currency: 'USD',
    priceKind: 'cost',
    price: priceRange(d.sellPrice),
    mainImage: d.bigImage,
    gallery: list(d.productImageSet ?? d.productImage),
    rawVariants: list(d.variants).map((v) => ({
      vid: v.vid, sku: v.variantSku, key: v.variantKey, price: v.variantSellPrice, image: v.variantImage,
    })),
  });
}

/** Route 3 — a page capture: { platform: 'cjdropshipping', url, data: window.productDetailData }. */
export function fromCjCapture(c) {
  const d = c?.data;
  if (!d || !d.id) throw new Error('not a CJ product page capture');
  return buildProduct({
    platform: 'cjdropshipping',
    route: 'page',
    pid: d.id,
    productSku: d.sku,
    url: c.url,
    title: d.nameEn,
    descriptionHtml: d.description,
    categoryPath: list(d.categories).map((x) => String(x?.name ?? x).trim()).filter(Boolean),
    material: d.material,
    packing: d.packing,
    properties: d.property,
    weight: d.weight,
    hsCode: d.hsCode,
    optionNames: optionNamesOf(d.variantKeyEn),
    currency: d.currency || 'USD',
    priceKind: 'cost',
    price: priceRange(d.sellPrice),
    mainImage: d.image,
    gallery: list(d.images),
    rawVariants: list(d.stanProducts).map((v) => ({
      vid: v.id, sku: v.sku, key: v.variantKey, price: v.sellPrice, image: v.image,
    })),
  });
}

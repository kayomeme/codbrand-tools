// sources/aliexpress.mjs — AliExpress. The ONE file that knows AliExpress's field names.
//
// Route: the product page, in a browser. AliExpress loads a product's options and prices with a signed request
// AFTER the page renders, so a plain fetch of the page does not contain them; page-capture.js copies them from
// the loaded page (window._d_c_.lifeCycleEventList[0].data — components SKU, PRICE, PRODUCT_TITLE,
// HEADER_IMAGE_PC, PRODUCT_PROP_PC, DESC) plus the description page it links to.
//
// Prices and texts come in the VISITOR's currency and language (a visitor from Morocco sees MAD and French);
// the currency is recorded, so the plan's exchange rate is set for that currency.

import { buildProduct, num } from '../product.mjs';

export const isAliExpressUrl = (u) => { try { return /(^|\.)aliexpress\.[a-z.]+$/i.test(new URL(u).host); } catch { return false; } };
export const aliExpressIdFrom = (u) => (String(u).match(/\/item\/(\d+)\.html/) || [])[1] || null;

/** "DH164.93|164|93" (label | whole | decimals) — or any formatted string — to a number. */
export function aePrice(p) {
  if (!p) return null;
  if (p.salePrice?.value != null) return num(p.salePrice.value);
  const parts = String(p.salePriceLocal ?? '').split('|');
  if (parts.length >= 2 && /^\d+$/.test(parts[1])) return Number(`${parts[1]}.${/^\d+$/.test(parts[2] || '') ? parts[2] : '0'}`);
  const s = String(p.salePriceString ?? '').replace(/[^\d.,]/g, '');
  return num(s.includes(',') && !s.includes('.') ? s.replace(',', '.') : s.replace(/,/g, ''));
}

export function fromAliExpressCapture(c) {
  const d = c?.data;
  if (!d?.SKU || !d?.PRICE) throw new Error('not an AliExpress product page capture (no SKU/PRICE data)');
  const pid = d.GLOBAL?.productId || aliExpressIdFrom(c.url) || c.id;
  const props = d.SKU.skuProperties || [];
  const priceMap = d.PRICE.skuIdStrPriceInfoMap || {};
  const firstPrice = Object.values(priceMap)[0];
  const currency = firstPrice?.originalPrice?.currency || d.GLOBAL?.currencyCode || null;

  // A sku path is "14:193;5:200003528" — property:value pairs; a seller's own value name follows a "#".
  const rawVariants = [];
  for (const path of d.SKU.skuPaths || []) {
    if (path.salable === false) continue; // not for sale: never imported
    const values = [];
    let image = null;
    let ok = true;
    for (const pair of String(path.skuAttr || '').split(';').filter(Boolean)) {
      const [pv, custom] = pair.split('#');
      const [propId, valueId] = pv.split(':').map(Number);
      const prop = props.find((p) => p.skuPropertyId === propId);
      const val = prop?.skuPropertyValues?.find((v) => Number(v.propertyValueIdLong) === valueId);
      if (!prop || !val) { ok = false; break; }
      values[props.indexOf(prop)] = (custom || val.propertyValueDisplayName || val.propertyValueName || '').trim();
      if (val.skuPropertyImagePath) image = val.skuPropertyImagePath;
    }
    if (!ok || props.some((_, i) => !values[i])) continue; // (a sparse array's holes are skipped by .some on it)
    rawVariants.push({ vid: path.skuIdStr, sku: `AE-${pid}-${path.skuIdStr}`, values, price: aePrice(priceMap[path.skuIdStr]), image });
  }

  const specs = (d.PRODUCT_PROP_PC?.showedProps || []).map((p) => ({ name: p.attrName, value: p.attrValue }));
  return buildProduct({
    platform: 'aliexpress',
    route: 'page',
    pid,
    productSku: `AE-${pid}`,
    url: c.url ? String(c.url).split('?')[0] : null,
    title: d.PRODUCT_TITLE?.text || d.GLOBAL?.subject,
    descriptionHtml: d.description_html || '',
    categoryPath: [],
    specs,
    brand: specs.find((s) => /\b(brand|marque|marca|marke)\b/i.test(s.name))?.value, // "Nom de marque", "Brand Name"
    optionNames: props.map((p) => String(p.skuPropertyName).trim()),
    currency,
    priceKind: 'cost',
    mainImage: (d.HEADER_IMAGE_PC?.imagePathList || [])[0],
    gallery: d.HEADER_IMAGE_PC?.imagePathList || [],
    rawVariants,
  });
}

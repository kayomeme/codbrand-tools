// sources/shopify.mjs — a Shopify store. The ONE file that knows Shopify's product JSON.
//
// Route: a plain fetch of the store's own public product file, `/products/<handle>.json` — no browser, no key.
// It carries options with one value per variant (option1..3, so nothing has to be split), each variant's price,
// crossed-out price and SKU, and which photo belongs to which variant. The currency comes from `/cart.js`.
//
// A Shopify store is a RETAILER, not a supplier: its prices are its own retail prices, and its photos and text
// are usually its own work. The import refuses such a product until the merchant confirms they may use them.

import { buildProduct } from '../product.mjs';

const UA = 'Mozilla/5.0 (compatible; codbrand-tools product import)';
const get = (u) => fetch(u, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(30000) });

/** "https://shop/collections/x/products/handle?variant=1" -> { origin, handle } */
export function shopifyHandle(url) {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/\/products\/([^/?#]+)/);
    return m ? { origin: u.origin, handle: decodeURIComponent(m[1]).replace(/\.(json|js)$/, '') } : null;
  } catch { return null; }
}

/** Fetch one product from a Shopify store. null when the store does not answer like Shopify. */
export async function fetchShopify(url) {
  const h = shopifyHandle(url);
  if (!h) return null;
  const r = await get(`${h.origin}/products/${encodeURIComponent(h.handle)}.json`);
  if (!r.ok) return null;
  let j;
  try { j = await r.json(); } catch { return null; }
  if (!j?.product?.variants) return null;
  let currency = null;
  try { currency = (await (await get(`${h.origin}/cart.js`)).json()).currency || null; } catch { /* unknown currency is fine */ }
  return fromShopify({ platform: 'shopify', url: `${h.origin}/products/${h.handle}`, data: { product: j.product, currency } }, 'fetch');
}

/** A capture or a fetch result: data is { product, currency } (or the bare product). */
export function fromShopify(c, route = 'page') {
  const p = c?.data?.product || c?.data;
  if (!p?.variants) throw new Error('not a Shopify product');
  const options = (p.options || []).filter((o) => o && o.name && !(o.name === 'Title' && (o.values || []).length === 1 && o.values[0] === 'Default Title'));
  const byId = new Map((p.images || []).map((i) => [i.id, i.src]));
  const rawVariants = p.variants.map((v) => ({
    vid: String(v.id),
    sku: v.sku || `SH-${p.id}-${v.id}`,
    values: options.map((_, i) => v[`option${i + 1}`]),
    price: v.price,
    image: v.featured_image?.src || byId.get(v.image_id) || null,
  }));
  // Tags are left out on purpose: they are the store's own internal labels ("Final Sale", "Yotpo Points"…), not
  // facts about the product.
  return buildProduct({
    platform: 'shopify',
    route,
    pid: p.id,
    productSku: `SH-${p.id}`,
    url: c.url || null,
    title: p.title,
    descriptionHtml: p.body_html || '',
    categoryPath: p.product_type ? [p.product_type] : [],
    specs: p.product_type ? [{ name: 'Type', value: p.product_type }] : [],
    brand: p.vendor,
    optionNames: options.map((o) => o.name),
    currency: c?.data?.currency || null,
    priceKind: 'retail',
    mainImage: (p.images || [])[0]?.src || p.image?.src,
    gallery: (p.images || []).map((i) => i.src),
    rawVariants,
  });
}

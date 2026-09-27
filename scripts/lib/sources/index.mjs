// sources/index.mjs — which source a product comes from, and by which route.
//
//   fetchProduct(url or CJ id)   a plain fetch where the source allows it: CJ's official API (with a token),
//                                a Shopify store's product file, a WooCommerce page, any page with schema.org data
//   fromCapture(capture)         a product captured in a browser by page-capture.js (every source)
//
// When a plain fetch cannot get the product (AliExpress and Alibaba load theirs after the page renders; many
// sites answer a script with a human check), it throws NeedsBrowser, and the caller says: capture it in a browser.

import { fromCjApi, fromCjCapture, isCjUrl, looksLikeCjId, cjPidFrom } from './cj.mjs';
import { fromAliExpressCapture, isAliExpressUrl } from './aliexpress.mjs';
import { fromAlibabaCapture, isAlibabaUrl } from './alibaba.mjs';
import { fetchShopify, fromShopify } from './shopify.mjs';
import { wooCaptureFromHtml, fromWoo } from './woocommerce.mjs';
import { jsonLdFromHtml, ogFromHtml, isProductNode, fromJsonLd } from './jsonld.mjs';

export class NeedsBrowser extends Error {}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const CHALLENGE = /<title>\s*(human verification|just a moment|attention required|access denied|security check)|challenges\.cloudflare\.com|captcha-delivery|px-captcha|_Incapsula_Resource|\/punish\?|baxia/i;

/** A product captured in a browser, whatever the source. */
export function fromCapture(c) {
  switch (c?.platform) {
    case 'cjdropshipping': return fromCjCapture(c);
    case 'aliexpress': return fromAliExpressCapture(c);
    case 'alibaba': return fromAlibabaCapture(c);
    case 'shopify': return fromShopify(c, 'page');
    case 'woocommerce': return fromWoo(c, 'page');
    case 'jsonld': return fromJsonLd(c, 'page');
    default: throw new Error(`unknown capture platform "${c?.platform}"`);
  }
}

/** Every capture inside a file saved by page-download.js (or a single capture). */
export function capturesIn(json) {
  if (json?.kind === 'page-captures/1') return json.captures || [];
  if (json?.kind === 'page-capture/1') return [json];
  throw new Error('not a file saved by page-download.js');
}

/** One product by a plain fetch. `cj` is the CJ API client when a token is set. */
export async function fetchProduct(arg, { cj } = {}) {
  const s = String(arg).trim();
  const isUrl = /^https?:\/\//i.test(s);
  if ((isUrl && isCjUrl(s)) || (!isUrl && looksLikeCjId(s))) {
    if (!cj) throw new NeedsBrowser('CJdropshipping: set CJ_ACCESS_TOKEN to use the official API, or capture the page in a browser');
    return fromCjApi(await cj.product(cjPidFrom(s)), isUrl ? s : null);
  }
  if (!isUrl) throw new Error(`"${s}" is neither a product URL nor a CJ product id`);
  if (isAliExpressUrl(s)) throw new NeedsBrowser('AliExpress loads a product\'s options and prices after the page renders — capture it in a browser');
  if (isAlibabaUrl(s)) throw new NeedsBrowser('Alibaba loads a product\'s options after the page renders — capture it in a browser');

  let r;
  try { r = await fetch(s, { headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' }, signal: AbortSignal.timeout(30000) }); }
  catch (e) { throw new Error(`could not reach ${new URL(s).host}: ${e.message}`); }
  const html = await r.text();
  if (CHALLENGE.test(html.slice(0, 60000)) || r.status === 403 || r.status === 429 || r.status === 503) {
    throw new NeedsBrowser(`${new URL(s).host} answered with a human check or a refusal (HTTP ${r.status}) — capture it in a browser`);
  }
  if (!r.ok) throw new Error(`${new URL(s).host} answered HTTP ${r.status} for this page`);

  if (/cdn\.shopify\.com|Shopify\.shop|shopify-section/i.test(html)) {
    const p = await fetchShopify(s);
    if (p) return p;
  }
  const woo = wooCaptureFromHtml(html, s);
  if (woo) return fromWoo(woo, 'fetch');
  const ld = jsonLdFromHtml(html);
  if (ld.some(isProductNode)) return fromJsonLd({ platform: 'jsonld', url: s, data: { jsonld: ld, og: ogFromHtml(html) } }, 'fetch');
  throw new NeedsBrowser(`no product data in ${new URL(s).host}'s page as fetched — capture it in a browser`);
}

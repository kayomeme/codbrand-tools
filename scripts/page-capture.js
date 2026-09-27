// page-capture.js — run this IN THE BROWSER, on a product page that shows the product.
//
// It recognises the page — CJdropshipping, AliExpress, Alibaba, a Shopify store, a WooCommerce store, or any
// page that describes its product with schema.org data — and keeps a copy of the product data the page itself
// loaded, in this site's own browser storage. Run it on each product page of the site, then run
// page-download.js ONCE, in a new tab on the same site: it saves every captured product in one file.
//
// Why keep, then download once: a browser tab gets one automatic download and the next ones are silently
// blocked, so one file per page stops working from the second product on.
//
// If your browser tool shows `{}` or a pending promise instead of a result, the capture still ran: read
// `window.codbrandCaptureResult` a second later.
//
// It never gets past a human check ("Human verification", a slider, a captcha). If one is showing, it stops:
// the PERSON at the browser passes it, then this runs again. Nothing here solves, skips or fakes it.
//
// Returns a short summary with no URLs in it (browser tools often mask URLs in a script's result).

(async () => {
  const STORE = 'codbrand-tools:captures';
  const HUMAN = /human verification|just a moment|attention required|captcha|verify you are human|slide to verify|security check/i;
  if (HUMAN.test(document.title) ||
      document.querySelector('iframe[src*="challenges.cloudflare.com"], iframe[src*="captcha"], #nocaptcha, .baxia-dialog, #baxia-dialog-content')) {
    return { ok: false, reason: 'The site is showing a human check. The person at this browser passes it, then run this script again.' };
  }

  const flat = (x) => (Array.isArray(x) ? x.flatMap(flat) : x && typeof x === 'object' && x['@graph'] ? flat(x['@graph']) : x ? [x] : []);
  const jsonld = () => [...document.querySelectorAll('script[type="application/ld+json"]')]
    .flatMap((s) => { try { return flat(JSON.parse(s.textContent)); } catch { return []; } });
  const isProduct = (o) => [].concat(o?.['@type'] || []).some((t) => /^(Product|ProductGroup)$/i.test(String(t)));
  const og = () => Object.fromEntries([...document.querySelectorAll('meta[property^="og:"], meta[name^="og:"]')]
    .map((m) => [(m.getAttribute('property') || m.getAttribute('name')).slice(3), m.getAttribute('content')]));
  const host = location.host;
  const w = window;
  let cap = null;

  try {
    if (/cjdropshipping\./i.test(host)) {
      const d = w.productDetailData;
      if (!d || !d.id) return { ok: false, reason: 'No product data yet. Open a CJ product page (…-p-<id>.html), wait until the product shows, then run this again.' };
      cap = { platform: 'cjdropshipping', id: String(d.id), data: d };
    } else if (/aliexpress\./i.test(host)) {
      const d = w._d_c_?.lifeCycleEventList?.[0]?.data;
      if (!d || !d.SKU || !d.PRICE) return { ok: false, reason: 'The product has not finished loading. Wait until its price and options show, then run this again.' };
      const pick = {};
      for (const k of ['SKU', 'PRICE', 'PRODUCT_TITLE', 'HEADER_IMAGE_PC', 'PRODUCT_PROP_PC', 'DESC']) pick[k] = d[k];
      // Only the product's own facts from the page's global block. It also carries the visitor's session
      // token, tracking ids and location, which have no business in an import file.
      const g = d.GLOBAL_DATA?.globalData || {};
      pick.GLOBAL = { productId: g.productId, subject: g.subject, categoryId: g.categoryId, categoryPath: g.categoryPath,
        currencyCode: g.currencyCode, storeName: g.storeName };
      let description = null;
      const u = d.DESC?.pcDescUrl || d.DESC?.nativeDescUrl;
      if (u) { try { const r = await fetch(u); if (r.ok) description = await r.text(); } catch { /* the specs still come through */ } }
      const id = pick.GLOBAL.productId || (location.pathname.match(/item\/(\d+)/) || [])[1];
      cap = { platform: 'aliexpress', id: String(id), data: { ...pick, description_html: description } };
    } else if (/alibaba\./i.test(host) && w.detailData?.globalData?.product) {
      const p = w.detailData.globalData.product;
      cap = { platform: 'alibaba', id: String(p.productId), data: { product: p, jsonld: jsonld() } };
    } else if (w.Shopify && /\/products\/[^/]+/.test(location.pathname)) {
      const base = location.pathname.replace(/\/+$/, '');
      const r = await fetch(`${base}.json`, { headers: { Accept: 'application/json' } });
      const j = r.ok ? await r.json() : null;
      if (!j?.product) return { ok: false, reason: 'This Shopify store does not share its product data. Capture stops here; describe the product by hand instead.' };
      cap = { platform: 'shopify', id: String(j.product.id), data: { product: j.product, currency: w.Shopify?.currency?.active || null } };
    } else if (document.querySelector('form.variations_form, body.woocommerce, body.single-product .product')) {
      const f = document.querySelector('form.variations_form');
      let variations = null;
      try { variations = f ? JSON.parse(f.getAttribute('data-product_variations')) : null; } catch { variations = null; }
      const selects = [...document.querySelectorAll('select[name^="attribute_"]')].map((s) => ({
        name: s.getAttribute('name'),
        label: (document.querySelector(`label[for="${s.id}"]`)?.textContent || '').trim(),
        options: [...s.options].filter((o) => o.value).map((o) => ({ value: o.value, text: o.textContent.trim() })),
      }));
      const id = f?.getAttribute('data-product_id') || document.querySelector('[name="add-to-cart"]')?.value || location.pathname;
      const gallery = [...document.querySelectorAll('.woocommerce-product-gallery__image a')].map((a) => a.href);
      cap = { platform: 'woocommerce', id: String(id), data: { variations, selects, gallery, jsonld: jsonld(), og: og() } };
    } else {
      const ld = jsonld();
      if (ld.some(isProduct)) cap = { platform: 'jsonld', id: location.pathname, data: { jsonld: ld, og: og() } };
    }
  } catch (e) {
    return { ok: false, reason: `Could not read this page: ${e.message}` };
  }
  if (!cap) return { ok: false, reason: 'No product data found on this page. Open the product page itself (not a list), wait until it shows, then run this again — or describe the product by hand.' };

  const entry = { kind: 'page-capture/1', platform: cap.platform, id: cap.id, url: location.href, captured_at: new Date().toISOString(), data: cap.data };
  let all = {};
  try { all = JSON.parse(localStorage.getItem(STORE) || '{}'); } catch { all = {}; }
  all[`${cap.platform}:${cap.id}`] = entry;
  const text = JSON.stringify(all);
  try { localStorage.setItem(STORE, text); } catch {
    return { ok: false, reason: 'This site\'s browser storage is full. Run page-download.js now to save what is captured, clear it, then continue.' };
  }
  return { ok: true, platform: cap.platform, captured_on_this_site: Object.keys(all).length, kb: Math.round(text.length / 1024),
    next: 'Open the next product and run this again. When done, open a new tab on this site and run page-download.js there.' };
})().then((r) => { window.codbrandCaptureResult = r; return r; });

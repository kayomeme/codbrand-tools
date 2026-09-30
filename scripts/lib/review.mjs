// review.mjs — the contact sheet, review.html: every photo of every product with what the review decided.
// Written by import-fetch (each photo as fetched) and again by import-photos (each kept photo as it will be
// uploaded, with what was changed), so a person can look before anything reaches the store.

import { MIN_LONG_EDGE } from './plan.mjs';

export const PLATFORM = { cjdropshipping: 'CJdropshipping', aliexpress: 'AliExpress', alibaba: 'Alibaba', shopify: 'Shopify store', woocommerce: 'WooCommerce store', jsonld: 'product page (schema.org)' };
export const ROUTE = { api: 'official API', fetch: 'plain fetch', page: 'browser capture' };
export const kb = (b) => `${Math.round(b / 1024)} KB`;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** The long edge of a photo as the SOURCE offered it (before any shrinking), or null. */
export const sourceLongEdge = (i) => Math.max(i.shrink?.from?.width || 0, i.shrink?.from?.height || 0) || null;

export function reviewHtml(plan, sources) {
  const minEdge = plan.photos?.min_long_edge ?? MIN_LONG_EDGE;
  const cards = plan.products.map((p) => {
    const s = sources[p.key];
    if (!s) return '';
    const imgs = p.images.map((i) => {
      const shown = i.decision === 'keep' && i.final?.file ? i.final.file : i.file;
      const edge = sourceLongEdge(i);
      const small = edge != null && edge < minEdge ? `<br><span class="small">${edge} px — under ${minEdge}</span>` : '';
      const made = i.decision === 'keep' && i.final?.file
        ? `<br><span class="made">uploaded as ${i.final.to.width}×${i.final.to.height} jpeg, ${kb(i.final.to.bytes)}${i.final.changes.length ? ` — ${esc(i.final.changes.join('; '))}` : ''}</span>` : '';
      return `
      <figure class="${esc(i.decision)}${i.final?.edge === 'scene' ? ' scene' : ''}">
        ${shown ? `<img src="${esc(shown)}" loading="lazy" alt="">` : '<div class="missing">not downloaded</div>'}
        <figcaption><b>${esc(i.file || '—')}</b><br>${esc(i.roles.join(' + '))}${i.values?.length ? ` · ${esc(i.values.join(', '))}` : ''}<br>
        ${i.shrink ? `${kb(i.shrink.from.bytes)} ${i.shrink.from.width}×${i.shrink.from.height} → ${kb(i.shrink.to.bytes)} ${i.shrink.to.width}×${i.shrink.to.height} (${esc(i.shrink.engine)})` : esc(i.error || '')}${small}${made}<br>
        <span class="dec">${esc(i.decision)}${i.reason ? ` — ${esc(i.reason)}` : ''}</span></figcaption>
      </figure>`;
    }).join('');
    const specs = s.facts.specs.length ? `<table>${s.facts.specs.map((x) => `<tr><th>${esc(x.name)}</th><td>${esc(x.value)}</td></tr>`).join('')}</table>` : '';
    return `
    <section>
      <h2>${esc(s.facts.title)}</h2>
      <p class="meta">${esc(PLATFORM[s.platform] || s.platform)} · ${esc(s.pid)}${s.product_sku ? ` · SKU ${esc(s.product_sku)}` : ''} · ${esc(ROUTE[s.route] || s.route)}${s.url ? ` · <a href="${esc(s.url)}">source page</a>` : ''}</p>
      ${s.supplier ? '' : '<p class="warn">A retailer\'s own content — use it only if the merchant confirms they may (rights_confirmed).</p>'}
      ${s.facts.moq > 1 ? `<p class="warn">Minimum order on the source: ${esc(s.facts.moq)}.</p>` : ''}
      <p class="meta">${esc(s.facts.category_path.join(' › '))}${s.facts.brand ? ` · brand: ${esc(s.facts.brand)}` : ''}${s.facts.material.length ? ` · material: ${esc(s.facts.material.join(', '))}` : ''}</p>
      <p class="meta">${s.options.map((o) => `${esc(o.name)}: ${esc(o.values.join(', '))}`).join('<br>')}</p>
      <p class="cost">Source ${s.price.kind === 'cost' ? 'cost' : 'price'} ${esc(s.price.min)}${s.price.max != null && s.price.max !== s.price.min ? `–${esc(s.price.max)}` : ''} ${esc(s.price.currency || '')} — reference for pricing, never shown to shoppers</p>
      ${specs ? `<details><summary>Specifications (facts to rewrite)</summary>${specs}</details>` : ''}
      ${s.facts.description_text ? `<details><summary>The source's description (facts to rewrite — never publish as-is)</summary><pre>${esc(s.facts.description_text)}</pre></details>` : ''}
      <div class="grid">${imgs}</div>
    </section>`;
  }).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Product import review</title><style>
body{font:14px/1.45 system-ui,sans-serif;margin:0;padding:16px;background:#f6f6f4;color:#1b1b1b}
section{background:#fff;border-radius:10px;padding:16px;margin:0 0 20px;box-shadow:0 1px 3px #0001}
h2{margin:0 0 6px;font-size:18px}.meta{margin:2px 0;color:#555}.cost{margin:8px 0;color:#8a4b00}.warn{margin:6px 0;color:#b00020;font-weight:600}
pre{white-space:pre-wrap;background:#fafafa;padding:8px;border-radius:6px;max-height:320px;overflow:auto}
table{border-collapse:collapse;margin:6px 0}th,td{text-align:left;padding:2px 10px 2px 0;vertical-align:top}th{color:#555;font-weight:500}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px;margin-top:12px}
figure{margin:0;border:2px solid #ddd;border-radius:8px;overflow:hidden;background:#fff}
figure.keep{border-color:#2e7d32}figure.exclude{border-color:#c62828;opacity:.6}figure.scene{border-style:dashed}
figure img{width:100%;aspect-ratio:1;object-fit:contain;background:#eee;display:block}
figcaption{font-size:12px;padding:6px;word-break:break-all}.dec{font-weight:600}.missing{aspect-ratio:1;display:grid;place-items:center;background:#eee}
.small{color:#b00020;font-weight:600}.made{color:#1b5e20}
</style></head><body><h1>Product import review</h1>
<p>Exclude watermarks, logos or brand marks, recognisable people, and text in another language. Decisions go in plan.json.
A photo in red is under ${minEdge} px on its long edge as the source offers it. Once import-photos.mjs has run, each kept photo
is shown as it will be uploaded; a dashed frame is a scene whose padding shows as a band — look at it.</p>
${cards}</body></html>`;
}

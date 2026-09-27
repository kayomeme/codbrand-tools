// sources/alibaba.mjs — Alibaba.com. The ONE file that knows Alibaba's field names.
//
// Route: the product page, in a browser (page-capture.js copies window.detailData.globalData.product).
// Alibaba is wholesale: prices come in quantity tiers and most products have a minimum order. The cost recorded
// is the tier for the SMALLEST order, in US dollars; the minimum order goes into the facts so it is visible
// before anyone builds a store page for a product that cannot be bought one at a time.

import { buildProduct } from '../product.mjs';

export const isAlibabaUrl = (u) => { try { return /(^|\.)alibaba\.com$/i.test(new URL(u).host); } catch { return false; } };

export function fromAlibabaCapture(c) {
  const P = c?.data?.product;
  if (!P || !P.productId) throw new Error('not an Alibaba product page capture (no product data)');
  const attrs = P.sku?.skuAttrs || [];
  const ladder = (P.price?.productLadderPrices || []).filter((t) => t.dollarPrice != null)
    .sort((a, b) => Number(a.min) - Number(b.min));
  const cost = ladder[0]?.dollarPrice ?? null;

  // skuInfoMap keys are "attrId:valueId;attrId:valueId;" — one per combination on sale.
  const rawVariants = Object.entries(P.sku?.skuInfoMap || {}).map(([key, info]) => {
    const values = [];
    let image = null;
    for (const pair of key.split(';').filter(Boolean)) {
      const [aid, vid] = pair.split(':').map(Number);
      const a = attrs.find((x) => Number(x.id) === aid);
      const v = a?.values?.find((x) => Number(x.id) === vid);
      if (!a || !v) return null;
      values[attrs.indexOf(a)] = String(v.name).trim();
      image = image || v.originImage || v.largeImage || null; // largeImage is a 250 px thumbnail; originImage the photo
    }
    if (attrs.some((_, i) => !values[i])) return null;
    return { vid: String(info?.id ?? key), sku: `AB-${P.productId}-${info?.id ?? ''}`, values, price: cost, image };
  }).filter(Boolean);

  const specs = [...(P.productKeyIndustryProperties || []), ...(P.productBasicProperties || []), ...(P.productOtherProperties || [])]
    .map((p) => ({ name: p.attrName, value: p.attrValue }));
  const images = (P.mediaItems || []).filter((m) => m.type === 'image').map((m) => m.imageUrl?.big || m.imageUrl?.normal).filter(Boolean);
  return buildProduct({
    platform: 'alibaba',
    route: 'page',
    pid: P.productId,
    productSku: `AB-${P.productId}`,
    url: c.url ? String(c.url).split('?')[0] : null,
    title: P.subject,
    descriptionHtml: '',
    specs,
    material: specs.filter((s) => /^material$/i.test(s.name)).map((s) => s.value),
    brand: specs.find((s) => /^brand/i.test(s.name))?.value,
    moq: P.moq,
    optionNames: attrs.map((a) => String(a.name).trim()),
    currency: 'USD',
    priceKind: 'cost',
    price: { min: cost, max: cost },
    mainImage: images[0],
    gallery: images,
    rawVariants,
  });
}

// cj-api.mjs — route 1: CJdropshipping's official API, with the merchant's ACCESS TOKEN.
//
// The token comes from the environment (CJ_ACCESS_TOKEN) for this run only. This file never writes it,
// never prints it, never puts it in a URL, and never asks for the CJ API key it was made from.
//
// Docs: https://developers.cjdropshipping.com (API 2.0). A call succeeds when HTTP is 200 AND `code` is 200
// or absent — CJ says not to trust `message` for that.

const BASE = 'https://developers.cjdropshipping.com/api2.0/v1';

// CJ's error codes, in words a merchant can act on.
const CODES = {
  1600001: 'CJ refused the access token (invalid or expired). Get a new access token and run again.',
  1600002: 'No CJ access token was sent. Set CJ_ACCESS_TOKEN and run again.',
  1600200: 'CJ says: too many requests. Wait a minute and run again.',
  1600201: 'CJ says: this account\'s request quota is used up.',
  16900500: 'CJ says: this account is out of API points for today (they reset at 00:00 UTC).',
  1600300: 'CJ refused a parameter — check the product id.',
  1602000: 'CJ has no such variant.',
  1602001: 'CJ has no product with this id.',
  1602002: 'CJ has taken this product off sale.',
  1602003: 'CJ has taken this variant off sale.',
};

export class CjError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

export function cjClient(token = process.env.CJ_ACCESS_TOKEN) {
  if (!token) throw new CjError('CJ_ACCESS_TOKEN is not set. The official-API route needs your CJ access token.', 1600002);
  let gapMs = 1100; // 1 request per second until the account's own limit is known
  let last = 0;

  async function call(path, params = {}) {
    const wait = last + gapMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    last = Date.now();
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== '')).toString();
    let r;
    try {
      r = await fetch(`${BASE}${path}${qs ? `?${qs}` : ''}`, {
        headers: { 'CJ-Access-Token': token, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(30000),
      });
    } catch (e) { throw new CjError(`could not reach CJ's API: ${e.message}`); }
    if (r.status === 429) throw new CjError(CODES[1600200], 1600200);
    let body;
    try { body = await r.json(); } catch { throw new CjError(`CJ answered HTTP ${r.status} with no JSON`); }
    const ok = r.status === 200 && (body.code === undefined || body.code === 200);
    if (!ok) throw new CjError(CODES[body.code] || `CJ error ${body.code ?? r.status}: ${body.message ?? 'no message'}`, body.code);
    return body.data;
  }

  return {
    /** Read the account's own speed limit once, then pace every call to it. */
    async init() {
      try {
        const s = await call('/setting/get');
        const qps = Number(findKey(s, 'qpsLimit'));
        if (qps > 0) gapMs = Math.ceil(1000 / qps) + 50;
      } catch (e) {
        if (e.code === 1600001 || e.code === 1600002) throw e; // a bad token is fatal; anything else is not
      }
    },
    /** One product with its variants. `id` is a CJ product id, or a CJ SKU (they start with "CJ"). */
    async product(id) {
      const byPid = !/^CJ/i.test(id);
      return call('/product/query', byPid ? { pid: id } : { productSku: id });
    },
  };
}

function findKey(o, key) {
  if (!o || typeof o !== 'object') return undefined;
  if (key in o) return o[key];
  for (const v of Object.values(o)) {
    const hit = findKey(v, key);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

// clapi.mjs — a small client for the store's own API (COD Leads `cl-api/v1`).
//
// It carries only what the API cannot tell you about calling it safely:
//   - pacing: at most 4 requests a second. Shared-hosting CDNs answer a burst with a bare 403 page, and a
//     per-minute key limit does not prevent a burst.
//   - 429: wait `Retry-After` (or `retry_after` in the body), then retry — never sooner.
//   - a 403 with no API error body is the HOST refusing, not the store: said in those words.
//   - writes can carry an Idempotency-Key, so a retried create never creates twice.
// What each door ACCEPTS is not here: the store describes itself (GET /me, /openapi, /docs/{slug}).

export class ApiError extends Error {
  constructor(message, { status, code, body } = {}) { super(message); this.status = status; this.code = code; this.body = body; }
}

export function clapi(site, key, { gapMs = 250, userAgent = 'codbrand-tools (product import)' } = {}) {
  if (!site || !key) throw new ApiError('the store URL and its API key are both required');
  const base = String(site).replace(/\/+$/, '').replace(/\/wp-json.*$/, '') + '/wp-json/cl-api/v1';
  let last = 0;

  async function request(method, path, { query, body, idempotencyKey, attempt = 0 } = {}) {
    const wait = last + gapMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    last = Date.now();
    const qs = query ? '?' + new URLSearchParams(Object.entries(query).filter(([, v]) => v != null)).toString() : '';
    const headers = { Authorization: `Bearer ${key}`, Accept: 'application/json', 'User-Agent': userAgent };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    let r;
    try {
      r = await fetch(`${base}/${String(path).replace(/^\/+/, '')}${qs}`, { method, headers, body: payload, signal: AbortSignal.timeout(90000) });
    } catch (e) {
      if (attempt < 2) { await sleep(2000 * (attempt + 1)); return request(method, path, { query, body, idempotencyKey, attempt: attempt + 1 }); }
      throw new ApiError(`${method} ${path}: the store did not answer (${e.message})`);
    }
    const text = await r.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }

    if (r.status === 429 && attempt < 4) {
      const after = Number(r.headers.get('retry-after')) || Number(json?.data?.retry_after ?? json?.retry_after) || 30;
      await sleep(Math.min(after, 300) * 1000);
      return request(method, path, { query, body, idempotencyKey, attempt: attempt + 1 });
    }
    if (r.status === 409 && idempotencyKey && /idempot|in flight|in progress/i.test(text) && attempt < 4) {
      await sleep(3000); // the first attempt with this key is still running
      return request(method, path, { query, body, idempotencyKey, attempt: attempt + 1 });
    }
    if (r.status >= 500 && attempt < 1) { await sleep(3000); return request(method, path, { query, body, idempotencyKey, attempt: attempt + 1 }); }

    if (!r.ok) {
      if (!json) {
        const big = payload && payload.length > 600 * 1024;
        throw new ApiError(`${method} ${path}: HTTP ${r.status} from the HOST, before the store saw the request (no API error body)` +
          (r.status === 403 ? (big ? ` — the request was ${Math.round(payload.length / 1024)} KB; hosts commonly refuse bodies this large` : ' — the host or its CDN refused it (too many requests, or a firewall rule); wait, then run again') : ''),
        { status: r.status });
      }
      const msg = json.message || text.slice(0, 300); // the store's errors are {code, message, data:{status}}
      throw new ApiError(`${method} ${path}: ${r.status} ${json.code ? `${json.code} — ` : ''}${msg}`, { status: r.status, code: json.code, body: json });
    }
    return { status: r.status, data: json, headers: r.headers };
  }

  return {
    base,
    get: (path, query) => request('GET', path, { query }).then((r) => r.data),
    post: (path, body, idempotencyKey) => request('POST', path, { body, idempotencyKey }).then((r) => r.data),
    patch: (path, body, idempotencyKey) => request('PATCH', path, { body, idempotencyKey }).then((r) => r.data),
    put: (path, body, idempotencyKey) => request('PUT', path, { body, idempotencyKey }).then((r) => r.data),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

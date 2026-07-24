/**
 * AlayneFIT — Cloudflare Worker (state store)
 *
 * Persists Alayne's goals + completion state in Cloudflare KV so her data
 * follows her across devices (phone, tablet, laptop) instead of living in a
 * single browser. There is intentionally NO password on this endpoint — the
 * data is low-sensitivity (personal wellness goals) and simplicity was chosen
 * over a PIN. If you ever want to lock it down later, add a shared secret
 * check here and send it from the app.
 *
 * ── One-time setup ─────────────────────────────────────────────────────────
 *   1. Cloudflare dashboard → Workers & Pages → KV → Create a namespace,
 *      e.g. "alaynefit".
 *   2. Open this Worker → Settings → Variables → KV Namespace Bindings →
 *      Add binding:  Variable name = ALAYNEFIT_KV,  KV namespace = alaynefit.
 *   3. Paste this file into the Worker and Deploy.
 *   4. Copy the Worker URL (e.g. https://alaynefit.YOUR-NAME.workers.dev) into
 *      API_URL in tools/alaynefit/index.html.
 *
 * Routes:
 *   GET   → returns the stored JSON state (or the literal `null` if none yet)
 *   PUT   → stores the JSON body as the new state
 *   OPTIONS → CORS preflight
 */

const ALLOWED_ORIGIN = 'https://www.blakestringer.com';
const KEY = 'alayne';           // single-user app → one fixed record
const MAX_BYTES = 200000;       // generous cap; real state is a few KB

const CORS = {
  'Access-Control-Allow-Origin':  ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    if (!env.ALAYNEFIT_KV) {
      return json({ error: 'KV namespace not bound. Bind ALAYNEFIT_KV in Worker settings.' }, 500);
    }

    /* ── Read current state ── */
    if (request.method === 'GET') {
      const data = await env.ALAYNEFIT_KV.get(KEY);
      return new Response(data || 'null', {
        headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
    }

    /* ── Save state ── */
    if (request.method === 'PUT' || request.method === 'POST') {
      const body = await request.text();
      if (body.length > MAX_BYTES) return json({ error: 'State too large.' }, 413);
      try { JSON.parse(body); } catch { return json({ error: 'Body is not valid JSON.' }, 400); }
      await env.ALAYNEFIT_KV.put(KEY, body);
      return json({ ok: true }, 200);
    }

    return new Response('Method not allowed', { status: 405, headers: CORS });
  },
};

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

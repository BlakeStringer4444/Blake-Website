/**
 * ASAK To-do — Cloudflare Worker (state store)
 *
 * Backs the secret to-do list on /tools/asimpleactofkindness/ so it follows
 * Blake across devices instead of living in one browser's localStorage.
 *
 * ── Why this one has a token and alaynefit-worker.js doesn't ───────────────
 * AlayneFIT's worker is deliberately open: low-sensitivity wellness goals on a
 * page nobody else visits. This is different — the page it serves is public,
 * so the Worker URL is in the page source for anyone to read. Without a check,
 * anyone who viewed source could read the list or wipe it with a single PUT.
 *
 * So every request must carry the shared token in an X-Todo-Key header. The
 * token is NOT in the page source: the app asks for it once per device and
 * keeps it in localStorage. Viewing source therefore reveals the endpoint but
 * not the contents.
 *
 * Note the CORS origin allowlist below is not the protection — CORS is
 * enforced by browsers only, and curl ignores it. The token is the protection.
 *
 * ── One-time setup ─────────────────────────────────────────────────────────
 *   1. Cloudflare dashboard → Storage & Databases → KV → Create a namespace,
 *      e.g. "asak-todo".
 *   2. Workers & Pages → Create → Worker. Name it e.g. "asak-todo".
 *      Paste this file in as the Worker code and Deploy.
 *   3. That Worker → Settings → Bindings → Add → KV namespace:
 *        Variable name = ASAK_TODO_KV    KV namespace = asak-todo
 *   4. Same Settings page → Variables and Secrets → Add → type Secret:
 *        Name = TODO_TOKEN    Value = a long random string you invent
 *      (Treat it like a password. It is what stops strangers reading the list.)
 *   5. Deploy again so the bindings take effect, then copy the Worker URL
 *      (e.g. https://asak-todo.YOUR-NAME.workers.dev) into TODO_API in
 *      tools/asimpleactofkindness/index.html.
 *   6. Open the page, unlock the list, and paste the same TODO_TOKEN value
 *      when it asks. That is stored on the device, not in the page.
 *
 * Routes:
 *   GET     → the stored JSON array of items (or [] if nothing saved yet)
 *   PUT     → replaces the stored array with the JSON body
 *   OPTIONS → CORS preflight
 *   Anything without a valid X-Todo-Key → 401
 */

const ALLOWED_ORIGINS = [
  'https://www.blakestringer.com',
  'https://blakestringer.com',
];
const KEY = 'todo';             // single-user app → one fixed record
const MAX_BYTES = 200000;       // generous cap; a to-do list is a few KB

function corsFor(request) {
  const origin = request.headers.get('Origin') || '';
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Todo-Key',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

/* Compares in constant time, so a timing difference can't be used to guess the
   token a character at a time. */
function tokenOk(supplied, expected) {
  if (!expected) return false;
  const a = new TextEncoder().encode(String(supplied || ''));
  const b = new TextEncoder().encode(expected);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export default {
  async fetch(request, env) {
    const CORS = corsFor(request);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    if (!env.ASAK_TODO_KV) {
      return json({ error: 'KV namespace not bound. Bind ASAK_TODO_KV in Worker settings.' }, 500, CORS);
    }
    if (!env.TODO_TOKEN) {
      return json({ error: 'TODO_TOKEN secret not set in Worker settings.' }, 500, CORS);
    }
    if (!tokenOk(request.headers.get('X-Todo-Key'), env.TODO_TOKEN)) {
      return json({ error: 'Bad or missing key.' }, 401, CORS);
    }

    /* ── Read the list ── */
    if (request.method === 'GET') {
      const data = await env.ASAK_TODO_KV.get(KEY);
      return new Response(data || '[]', {
        headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
    }

    /* ── Replace the list ── */
    if (request.method === 'PUT' || request.method === 'POST') {
      const body = await request.text();
      if (body.length > MAX_BYTES) return json({ error: 'List too large.' }, 413, CORS);
      let parsed;
      try { parsed = JSON.parse(body); } catch { return json({ error: 'Body is not valid JSON.' }, 400, CORS); }
      if (!Array.isArray(parsed)) return json({ error: 'Body must be a JSON array.' }, 400, CORS);
      await env.ASAK_TODO_KV.put(KEY, body);
      return json({ ok: true }, 200, CORS);
    }

    return new Response('Method not allowed', { status: 405, headers: CORS });
  },
};

function json(obj, status, CORS) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

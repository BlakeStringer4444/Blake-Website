/**
 * Scenes From the Climate Era — To-do (Cloudflare Worker, state store)
 *
 * Backs the secret to-do list on /tools/scenesfromtheclimateera/ so it follows
 * Blake across devices instead of living in one browser's localStorage.
 *
 * This is deliberately a separate Worker and a separate KV namespace from
 * asak-todo-worker.js. The two productions are unrelated, and one Worker
 * holding both lists would mean one accidental overwrite could take out the
 * wrong show's notes. Nothing is shared between them, including the stored
 * key names — each lives in its own namespace.
 *
 * There is intentionally NO key on this endpoint, the same choice the other
 * two Workers make. It is worth being clear what that means: the page this
 * serves is public, so the Worker URL is in its source, and anyone who reads
 * it can fetch the list or overwrite it. The contents are production to-dos
 * rather than anything sensitive, and simplicity was preferred over a key to
 * paste on every device. If that ever stops being the right trade, add a
 * shared-secret header check here and send it from the app.
 *
 * The CORS allowlist below is worth having but is not a lock: browsers enforce
 * it, so it stops another *website* reading the list with JavaScript, and does
 * nothing at all about curl.
 *
 * Each PUT copies the outgoing value to a second key before overwriting, so a
 * list wiped by accident — a stray request, or a mis-click — can be read back
 * from the KV browser in the Cloudflare dashboard.
 *
 * ── One-time setup ─────────────────────────────────────────────────────────
 *   1. Cloudflare dashboard → Storage & Databases → KV → Create a namespace,
 *      named "sftce-todo".
 *   2. Workers & Pages → Create → Worker. Name it "sftce-todo".
 *      Paste this file in as the Worker code and Deploy.
 *   3. That Worker → Settings → Bindings → Add → KV namespace:
 *        Variable name = SFTCE_TODO_KV    KV namespace = sftce-todo
 *   4. Deploy again so the binding takes effect, then check the Worker URL
 *      matches TODO_API in tools/scenesfromtheclimateera/index.html, which
 *      expects https://sftce-todo.blakestringer.workers.dev
 *
 * Routes:
 *   GET     → the stored JSON array of items (or [] if nothing saved yet)
 *   PUT     → replaces the stored array with the JSON body
 *   OPTIONS → CORS preflight
 */

const ALLOWED_ORIGINS = [
  'https://www.blakestringer.com',
  'https://blakestringer.com',
];
const KEY      = 'todo';        // single-user app → one fixed record
const PREV_KEY = 'todo-prev';   // the value replaced by the most recent PUT
const MAX_BYTES = 200000;       // generous cap; a to-do list is a few KB

function corsFor(request) {
  const origin = request.headers.get('Origin') || '';
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

export default {
  async fetch(request, env) {
    const CORS = corsFor(request);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    if (!env.SFTCE_TODO_KV) {
      return json({ error: 'KV namespace not bound. Bind SFTCE_TODO_KV in Worker settings.' }, 500, CORS);
    }

    /* ── Read the list ── */
    if (request.method === 'GET') {
      const data = await env.SFTCE_TODO_KV.get(KEY);
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

      /* Keep the version we're about to lose. Only when there is something to
         keep and it actually differs, so a run of identical saves can't push
         the real previous list out of reach. */
      const current = await env.SFTCE_TODO_KV.get(KEY);
      if (current && current !== body) await env.SFTCE_TODO_KV.put(PREV_KEY, current);

      await env.SFTCE_TODO_KV.put(KEY, body);
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

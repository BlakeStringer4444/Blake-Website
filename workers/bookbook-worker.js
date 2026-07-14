/**
 * BookBook — Cloudflare Worker
 *
 * Permanent storage for Alayne's reading tracker (read / rating / note per book).
 * No AI, no secrets — just a Workers KV namespace. Origin-locked like the other
 * private tools so the data can't be read/written by a random script.
 *
 * Modes (body.mode):
 *   "get"  — {}
 *            → { books: { "<No.>": { read, rating, note } , … } }
 *   "save" — { id:"<No.>", state:{ read:bool, rating:0-5, note:"…" } | null }
 *            Pass state:null (or an empty state) to clear a book.
 *            → { ok:true }
 *
 * KV namespace required:
 *   BOOKBOOK — a Workers KV namespace bound to this Worker. Without it, "get"
 *              returns empty and "save" reports no-namespace.
 *
 * Deploy steps (done once):
 *   1. workers.cloudflare.com → Create Worker → paste this file
 *   2. Storage & Databases → KV → Create a namespace (e.g. "bookbook")
 *   3. Worker → Settings → Bindings → Add → KV namespace:
 *        Variable name: BOOKBOOK   →   the namespace from step 2
 *   4. Copy the worker URL (e.g. https://bookbook.YOUR-NAME.workers.dev)
 *   5. Paste that URL into BB_WORKER_URL in tools/bookbook/index.html
 */

const ALLOWED_ORIGINS = [
  'https://www.blakestringer.com',
  'https://blakestringer.com',
];
const KEY = 'bookbook:v1';
const MAX_BODY_BYTES = 64 * 1024;

export default {
  async fetch(request, env) {
    const origin  = request.headers.get('Origin') || '';
    const allowed = ALLOWED_ORIGINS.includes(origin);
    const acao    = allowed ? origin : ALLOWED_ORIGINS[0];

    let resp;
    if (request.method === 'OPTIONS') {
      resp = new Response(null, { status: 204 });
    } else if (request.method !== 'POST') {
      resp = json({ error: 'Method not allowed' }, 405);
    } else if (!allowed) {
      resp = json({ error: 'Forbidden' }, 403);
    } else {
      const clen = parseInt(request.headers.get('content-length') || '0', 10);
      if (clen && clen > MAX_BODY_BYTES) {
        resp = json({ error: 'Payload too large' }, 413);
      } else {
        let body = null;
        try { body = await request.json(); }
        catch { resp = json({ error: 'Invalid JSON' }, 400); }
        if (body) {
          try {
            if (body.mode === 'get')       resp = await handleGet(env);
            else if (body.mode === 'save') resp = await handleSave(body, env);
            else resp = json({ error: 'Unknown mode: ' + body.mode }, 400);
          } catch (e) {
            resp = json({ error: e.message || String(e) }, 502);
          }
        }
      }
    }

    const out = new Response(resp.body, resp);
    out.headers.set('Access-Control-Allow-Origin',  acao);
    out.headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    out.headers.set('Access-Control-Allow-Headers', 'Content-Type');
    out.headers.set('Vary', 'Origin');
    return out;
  },
};

async function handleGet(env) {
  if (!env.BOOKBOOK) return json({ books: {} });
  return json({ books: parseObj(await env.BOOKBOOK.get(KEY)) });
}

async function handleSave(body, env) {
  if (!env.BOOKBOOK) return json({ error: 'no-namespace' }, 503);
  const id = String(body.id == null ? '' : body.id).slice(0, 16);
  if (!id) return json({ error: 'Missing id' }, 400);

  const data = parseObj(await env.BOOKBOOK.get(KEY));
  const state = sanitize(body.score || body.state);

  if (!state || (!state.read && !state.rating && !state.note)) {
    delete data[id];                       /* empty → drop, keeps the store tidy */
  } else {
    data[id] = state;
  }
  await env.BOOKBOOK.put(KEY, JSON.stringify(data));
  return json({ ok: true, id: id });
}

function sanitize(s) {
  if (!s || typeof s !== 'object') return null;
  let rating = Math.round(Number(s.rating));
  if (!Number.isFinite(rating)) rating = 0;
  rating = Math.max(0, Math.min(5, rating));
  return {
    read:   !!s.read,
    rating: rating,
    note:   typeof s.note === 'string' ? s.note.slice(0, 600) : '',
    updatedAt: new Date().toISOString(),
  };
}

function parseObj(raw) {
  if (!raw) return {};
  try { const o = JSON.parse(raw); return (o && typeof o === 'object') ? o : {}; }
  catch { return {}; }
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

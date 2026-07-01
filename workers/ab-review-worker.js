/**
 * AB Theatre Review — Cloudflare Worker
 *
 * Permanent storage for Alayne & Blake's play scores. No AI, no secrets —
 * just a Workers KV namespace. Mirrors the origin-locking pattern of
 * play-analysis-worker.js so the scores API can't be read/written by a random
 * script hitting the Worker URL directly.
 *
 * Two request modes (body.mode):
 *   "get"  — {}
 *            → { reviews: { alayne:{ "<id>":<score> }, blake:{ … } } }
 *   "save" — { reviewer:"alayne"|"blake", id:"<play id>", score:{…}|null }
 *            score = { story, acting, sound, lighting, set, costume, note }
 *            (story/acting 0-10, the rest 0-5). Pass score:null to clear.
 *            → { ok:true }
 *
 * KV namespace required:
 *   AB_REVIEWS — a Workers KV namespace bound to this Worker. Without it,
 *                "get" returns empty and "save" reports no-namespace.
 *
 * Deploy steps (done once):
 *   1. workers.cloudflare.com → Create Worker → paste this file
 *   2. Storage & Databases → KV → Create a namespace (e.g. "ab-reviews")
 *   3. Worker → Settings → Bindings → Add → KV namespace:
 *        Variable name: AB_REVIEWS   →   the namespace from step 2
 *   4. Copy the worker URL (e.g. https://ab-theatre-review.YOUR-NAME.workers.dev)
 *   5. Paste that URL into AB_WORKER_URL in tools/ab-theatre-review/index.html
 */

const ALLOWED_ORIGINS = [
  'https://www.blakestringer.com',
  'https://blakestringer.com',
];
const REVIEWERS = ['alayne', 'blake'];
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
  if (!env.AB_REVIEWS) return json({ reviews: { alayne: {}, blake: {} } });
  const [a, b] = await Promise.all([
    env.AB_REVIEWS.get('reviews:alayne'),
    env.AB_REVIEWS.get('reviews:blake'),
  ]);
  return json({ reviews: { alayne: parseObj(a), blake: parseObj(b) } });
}

async function handleSave(body, env) {
  const reviewer = REVIEWERS.indexOf(body.reviewer) >= 0 ? body.reviewer : null;
  if (!reviewer) return json({ error: 'Unknown reviewer' }, 400);
  if (!env.AB_REVIEWS) return json({ error: 'no-namespace' }, 503);

  const id = String(body.id == null ? '' : body.id).slice(0, 64);
  if (!id) return json({ error: 'Missing id' }, 400);

  const key = 'reviews:' + reviewer;
  const cur = parseObj(await env.AB_REVIEWS.get(key));

  if (body.score === null) {
    delete cur[id];                 /* explicit un-score */
  } else {
    const score = sanitize(body.score);
    if (!score) return json({ error: 'Bad score' }, 400);
    cur[id] = score;
  }

  await env.AB_REVIEWS.put(key, JSON.stringify(cur));
  return json({ ok: true, id: id });
}

/* Clamp every field server-side so a bad client can't store garbage. */
function sanitize(s) {
  if (!s || typeof s !== 'object') return null;
  const clamp = (v, max) => {
    v = Math.round(Number(v));
    if (!Number.isFinite(v)) v = 0;
    return Math.max(0, Math.min(max, v));
  };
  return {
    story:    clamp(s.story, 10),
    acting:   clamp(s.acting, 10),
    sound:    clamp(s.sound, 5),
    lighting: clamp(s.lighting, 5),
    set:      clamp(s.set, 5),
    costume:  clamp(s.costume, 5),
    note:     typeof s.note === 'string' ? s.note.slice(0, 600) : '',
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

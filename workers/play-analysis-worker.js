/**
 * Play Analysis — Cloudflare Worker
 *
 * Powers the smart (AI) version of the Play Analysis tool.
 * Proxies requests to the Anthropic (Claude) API. The API key never leaves
 * this worker — it is stored as a Cloudflare secret, exactly like blakeai-worker.js.
 *
 * Three request modes (selected by `body.mode`):
 *
 *   1. "ocr"        — { mode:"ocr", images:[ "data:image/png;base64,…", … ] }
 *                     Claude vision transcribes scanned/image pages verbatim.
 *                     → { text: "<transcription>" }
 *
 *   2. "structure"  — { mode:"structure", lines:[ "line", … ], offset:<int> }
 *                     Claude segments numbered script lines into scenes + speeches,
 *                     returning line-index ranges (so the client keeps verbatim text).
 *                     → { text: "<JSON>" }
 *
 *   3. "normalize"  — { mode:"normalize", labels:[ "VIOLET", "Vi", … ] }
 *                     Claude merges speaker-label variants into canonical characters.
 *                     → { text: "<JSON>" }
 *
 *   4. "overview"   — { mode:"overview", text:"<full script>", scenes:[…], title:"…" }
 *                     Fast first half of the summary: synopsis, character profiles
 *                     (name, approx age, personality), themes, and the LIST of scene
 *                     divisions (labels only).
 *                     → { text: "<JSON: synopsis, profiles[], themes[], sceneList[]>" }
 *
 *   4b. "scenebatch" — { mode:"scenebatch", text:"<full script>", title:"…", sceneLabels:[…] }
 *                     Summarises ONLY the requested slice of scenes. Bounded output, so
 *                     long/many-scene plays can't truncate or time out.
 *                     → { text: "<JSON: scenes[]>" }
 *
 *   4c. "summary"   — legacy single-shot summary; kept as a fallback.
 *                     → { text: "<JSON: synopsis, profiles[], scenes[], themes[]>" }
 *
 *   5. "library-check" — { mode:"library-check", fileHash?:"…", fingerprint?:"…" }
 *                     Looks the play up in the shared, PRIVATE library (Cloudflare KV).
 *                     This is a cache, never a public list: it only ever returns a
 *                     previously-computed analysis to someone who has just uploaded a
 *                     matching script themselves. Prevents the same play being scanned
 *                     (and paid for) twice across all users.
 *                     → { hit:<bool>, script?:<analysis JSON> }
 *
 *   6. "library-save"  — { mode:"library-save", fileHash?:"…", fingerprint?:"…", script:{…} }
 *                     Stores a freshly-computed analysis in the library under both keys.
 *                     → { ok:<bool> }
 *
 * Secrets required:
 *   ANTHROPIC_API_KEY  — from console.anthropic.com
 *
 * KV namespace required (for the shared library — modes 5 & 6 — AND the daily
 * spend cap below):
 *   PLAY_LIBRARY  — a Workers KV namespace bound to this Worker.
 *                   If it is NOT bound, the library modes degrade gracefully
 *                   (every check is a miss, every save is a no-op) and the daily
 *                   cap simply doesn't meter — the tool still works.
 *
 * Abuse protection (see ALLOWED_ORIGINS + the limit consts below):
 *   - Server-side origin check: only requests from the site are served (a bare
 *     curl/script with no matching Origin gets 403). CORS headers alone do NOT
 *     do this — they're browser-only.
 *   - DAILY_BUDGET_CENTS: a hard, all-users daily ceiling on estimated spend;
 *     once crossed the Worker returns 429 until UTC midnight.
 *   - MAX_OCR_IMAGES / MAX_BODY_BYTES: reject oversized / crammed requests.
 *   These complement (not replace) your Anthropic monthly spend limit, which is
 *   the precise backstop. For burst protection add a per-IP rate limit (see #3).
 *
 * Deploy steps (done once):
 *   1. workers.cloudflare.com → Create Worker → paste this file
 *   2. Settings → Variables and Secrets → Add secret: ANTHROPIC_API_KEY = <your key>
 *   3. Storage & Databases → KV → Create a namespace (e.g. "play-library")
 *   4. Worker → Settings → Bindings → Add → KV namespace:
 *        Variable name: PLAY_LIBRARY   →   the namespace from step 3
 *   5. Copy the worker URL (e.g. https://play-analysis.YOUR-NAME.workers.dev)
 *   6. Paste that URL into PA_WORKER_URL in tools/play-analysis/index.html
 *
 * Model note: MODEL is set to Sonnet for the best accuracy/cost balance. To
 * maximise accuracy, switch MODEL to 'claude-opus-4-8'.
 */

/* Browser origins allowed to use this endpoint (www + apex). */
const ALLOWED_ORIGINS = [
  'https://www.blakestringer.com',
  'https://blakestringer.com',
];
const MODEL = 'claude-sonnet-4-6';

/* ── Abuse limits (tune these freely) ──────────────────────────────────────
   DAILY_BUDGET_CENTS — a HARD daily ceiling on estimated Anthropic spend across
     ALL users combined. Once the day's estimate crosses it, the Worker stops
     calling Claude and returns a friendly 429 until UTC midnight. This bounds
     your worst-case daily cost even with auto top-up on. The estimate is rough
     (deliberately on the high side); your Anthropic monthly spend limit is the
     precise backstop.
   MAX_OCR_IMAGES — images accepted in a single OCR request (the client only
     ever sends 3, so this only blocks someone cramming a request).
   MAX_BODY_BYTES — reject oversized request bodies outright.                   */
const DAILY_BUDGET_CENTS = 1000;            /* ≈ US$10/day. Change to taste. */
const MAX_OCR_IMAGES     = 150;
const MAX_BODY_BYTES     = 25 * 1024 * 1024;

/* Content-advisory taxonomy — shared by the overview + scenebatch prompts. The
   client maps these exact keys to display labels/icons, so keep them in sync. */
const ADVISORY_CATS =
  'Allowed keys: intimacy (kissing, simulated sex, nudity, sexual references), ' +
  'sexual-violence (rape, sexual assault or coercion), suicide (suicide, suicidal ideation, self-harm), ' +
  'violence (physical violence, murder, gore), death (death, dying, grief, terminal illness), ' +
  'substance (drug or alcohol abuse, addiction), abuse (domestic, child or sustained emotional abuse), ' +
  'mental-illness (depression, breakdown, serious mental illness), language (frequent coarse language, ' +
  'profanity, slurs), discrimination (racism, homophobia or other hate).';

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
      /* #4 — only our own site may call this endpoint. CORS headers alone don't
         stop a direct curl/script; this server-side check does. */
      resp = json({ error: 'Forbidden' }, 403);
    } else {
      const clen = parseInt(request.headers.get('content-length') || '0', 10);
      if (clen && clen > MAX_BODY_BYTES) {
        resp = json({ error: 'Payload too large' }, 413);          /* #5 */
      } else {
        let body = null;
        try { body = await request.json(); }
        catch { resp = json({ error: 'Invalid JSON' }, 400); }
        if (body) {
          try {
            resp = await route(body, env);
          } catch (e) {
            if (e && e.message === 'DAILY_LIMIT') {
              resp = json({ error: 'daily-limit',
                message: 'This tool has reached its daily limit. Please try again tomorrow.' }, 429);
            } else {
              resp = json({ error: e.message || String(e) }, 502);
            }
          }
        }
      }
    }

    /* Central CORS — reflect the allow-listed origin onto every response. */
    const out = new Response(resp.body, resp);
    out.headers.set('Access-Control-Allow-Origin',  acao);
    out.headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    out.headers.set('Access-Control-Allow-Headers', 'Content-Type');
    out.headers.set('Vary', 'Origin');
    return out;
  },
};

async function route(body, env) {
  const mode = body.mode;
  if (mode === 'ocr')           return await handleOcr(body, env);
  if (mode === 'structure')     return await handleStructure(body, env);
  if (mode === 'normalize')     return await handleNormalize(body, env);
  if (mode === 'overview')      return await handleOverview(body, env);
  if (mode === 'scenebatch')    return await handleSceneBatch(body, env);
  if (mode === 'summary')       return await handleSummary(body, env);
  if (mode === 'library-check') return await handleLibraryCheck(body, env);
  if (mode === 'library-save')  return await handleLibrarySave(body, env);
  return json({ error: 'Unknown mode: ' + mode }, 400);
}

/* ───────────────────────── MODE: OCR ───────────────────────── */
async function handleOcr(body, env) {
  const images = Array.isArray(body.images) ? body.images : [];
  if (!images.length) return json({ error: 'No images provided' }, 400);
  if (images.length > MAX_OCR_IMAGES) return json({ error: 'Too many images in one request' }, 400);  /* #5 */

  const content = [];
  for (const img of images) {
    const m = /^data:(image\/[a-z+]+);base64,(.*)$/i.exec(img);
    const mediaType = m ? m[1] : 'image/png';
    const data      = m ? m[2] : img;
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: mediaType, data },
    });
  }
  content.push({
    type: 'text',
    text: 'Transcribe these script page image(s) now. Output ONLY the raw transcribed text.',
  });

  const system =
    'You are a precise OCR transcription engine for theatre and film scripts. ' +
    'You receive one or more page images. Transcribe ALL text VERBATIM, preserving the ' +
    'original line breaks and the original capitalisation of character-name cue lines. ' +
    'Keep stage directions, scene/act headings and dialogue. Do NOT summarise, correct, ' +
    'translate, reorder or add any commentary. If a word is illegible, transcribe your best ' +
    'guess. Output ONLY the raw transcribed text. Separate consecutive pages with one blank line.';

  const text = await callClaude(env, { system, max_tokens: 8192, content, costCents: 1.5 * images.length });
  return json({ text });
}

/* ─────────────────────── MODE: STRUCTURE ───────────────────── */
async function handleStructure(body, env) {
  const lines  = Array.isArray(body.lines) ? body.lines : [];
  const offset = Number.isInteger(body.offset) ? body.offset : 0;
  if (!lines.length) return json({ error: 'No lines provided' }, 400);

  /* Number every line with its ABSOLUTE script index so Claude returns absolute indices. */
  const numbered = lines
    .map((l, i) => (offset + i) + '\t' + String(l == null ? '' : l))
    .join('\n');

  const system =
    'You are a script-structure parser. You receive numbered lines from a stage play or ' +
    'screenplay, one per line, in the format "INDEX<TAB>TEXT". Identify two things:\n' +
    '(1) scene/act headings, and (2) speeches (a block of dialogue attributed to one speaker).\n\n' +
    'Return ONLY valid JSON, no markdown, in exactly this shape:\n' +
    '{"scenes":[{"line":<int>,"heading":"<text>"}],' +
    '"speeches":[{"speaker":"<NAME exactly as printed>","start":<int>,"end":<int>}]}\n\n' +
    'Rules:\n' +
    '- Indices are the exact INDEX numbers shown in the input.\n' +
    '- For a speech, "start" and "end" are the first and last DIALOGUE line indices. ' +
    'EXCLUDE the character-name cue line and any pure stage-direction lines.\n' +
    '- If a cue and dialogue share one line (e.g. "NAME: text" or "NAME. text"), set start=end=that index.\n' +
    '- Use the speaker label EXACTLY as printed; do not normalise, expand or merge names here.\n' +
    '- Treat collective cues (ALL, BOTH, ENSEMBLE, COMPANY, CHORUS) as the speaker.\n' +
    '- Ignore running page headers, footers and page numbers.\n' +
    '- Do not invent speakers; narration with no speaker is not a speech.\n' +
    '- This may be a fragment of a larger script; a speech may start before the first line shown — ' +
    'only report speeches whose dialogue is visible in this fragment.\n' +
    'Output JSON only.';

  const text = await callClaude(env, {
    system,
    max_tokens: 8192,
    content: [{ type: 'text', text: numbered }],
    costCents: 2,
  });
  return json({ text });
}

/* ─────────────────────── MODE: NORMALIZE ───────────────────── */
async function handleNormalize(body, env) {
  const labels = Array.isArray(body.labels) ? body.labels : [];
  if (!labels.length) return json({ error: 'No labels provided' }, 400);

  const system =
    'You receive a JSON array of raw speaker labels extracted from ONE play. Your job:\n' +
    '- Group labels that refer to the SAME character (e.g. "VIOLET", "Vi", "VIOLET (CONT\'D)", ' +
    '"VIOLET (O.S.)" are all VIOLET).\n' +
    '- Mark group/collective speakers (ALL, BOTH, EVERYONE, ENSEMBLE, COMPANY, CHORUS, CROWD, VOICES).\n' +
    '- Identify labels that are NOT characters and should be dropped: stage-direction words ' +
    '(BLACKOUT, LIGHTS UP, CURTAIN…), production roles (DIRECTOR, STAGE MANAGER, PLAYWRIGHT…), ' +
    'scene/act headings, settings, and other formatting artefacts.\n\n' +
    'Return ONLY valid JSON, no markdown, in exactly this shape:\n' +
    '{"characters":[{"canonical":"<best display name>","aliases":["<other labels>"],"isGroup":<bool>}],' +
    '"drop":["<labels that are not characters>"]}\n\n' +
    'Rules:\n' +
    '- "canonical" should be the clearest, fullest form of the name (usually the most common printed form).\n' +
    '- Every input label MUST appear exactly once — either as a canonical, inside an aliases array, or in drop.\n' +
    '- Prefer keeping a label as a character if unsure; only drop labels that are clearly not characters.\n' +
    'Output JSON only.';

  const text = await callClaude(env, {
    system,
    max_tokens: 4096,
    content: [{ type: 'text', text: JSON.stringify(labels) }],
    costCents: 1,
  });
  return json({ text });
}

/* ───────────────────────── MODE: OVERVIEW ──────────────────── */
/* First half of the (now split) summary: a small, fast, hard-to-truncate call
   that returns the synopsis, character profiles, themes, and the LIST of scene
   divisions (labels only — no per-scene prose). The scenes themselves are then
   summarised in small batches via 'scenebatch', so no single response ever has
   to emit the whole play at once. */
async function handleOverview(body, env) {
  const text   = typeof body.text === 'string' ? body.text : '';
  const scenes = Array.isArray(body.scenes) ? body.scenes : [];
  const title  = typeof body.title === 'string' && body.title ? body.title : 'this play';
  if (!text.trim()) return json({ error: 'No text provided' }, 400);

  const MAX = 600000;
  const script = text.length > MAX ? text.slice(0, MAX) : text;

  const sceneHint = scenes.length
    ? 'A script parser detected these scene/act headings, but the list is often INCOMPLETE or ' +
      'mis-numbered — treat it only as a rough guide: ' + JSON.stringify(scenes.slice(0, 80)) + '. ' +
      'In "sceneList" return a COMPLETE list of the play\'s scenes in performance order, covering the ' +
      'ENTIRE play from the first scene to the last. Read the whole script and divide it yourself: prefer ' +
      'the script\'s own scene labels where they exist, ADD every scene missing from the detected list, and ' +
      'FIX any wrong, duplicated or out-of-sequence numbering (a 12-scene play must list all 12, numbered 1–12).'
    : 'No scene headings were detected. Read the whole script and divide the play into its scenes yourself, ' +
      'putting each scene-division label (e.g. "Scene 1 — the kitchen, morning") in "sceneList" in order, ' +
      'covering the ENTIRE play from first scene to last.';

  const system =
    'You are a dramaturg preparing study notes for actors and directors. You receive the full ' +
    'text of a stage or screen play. Return a concise OVERVIEW only — do NOT summarise individual ' +
    'scenes here. Base everything strictly on the script; never invent characters or events.\n' +
    sceneHint + '\n\n' +
    'Return ONLY valid JSON, no markdown, in exactly this shape:\n' +
    '{"synopsis":"<2-4 sentence overview of the whole play>",' +
    '"profiles":[{"name":"<character name as printed>","age":"<approx age or range>",' +
    '"summary":"<at most two short paragraphs: personality, what they want, key relationships and how they change>"}],' +
    '"themes":["<short theme phrase>"],' +
    '"contentWarnings":[{"category":"<one of the allowed keys>","severity":"central"|"referenced"}],' +
    '"sceneList":["<scene-division label>"]}\n\n' +
    'Rules:\n' +
    '- PROFILES: only the SIGNIFICANT characters, ordered by importance; omit one-line/ensemble roles. ' +
    'Each summary is AT MOST two short paragraphs, specific to THIS play, never generic.\n' +
    '- AGE: exact age if stated; otherwise a realistic estimate/range (e.g. "late 30s", "teenager"); ' +
    'use "unspecified" only if there is genuinely no basis.\n' +
    '- CONTENT WARNINGS: flag mature/sensitive content an actor deciding whether to audition would want to ' +
    'know about. ' + ADVISORY_CATS + ' Use ONLY these exact category keys, and include a key ONLY if it is ' +
    'genuinely present in the script. severity="central" for a major or recurring element, "referenced" for ' +
    'a brief or minor one. Return an EMPTY array if the play has none. Do not invent or over-flag.\n' +
    '- sceneList: labels ONLY, in performance order, covering the WHOLE play from start to finish (do not ' +
    'stop early or list only a couple of scenes), at most 60 entries. No scene summaries here.\n' +
    '- Use 3-8 themes maximum.\n' +
    'Output JSON only.';

  const out = await callClaude(env, {
    system,
    max_tokens: 8000,
    content: [{ type: 'text', text: 'TITLE: ' + title + '\n\n' + script }],
    costCents: 4,
  });
  return json({ text: out });
}

/* ──────────────────────── MODE: SCENEBATCH ─────────────────── */
/* Second half: summarise ONLY the requested slice of scenes. Bounded output, so
   it can't truncate or time out even for plays with dozens of scenes. */
async function handleSceneBatch(body, env) {
  const text   = typeof body.text === 'string' ? body.text : '';
  const title  = typeof body.title === 'string' && body.title ? body.title : 'this play';
  const labels = Array.isArray(body.sceneLabels) ? body.sceneLabels : [];
  if (!text.trim()) return json({ error: 'No text provided' }, 400);
  if (!labels.length) return json({ error: 'No scene labels provided' }, 400);

  const MAX = 600000;
  const script = text.length > MAX ? text.slice(0, MAX) : text;

  /* Categories a prior full-script read already found present in the play
     (see the overview mode's contentWarnings). Anchoring the per-scene pass
     to these cuts down on a scene being under-tagged relative to a category
     the whole-play read already confirmed is there — the client's "jump to
     this content warning" feature relies on scene-level tags landing on the
     true first occurrence, not just any occurrence. */
  const knownCats = Array.isArray(body.knownCategories)
    ? body.knownCategories.filter(c => typeof c === 'string' && c).slice(0, 20)
    : [];
  const knownCatsHint = knownCats.length
    ? ' A full read of this play already confirmed these categories occur SOMEWHERE in it: ' +
      knownCats.join(', ') + '. Check every one of the requested scenes carefully for each of ' +
      'these — an earlier scene can easily be missed if a later one is more explicit, so do not ' +
      'under-tag just because a moment is brief, referenced, or implicit.'
    : '';

  const system =
    'You are a dramaturg. You receive the FULL text of a play and a list of scene labels to ' +
    'summarise. Summarise ONLY those scenes, in the given order, basing everything strictly on ' +
    'the script — never invent characters or events.\n\n' +
    'Return ONLY valid JSON, no markdown, in exactly this shape:\n' +
    '{"scenes":[{"heading":"<the scene label>","characters":["<NAMES present in the scene>"],' +
    '"summary":"<2-5 sentences: what happens, the key beats, and how relationships shift>",' +
    '"warnings":["<content-warning keys present in THIS scene>"]}]}\n\n' +
    'Rules:\n' +
    '- Return EXACTLY one entry per requested label, in the same order, with "heading" set to that label.\n' +
    '- Keep every summary concrete and specific to THIS script — not generic.\n' +
    '- Names in "characters" should match how they appear in the script.\n' +
    '- warnings: for EACH scene, list which of these keys apply to what happens in that scene (empty array if ' +
    'none). ' + ADVISORY_CATS + ' Use ONLY these exact keys; flag only what genuinely occurs in the scene.' +
    knownCatsHint + '\n' +
    'Output JSON only.';

  const out = await callClaude(env, {
    system,
    max_tokens: 8000,
    content: [{ type: 'text', text:
      'TITLE: ' + title + '\n\n' +
      'SCENES TO SUMMARISE (in order):\n' + JSON.stringify(labels) + '\n\n' +
      'FULL SCRIPT:\n' + script }],
    costCents: 4,
  });
  return json({ text: out });
}

/* ──────────────────────── MODE: SUMMARY ────────────────────── */
/* Legacy single-shot summary — kept as a fallback. The client now prefers the
   split overview + scenebatch flow above. */
async function handleSummary(body, env) {
  const text   = typeof body.text === 'string' ? body.text : '';
  const scenes = Array.isArray(body.scenes) ? body.scenes : [];
  const title  = typeof body.title === 'string' && body.title ? body.title : 'this play';
  if (!text.trim()) return json({ error: 'No text provided' }, 400);

  /* Guard against an absurdly long payload (very rare for a single play). */
  const MAX = 600000;
  const script = text.length > MAX ? text.slice(0, MAX) : text;

  const sceneHint = scenes.length
    ? 'These scene/act headings were detected in the script — use them as your scene ' +
      'divisions wherever possible, in order: ' + JSON.stringify(scenes.slice(0, 200)) + '.'
    : 'No scene headings were detected; divide the play into sensible scenes yourself.';

  const system =
    'You are a dramaturg preparing study notes for actors and directors. You receive the full ' +
    'text of a stage or screen play. Produce (a) short character profiles and (b) a clear, ' +
    'accurate, scene-by-scene breakdown. ' +
    'Base EVERYTHING strictly on the script provided — never invent characters or events. ' +
    sceneHint + '\n\n' +
    'Return ONLY valid JSON, no markdown, in exactly this shape:\n' +
    '{"synopsis":"<2-4 sentence overview of the whole play>",' +
    '"profiles":[{"name":"<character name as printed>","age":"<approx age or range>",' +
    '"summary":"<personality, role in the story, key relationships and how they change>"}],' +
    '"scenes":[{"heading":"<scene/act label>","characters":["<NAMES present in the scene>"],' +
    '"summary":"<2-5 sentences: what happens, the key beats, and how relationships shift>"}],' +
    '"themes":["<short theme phrase>"]}\n\n' +
    'Rules:\n' +
    '- PROFILES: include only the SIGNIFICANT characters (those who drive the story); you may ' +
    'omit one-line or pure-ensemble roles. Order them by importance.\n' +
    '- Each profile "summary" must be AT MOST two short paragraphs, grounded in the script — ' +
    'their personality, what they want, their relationships and how they change. Be specific to ' +
    'THIS play, never generic.\n' +
    '- AGE: give an exact age if the script states one; otherwise give a realistic estimate or ' +
    'range (e.g. "late 30s", "60s", "teenager") inferred from how the character is described and ' +
    'their role. If there is genuinely no basis to judge, use "unspecified".\n' +
    '- Keep every scene summary concrete and specific to THIS script — not generic.\n' +
    '- Names in the "characters" arrays should match how they appear in the script.\n' +
    '- Cover the whole play in order. Use 3-8 themes maximum.\n' +
    'Output JSON only.';

  const out = await callClaude(env, {
    system,
    max_tokens: 16000,
    content: [{ type: 'text', text: 'TITLE: ' + title + '\n\n' + script }],
    costCents: 6,
  });
  return json({ text: out });
}

/* ─────────────────── MODE: LIBRARY-CHECK ───────────────────── */
/* The shared library is a PRIVATE cache, not a public list. It only ever returns
   an analysis to a caller who has just uploaded a matching script themselves, so
   no script is ever exposed to someone who doesn't already have it. We look up by
   exact file hash first (identical file), then by content fingerprint (the same
   play uploaded as a different file). */
async function handleLibraryCheck(body, env) {
  if (!env.PLAY_LIBRARY) return json({ hit: false });   /* namespace not bound yet */

  const fileHash    = typeof body.fileHash    === 'string' ? body.fileHash    : '';
  const fingerprint = typeof body.fingerprint === 'string' ? body.fingerprint : '';

  let raw = null;
  if (fileHash)            raw = await env.PLAY_LIBRARY.get('file:' + fileHash);
  if (!raw && fingerprint) raw = await env.PLAY_LIBRARY.get('fp:'   + fingerprint);
  if (!raw) return json({ hit: false });

  let script;
  try { script = JSON.parse(raw); } catch { return json({ hit: false }); }
  return json({ hit: true, script });
}

/* ─────────────────── MODE: LIBRARY-SAVE ────────────────────── */
async function handleLibrarySave(body, env) {
  if (!env.PLAY_LIBRARY) return json({ ok: false, reason: 'no-namespace' });

  const fileHash    = typeof body.fileHash    === 'string' ? body.fileHash    : '';
  const fingerprint = typeof body.fingerprint === 'string' ? body.fingerprint : '';
  const script      = body.script;
  if (!script || typeof script !== 'object') return json({ ok: false, reason: 'no-script' });
  if (!fileHash && !fingerprint)             return json({ ok: false, reason: 'no-key' });

  const payload = JSON.stringify(script);
  if (payload.length > 20 * 1024 * 1024) return json({ ok: false, reason: 'too-large' });

  /* Store under both keys so either an identical file or a matching content
     fingerprint will find it next time. KV writes are cheap; one play is small. */
  const writes = [];
  if (fileHash)    writes.push(env.PLAY_LIBRARY.put('file:' + fileHash,    payload));
  if (fingerprint) writes.push(env.PLAY_LIBRARY.put('fp:'   + fingerprint, payload));
  await Promise.all(writes);

  return json({ ok: true });
}

/* ───────────────────────── HELPERS ─────────────────────────── */

/* #2 — daily spend circuit breaker. Accumulates a rough estimated cost (in cents)
   per UTC day in KV and refuses once it crosses DAILY_BUDGET_CENTS. Reuses the
   PLAY_LIBRARY namespace, so no extra binding is needed. If KV isn't bound it
   simply doesn't meter (your Anthropic monthly limit remains the backstop).
   Note: KV is eventually consistent, so under a heavy burst the count can lag
   slightly — fine for a ceiling; pair with per-IP limiting (#3) for bursts. */
function utcDay() { return new Date().toISOString().slice(0, 10); }

async function budgetOk(env, cents) {
  if (!env.PLAY_LIBRARY) return true;
  const key = 'budget:' + utcDay();
  const cur = parseInt((await env.PLAY_LIBRARY.get(key)) || '0', 10) || 0;
  if (cur >= DAILY_BUDGET_CENTS) return false;
  await env.PLAY_LIBRARY.put(key, String(cur + Math.ceil(cents)), { expirationTtl: 172800 });
  return true;
}

async function callClaude(env, { system, max_tokens, content, costCents }) {
  if (!env.ANTHROPIC_API_KEY) throw new Error('Server missing ANTHROPIC_API_KEY');

  /* Charge the daily budget BEFORE spending, and bail if the day is exhausted. */
  if (costCents != null && !(await budgetOk(env, costCents))) throw new Error('DAILY_LIMIT');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens,
      system,
      messages: [{ role: 'user', content }],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error('Anthropic error: ' + err);
  }

  const data = await res.json();
  return data.content?.[0]?.text ?? '';
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

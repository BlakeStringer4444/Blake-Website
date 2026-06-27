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
 *   4. "summary"    — { mode:"summary", text:"<full script>", scenes:[…], title:"…" }
 *                     Claude produces character profiles (name, approx age, personality)
 *                     and a scene-by-scene breakdown of the play.
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
 * KV namespace required (for the shared library — modes 5 & 6):
 *   PLAY_LIBRARY  — a Workers KV namespace bound to this Worker.
 *                   If it is NOT bound, the library modes degrade gracefully
 *                   (every check is a miss, every save is a no-op) and the tool
 *                   still works exactly as before — just without cross-user dedup.
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

const ALLOWED_ORIGIN = 'https://www.blakestringer.com';
const MODEL          = 'claude-sonnet-4-6';

const CORS = {
  'Access-Control-Allow-Origin':  ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env) {

    /* ── CORS preflight ── */
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers: CORS });
    }

    /* ── Parse body ── */
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'Invalid JSON' }, 400);
    }

    const mode = body.mode;

    try {
      if (mode === 'ocr')           return await handleOcr(body, env);
      if (mode === 'structure')     return await handleStructure(body, env);
      if (mode === 'normalize')     return await handleNormalize(body, env);
      if (mode === 'summary')       return await handleSummary(body, env);
      if (mode === 'library-check') return await handleLibraryCheck(body, env);
      if (mode === 'library-save')  return await handleLibrarySave(body, env);
      return json({ error: 'Unknown mode: ' + mode }, 400);
    } catch (e) {
      return json({ error: e.message || String(e) }, 502);
    }
  },
};

/* ───────────────────────── MODE: OCR ───────────────────────── */
async function handleOcr(body, env) {
  const images = Array.isArray(body.images) ? body.images : [];
  if (!images.length) return json({ error: 'No images provided' }, 400);

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

  const text = await callClaude(env, { system, max_tokens: 8192, content });
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
  });
  return json({ text });
}

/* ──────────────────────── MODE: SUMMARY ────────────────────── */
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
async function callClaude(env, { system, max_tokens, content }) {
  if (!env.ANTHROPIC_API_KEY) throw new Error('Server missing ANTHROPIC_API_KEY');

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
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

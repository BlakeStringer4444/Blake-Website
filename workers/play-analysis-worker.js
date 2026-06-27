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
 * Secrets required:
 *   ANTHROPIC_API_KEY  — from console.anthropic.com
 *
 * Deploy steps (done once):
 *   1. workers.cloudflare.com → Create Worker → paste this file
 *   2. Settings → Variables → Add secret: ANTHROPIC_API_KEY = <your key>
 *   3. Copy the worker URL (e.g. https://play-analysis.YOUR-NAME.workers.dev)
 *   4. Paste that URL into PA_WORKER_URL in tools/play-analysis/index.html
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
      if (mode === 'ocr')       return await handleOcr(body, env);
      if (mode === 'structure') return await handleStructure(body, env);
      if (mode === 'normalize') return await handleNormalize(body, env);
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

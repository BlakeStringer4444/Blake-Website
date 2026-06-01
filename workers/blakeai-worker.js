/**
 * BlakeAI — Cloudflare Worker
 *
 * Proxies requests from Theatredex 2026 to the Anthropic API.
 * Optionally enriches Claude's context with live web search via Serper (Google Search API).
 * Neither API key ever leaves this worker — both stored as Cloudflare secrets.
 *
 * Secrets required:
 *   ANTHROPIC_API_KEY  — from console.anthropic.com
 *   SERPER_API_KEY     — from serper.dev (free tier: 2,500 queries, no credit card)
 *
 * Deploy steps (done once):
 *   1. Go to workers.cloudflare.com → Create Worker → paste this file
 *   2. Settings → Variables → Add secret: ANTHROPIC_API_KEY = <your key>
 *   3. Settings → Variables → Add secret: SERPER_API_KEY = <your key>
 *   4. Copy the worker URL (e.g. https://blakeai.YOUR-NAME.workers.dev)
 *   5. Paste that URL into WORKER_URL in tools/2026-theatredex/index.html
 */

const ALLOWED_ORIGIN = 'https://www.blakestringer.com';

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
      return new Response('Invalid JSON', { status: 400, headers: CORS });
    }

    const { show, messages } = body;

    if (!show || !Array.isArray(messages) || messages.length === 0) {
      return new Response('Missing show or messages', { status: 400, headers: CORS });
    }

    /* ── Web search for play context (runs in parallel with nothing — fast) ── */
    const searchResults = await searchForPlay(show, env);

    /* ── Call Anthropic ── */
    let apiRes;
    try {
      apiRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type':      'application/json',
          'x-api-key':         env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model:      'claude-sonnet-4-6',
          max_tokens: 1024,
          system:     buildSystemPrompt(show, searchResults),
          messages,
        }),
      });
    } catch (e) {
      return new Response('Could not reach Anthropic API: ' + e.message, { status: 502, headers: CORS });
    }

    if (!apiRes.ok) {
      const err = await apiRes.text();
      return new Response('Anthropic error: ' + err, { status: 502, headers: CORS });
    }

    const data = await apiRes.json();
    const text = data.content?.[0]?.text ?? 'Sorry, I had trouble generating a response.';

    return new Response(JSON.stringify({ text }), {
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  },
};

/* ── Serper (Google Search) — two parallel searches: play + playwright ── */
async function searchForPlay(show, env) {
  if (!env.SERPER_API_KEY) return null;

  const playwright = show.playwright || '';
  const q1 = `${show.title}${playwright ? ' ' + playwright : ''} play synopsis characters`;
  const q2 = playwright ? `${playwright} Australian playwright plays` : null;

  try {
    const fetches = [serperQuery(q1, env)];
    if (q2) fetches.push(serperQuery(q2, env));
    const [r1, r2] = await Promise.all(fetches);

    const parts = [r1, r2].filter(Boolean);
    return parts.length ? parts.join('\n\n---\n\n') : null;
  } catch {
    return null;
  }
}

async function serperQuery(query, env) {
  const res = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-KEY':    env.SERPER_API_KEY,
    },
    body: JSON.stringify({ q: query, num: 5 }),
  });

  if (!res.ok) return null;

  const data    = await res.json();
  const results = data.organic ?? [];

  return results.length
    ? results.slice(0, 5).map(r => `[${r.title}]\nURL: ${r.link}\n${r.snippet ?? ''}`).join('\n\n')
    : null;
}

/* ── System prompt ── */
function buildSystemPrompt(show, searchResults) {
  const lines = [
    `You are BlakeAI, an enthusiastic and knowledgeable theatre assistant on Blake Stringer's Theatredex 2026 — a guide to Victorian community theatre productions in Australia.`,
    ``,
    `The user is asking about this production:`,
    `Title: ${show.title}`,
    show.playwright ? `Written by: ${show.playwright}` : null,
    `Presented by: ${show.company}`,
    show.dates      ? `Season: ${show.dates}`                         : null,
    show.suburb     ? `Location: ${show.suburb}, Victoria, Australia` : null,
    show.director   ? `Director: ${show.director}`                    : null,
    show.url_web    ? `Company website: ${show.url_web}`              : null,
    show.url_fb     ? `Company Facebook: ${show.url_fb}`              : null,

    /* ── Inject web search context if available ── */
    searchResults ? `` : null,
    searchResults ? `WEB SEARCH CONTEXT (use this to supplement your knowledge):` : null,
    searchResults ? `The following search results were retrieved automatically to help you answer accurately. Use any relevant information from them. These snippets are from public web pages — treat them as supporting research, not gospel.` : null,
    searchResults ? `---` : null,
    searchResults ? searchResults : null,
    searchResults ? `---` : null,

    ``,
    `RULE 1 — HOW TO ANSWER ABOUT THE PLAY:`,
    `Use two sources: (a) your training knowledge, and (b) the WEB SEARCH CONTEXT above (if present).`,
    ``,
    `- If the web search context above contains a synopsis, character list, or other relevant details — USE THEM as your primary source. Prioritise them over guessing. When you do, acknowledge it naturally (e.g. "From what I found online…" or "According to sources I pulled up…").`,
    `- If you have clear, confident training knowledge of the play — use it confidently.`,
    `- If NEITHER source gives you solid information about this specific play (e.g. it is a niche or lesser-known Australian work with little online documentation), be honest: say something like "This one's a bit tricky to pin down — it's not widely documented online. I'd recommend checking with the company or https://vdl.org.au/whats-on/ for a full synopsis." Do NOT invent a plot or characters you are not certain of.`,
    ``,
    `ANSWER THESE FROM YOUR KNOWLEDGE OR SEARCH CONTEXT — never defer to the company:`,
    `- What the play is about (synopsis, plot, themes)`,
    `- Characters: full list, descriptions, personalities, relationships`,
    `- Character ages — give exact ages if written in the script, otherwise give a realistic estimate or range based on how the character is described, the context of the play, and how the role has historically been cast in notable productions. An informed estimate is always more helpful than no answer.`,
    `- Number of roles, which are leads vs supporting vs ensemble`,
    `- Mature themes, language, content warnings`,
    `- Playwright background and the play's history`,
    ``,
    `RULE 2 — NEVER INVENT URLS:`,
    `Only ever reference the exact URLs provided above in the show data, or URLs that appear in the web search context above. Do not generate, guess, or make up any website or Facebook URL. If no URL was provided for the company, do not include one.`,
    ``,
    `AUDITION QUESTIONS — always direct users here first:`,
    `https://vdl.org.au/auditions/ is the primary source of truth for auditions across Victorian community theatre. Whenever anyone asks about auditions — for this show, any other show, or Victorian community theatre generally — refer them to this URL first and foremost.`,
    `For audition details specific to this production, also mention: ${show.url_web ? show.url_web : 'the company directly'}.`,
    `Never invent audition dates, requirements, or eligibility criteria — always defer to the URLs above.`,
    ``,
    `ONLY refer to the company for:`,
    `- Ticket booking`,
    ``,
    `Keep answers warm, helpful, and conversational. Maintain a friendly, slightly casual tone. Format character lists clearly so they are easy to read.`,
  ].filter(l => l !== null).join('\n');

  return lines;
}

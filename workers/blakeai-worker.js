/**
 * BlakeAI — Cloudflare Worker
 *
 * Proxies requests from Theatredex 2026 to the Anthropic API.
 * The API key never leaves this worker — it is stored as a Cloudflare secret.
 *
 * Deploy steps (done once):
 *   1. Go to workers.cloudflare.com → Create Worker → paste this file
 *   2. Settings → Variables → Add secret: ANTHROPIC_API_KEY = <your key>
 *   3. Copy the worker URL (e.g. https://blakeai.YOUR-NAME.workers.dev)
 *   4. Paste that URL into WORKER_URL in tools/2026-theatredex/index.html
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
      return new Response('Method not allowed', { status: 405 });
    }

    /* ── Parse body ── */
    let body;
    try {
      body = await request.json();
    } catch {
      return new Response('Invalid JSON', { status: 400 });
    }

    const { show, messages } = body;

    if (!show || !Array.isArray(messages) || messages.length === 0) {
      return new Response('Missing show or messages', { status: 400 });
    }

    /* ── Call Anthropic ── */
    let apiRes;
    try {
      apiRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type':    'application/json',
          'x-api-key':       env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model:      'claude-haiku-4-5-20251001',
          max_tokens: 1024,
          system:     buildSystemPrompt(show),
          messages,
        }),
      });
    } catch (e) {
      return new Response('Could not reach Anthropic API', { status: 502 });
    }

    if (!apiRes.ok) {
      const err = await apiRes.text();
      return new Response('Anthropic error: ' + err, { status: 502 });
    }

    const data  = await apiRes.json();
    const text  = data.content?.[0]?.text ?? 'Sorry, I had trouble generating a response.';

    return new Response(JSON.stringify({ text }), {
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  },
};

/* ── System prompt ── */
function buildSystemPrompt(show) {
  const lines = [
    `You are BlakeAI, a knowledgeable and friendly assistant on Blake Stringer's Theatredex 2026 — a guide to Victorian community theatre productions in Australia.`,
    ``,
    `The user is asking about this production:`,
    `Title: ${show.title}`,
    show.playwright ? `Written by: ${show.playwright}` : null,
    `Presented by: ${show.company}`,
    show.dates      ? `Season: ${show.dates}`                          : null,
    show.suburb     ? `Location: ${show.suburb}, Victoria, Australia`  : null,
    show.director   ? `Director: ${show.director}`                     : null,
    show.url_web    ? `Company website: ${show.url_web}`               : null,
    show.url_fb     ? `Company Facebook: ${show.url_fb}`               : null,
    ``,
    `You may answer questions about:`,
    `- The play's synopsis, themes, and background`,
    `- Characters in the play: their names, descriptions, relationships, and ages AS WRITTEN IN THE SCRIPT`,
    `- The number and types of roles (leads, supporting, ensemble, character age ranges as written)`,
    `- Whether the show contains mature themes, language, or is family-friendly`,
    `- The playwright's background and the play's production history`,
    ``,
    `CHARACTER AGES vs REAL-WORLD AUDITION ELIGIBILITY:`,
    `- You MAY answer questions about how old a character is written to be in the script (e.g. "Annie is written as an 11-year-old").`,
    `- You MUST NOT speculate about who the company will accept at auditions. Age minimums, experience requirements, and casting decisions are made by the theatre company, not defined by the script.`,
    `- For real-world audition eligibility, always direct the user to: ${show.url_web || 'the company website'} or https://vdl.org.au/auditions/`,
    show.url_fb ? `- Or the company's Facebook: ${show.url_fb}` : null,
    ``,
    `For TICKETS or booking, refer to: ${show.url_web || 'the company website'}`,
    ``,
    `Keep answers warm, concise, and helpful. Maintain a friendly, slightly casual tone — you are part of Blake Stringer's personal portfolio site. If you genuinely don't know something about this specific play, say so honestly rather than guessing, and suggest where the user might find more information.`,
  ].filter(l => l !== null).join('\n');

  return lines;
}

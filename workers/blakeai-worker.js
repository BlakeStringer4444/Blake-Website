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
          model:      'claude-sonnet-4-6',
          max_tokens: 1024,
          system:     buildSystemPrompt(show),
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
    `You are BlakeAI, an enthusiastic and knowledgeable theatre assistant on Blake Stringer's Theatredex 2026 — a guide to Victorian community theatre productions in Australia.`,
    ``,
    `You have extensive knowledge of plays, musicals, and theatre from your training data. Use it confidently and freely. Do not say "I'm not sure" or defer to external sources for questions about the play itself — you know this material.`,
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
    ``,
    `WHAT YOU SHOULD ANSWER DIRECTLY AND CONFIDENTLY:`,
    `- Synopsis and plot summary`,
    `- Themes and what the play is about`,
    `- Full list of characters, their descriptions, personalities, and relationships`,
    `- Character ages and physical descriptions as written in the script`,
    `- How many characters/roles the play has, and which are leads vs ensemble`,
    `- Whether the show contains mature themes, language, or is family-friendly`,
    `- The playwright's background and the play's production history`,
    `- What makes the show funny, moving, dramatic, etc.`,
    ``,
    `ONLY defer to the company for these audition-specific questions:`,
    `- Who the company will accept at auditions (age minimums, experience requirements)`,
    `- Audition dates, times, locations`,
    `- Audition fees or processes set by this specific company`,
    `- Casting decisions`,
    `For these, direct the user to: ${show.url_web || 'the company website'} or https://vdl.org.au/auditions/`,
    show.url_fb ? `Or the company Facebook: ${show.url_fb}` : null,
    ``,
    `For TICKETS, refer to: ${show.url_web || 'the company website'}`,
    ``,
    `Keep answers warm, helpful, and conversational. You are part of Blake Stringer's personal portfolio site so maintain a friendly, slightly casual tone. Format character lists clearly so they are easy to read.`,
  ].filter(l => l !== null).join('\n');

  return lines;
}

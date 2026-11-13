#!/usr/bin/env node
/**
 * build-theatredex.mjs — bake the Google Sheet into crawlable static HTML.
 *
 * Theatredex renders its listings client-side from a published Google Sheet
 * CSV. Search engines often index the page before that JS fetch finishes, so
 * they see an almost-empty page ("soft 404"). This script reads the same CSV
 * and writes the full production directory straight into tools/theatredex/
 * index.html as (a) a visually-hidden, crawlable <section> and (b) a
 * schema.org TheaterEvent JSON-LD block — so the content is in the raw HTML
 * the instant Google downloads the page. The visible interactive app is
 * unchanged; the Sheet stays the single source of truth.
 *
 * Usage:
 *   node scripts/build-theatredex.mjs            # fetch the live Sheet
 *   node scripts/build-theatredex.mjs --csv f.csv # build from a local file (testing)
 *
 * Data source (first match wins):
 *   --csv <path>                 local CSV file
 *   env THEATREDEX_CSV_URL       published-sheet CSV URL (used by CI)
 *   DEFAULT_CSV_URL below        fallback
 *
 * Injected between these markers in tools/theatredex/index.html:
 *   <!-- TDX:SEO:START -->    … <!-- TDX:SEO:END -->
 *   <!-- TDX:JSONLD:START --> … <!-- TDX:JSONLD:END -->
 * Nothing outside the markers is touched.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const PAGE_PATH = join(REPO_ROOT, 'tools', 'theatredex', 'index.html');
const CANONICAL = 'https://www.blakestringer.com/tools/theatredex';
/* The season rule, identical to tools/theatredex/index.html and
   spreadsheet.html — update all three together. A season retires the morning
   after its last show (Melbourne time). Retirement is an absolute instant, so
   it lands the same whatever timezone CI runs in.

   The bake covers one season — the one the page opens on — so what search
   engines index (and what the page falls back to if the live data can't
   load) is the current season, never two competing ones. CI bakes every six
   hours, so it moves on by itself within six hours of a retirement. */
const ALL_YEARS = [2026, 2027];
const RETIRES   = { 2026: '2026-12-21T00:00:00+11:00' };   /* last 2026 show: 20 Dec */
const YEARS     = ALL_YEARS.filter(y => !(RETIRES[y] && Date.now() >= Date.parse(RETIRES[y])));
/* Same choice as defaultYear() in the page: this year if it's still running,
   otherwise the nearest running season. */
const YEAR = (() => {
  const y = new Date().getFullYear();
  if (YEARS.indexOf(y) !== -1) return y;
  return y < YEARS[0] ? YEARS[0] : YEARS[YEARS.length - 1];
})();

const DEFAULT_CSV_URL =
  'https://docs.google.com/spreadsheets/d/e/2PACX-1vShrAdd1Wbvx9DPxhtZpcXmsT7k8yDUPUqX-oNBCMjQn6jsDaTKfDWiGPe-v08g_AEEc5VRG_GrLr-z/pub?output=csv';

const MONTHS = ['January','February','March','April','May','June','July',
                'August','September','October','November','December'];

/* ── CSV parsing ──
   Identical to the parser in tools/theatredex/index.html and spreadsheet.html
   — change all three together. RFC 4180, which is what Google Sheets exports:
   a quoted field may hold commas, doubled quotes ("") and line breaks. The
   old version split on newlines first, so a row with a line break inside a
   cell was cut in two and the dated half dropped out of the bake. */
function parseRows(text) {
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c !== '"') cur += c;
      else if (text[i + 1] === '"') { cur += '"'; i++; }
      else q = false;
    }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cur); rows.push(row); row = []; cur = '';
    }
    else cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

function cleanCell(v) {
  return v.trim().replace(/[ \t]*\n\s*/g, (m, at, s) =>
    /[:;,.\-–—\/&(]$/.test(s.slice(0, at)) ? ' ' : ', ');
}

function isoDate(v) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v);
  return m ? m[3] + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0') : v;
}

function parseCSV(text) {
  const rows = parseRows(text);
  if (!rows.length) return [];
  const headers = rows[0].map(h => h.trim());
  const out = [];
  for (const vals of rows.slice(1)) {
    if (vals.every(v => !v.trim())) continue;
    const row = {};
    headers.forEach((h, i) => { row[h] = cleanCell(vals[i] || ''); });
    row.date_start = isoDate(row.date_start || '');
    row.date_end   = isoDate(row.date_end || '');
    if (row.company && row.title) out.push(row);
  }
  return out;
}

/* ── helpers ── */
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function safeUrl(url) {
  if (!url) return '';
  return /^https?:\/\//i.test(url) ? url : 'https://' + url;
}

function parseDate(iso) {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const d = new Date(iso + 'T00:00:00');
  return isNaN(d) ? null : d;
}

function fmtDate(iso) {
  const d = parseDate(iso);
  return d ? d.getDate() + ' ' + MONTHS[d.getMonth()] + ' ' + d.getFullYear() : '';
}

function fmtRange(row) {
  if (row.date_approximate === 'Yes') {
    const d = parseDate(row.date_start);
    return d ? MONTHS[d.getMonth()] + ' ' + d.getFullYear() : '';
  }
  const s = fmtDate(row.date_start), e = fmtDate(row.date_end);
  if (s && e && s !== e) return s + ' – ' + e;
  return s || e || '';
}

/* ── build the visually-hidden listings section ── */
function buildSeoSection(rows) {
  const byCompany = new Map();
  for (const r of rows) {
    if (!byCompany.has(r.company)) byCompany.set(r.company, { suburb: r.suburb || '', shows: [] });
    byCompany.get(r.company).shows.push(r);
  }
  const companies = [...byCompany.keys()].sort((a, b) =>
    a.localeCompare(b, 'en', { sensitivity: 'base' }));

  const parts = [];
  parts.push('<section id="td-seo-static" class="td-sr-only" aria-hidden="true">');
  parts.push(`<h2>${YEAR} Victorian Community Theatre Productions</h2>`);
  parts.push(`<p>Theatredex is a directory of ${rows.length} community theatre productions from ` +
             `${companies.length} companies across Melbourne and regional Victoria for ${YEAR}. ` +
             `Browse every play and musical below, or use the interactive search, map and calendar above.</p>`);

  for (const company of companies) {
    const { suburb, shows } = byCompany.get(company);
    shows.sort((a, b) => (a.date_start || '').localeCompare(b.date_start || ''));
    parts.push('<article>');
    parts.push(`<h3>${escapeHtml(company)}${suburb ? ' — ' + escapeHtml(suburb) + ', Victoria' : ''}</h3>`);
    parts.push('<ul>');
    for (const s of shows) {
      const range = fmtRange(s);
      const bits = [];
      bits.push(`${escapeHtml(s.type || 'Play')}`);
      if (range) bits.push(range);
      if (s.director)   bits.push('directed by ' + escapeHtml(s.director));
      if (s.playwright) bits.push('written by ' + escapeHtml(s.playwright));
      const web = safeUrl(s.url_web);
      const title = web
        ? `<a href="${escapeHtml(web)}">${escapeHtml(s.title)}</a>`
        : `<strong>${escapeHtml(s.title)}</strong>`;
      parts.push(`<li>${title} — ${bits.join(', ')}.</li>`);
    }
    parts.push('</ul>');
    parts.push('</article>');
  }
  parts.push('</section>');
  return parts.join('\n  ');
}

/* ── build schema.org JSON-LD (TheaterEvent list) ── */
function buildJsonLd(rows) {
  const items = [];
  let pos = 0;
  for (const r of rows) {
    if (!parseDate(r.date_start)) continue;   // Event requires a valid startDate
    pos++;
    const event = {
      '@type': 'TheaterEvent',
      name: r.title,
      startDate: r.date_start,
      endDate: parseDate(r.date_end) ? r.date_end : r.date_start,
      eventStatus: 'https://schema.org/EventScheduled',
      eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
      location: {
        '@type': 'Place',
        name: r.company,
        address: {
          '@type': 'PostalAddress',
          addressLocality: r.suburb || undefined,
          addressRegion: 'VIC',
          addressCountry: 'AU',
        },
      },
      organizer: { '@type': 'Organization', name: r.company, url: safeUrl(r.url_web) || undefined },
      performer: { '@type': 'TheaterGroup', name: r.company },
    };
    const url = safeUrl(r.url_web);
    if (url) event.url = url;
    items.push({ '@type': 'ListItem', position: pos, item: event });
  }

  const graph = {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: `${YEAR} Victorian Community Theatre Productions`,
    url: CANONICAL,
    numberOfItems: items.length,
    itemListElement: items,
  };

  // Pretty-print, then guard against </script> breaking out of the tag.
  const json = JSON.stringify(graph, null, 2).replace(/<\//g, '<\\/');
  return `<script type="application/ld+json">\n${json}\n</script>`;
}

/* ── marker replacement ── */
function replaceRegion(html, name, replacement) {
  const start = `<!-- ${name}:START -->`;
  const end   = `<!-- ${name}:END -->`;
  const si = html.indexOf(start);
  const ei = html.indexOf(end);
  if (si === -1 || ei === -1 || ei < si) {
    throw new Error(`Markers ${name}:START/${name}:END not found (or out of order) in the page.`);
  }
  return html.slice(0, si + start.length) + '\n  ' + replacement + '\n  ' + html.slice(ei);
}

/* Accept either form of a Google "Publish to web" link and always fetch CSV:
   .../pubhtml  (the human web page)  ->  .../pub?output=csv  (the data export). */
function normalizeCsvUrl(u) {
  if (!u) return u;
  if (/[?&]output=csv/i.test(u)) return u;
  const base = u.replace(/\/pubhtml.*$/i, '/pub').replace(/\/pub(\?.*)?$/i, '/pub');
  return base + '?output=csv';
}

/* ── data source ── */
async function loadCsv() {
  const csvArgIdx = process.argv.indexOf('--csv');
  if (csvArgIdx !== -1 && process.argv[csvArgIdx + 1]) {
    const p = process.argv[csvArgIdx + 1];
    console.log(`Reading CSV from local file: ${p}`);
    return readFile(p, 'utf8');
  }
  const url = normalizeCsvUrl(process.env.THEATREDEX_CSV_URL || DEFAULT_CSV_URL);
  console.log(`Fetching CSV from: ${url.slice(0, 60)}…`);
  const res = await fetch(url + (url.includes('?') ? '&' : '?') + 't=' + Date.now(), {
    headers: { 'cache-control': 'no-cache' },
  });
  if (!res.ok) throw new Error(`CSV fetch failed: HTTP ${res.status}`);
  return res.text();
}

/* The page's own season wording, outside the generated regions: the meta
   descriptions, the heading and intro, and the loading line. Kept in step so
   the source never names one season while baking another. Matched by their
   wording, so an edit to one of these sentences is reported in the CI log
   rather than failing the bake. */
const SEASON_TEXT = [
  [/(productions for )\d{4}(\. Search by location)/g, 3, 'meta descriptions'],
  [/(<h1 class="td-title" id="td-title">Theatredex )\d{4}(<\/h1>)/g, 1, 'heading'],
  [/(theatre productions for )\d{4}(, covering dozens)/g, 1, 'intro'],
  [/(Loading )\d{4}( Victorian community theatre productions)/g, 1, 'loading line'],
];
function stampSeason(html) {
  for (const [re, want, what] of SEASON_TEXT) {
    const n = (html.match(re) || []).length;
    if (n !== want) console.warn(`stampSeason: expected ${want} ${what}, found ${n} — check the wording in index.html.`);
    html = html.replace(re, `$1${YEAR}$2`);
  }
  return html;
}

/* ── main ── */
async function main() {
  const csv     = await loadCsv();
  const allRows = parseCSV(csv);
  if (!allRows.length) throw new Error('No rows parsed from CSV — refusing to overwrite with empty content.');

  /* Exactly this season's rows — the same rows the live page shows for it. */
  const rows = allRows.filter(r => {
    const d = parseDate(r.date_start);
    return d && d.getFullYear() === YEAR;
  });
  if (!rows.length) {
    throw new Error(`None of the ${allRows.length} rows are in ${YEAR} — refusing to overwrite with empty content.`);
  }
  rows.sort((a, b) => (a.date_start || '').localeCompare(b.date_start || ''));
  console.log(`Parsed ${allRows.length} productions; baking the ${rows.length} in ${YEAR}.`);

  let html = await readFile(PAGE_PATH, 'utf8');
  html = replaceRegion(html, 'TDX:SEO',    buildSeoSection(rows));
  html = replaceRegion(html, 'TDX:JSONLD', buildJsonLd(rows));
  html = stampSeason(html);
  await writeFile(PAGE_PATH, html);
  console.log(`Baked ${rows.length} productions into ${PAGE_PATH.replace(REPO_ROOT + '/', '')}.`);
}

main().catch(err => {
  console.error('build-theatredex failed:', err.message);
  process.exit(1);
});

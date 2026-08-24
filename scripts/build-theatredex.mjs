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
const YEAR      = 2026;

/* Shows for HIDDEN_YEAR are being added to the Sheet ahead of time as
   they're discovered, but shouldn't be public yet — filtered out here so
   they never reach the baked SEO/JSON-LD content search engines see. The
   exact same filter also lives in tools/theatredex/index.html and
   spreadsheet.html (the live client-side app and its public spreadsheet
   view), since this script only covers the crawlable fallback content —
   update all three together, or just delete the filter once that season
   is ready to announce. */
const HIDDEN_YEAR = 2027;

const DEFAULT_CSV_URL =
  'https://docs.google.com/spreadsheets/d/e/2PACX-1vShrAdd1Wbvx9DPxhtZpcXmsT7k8yDUPUqX-oNBCMjQn6jsDaTKfDWiGPe-v08g_AEEc5VRG_GrLr-z/pub?output=csv';

const MONTHS = ['January','February','March','April','May','June','July',
                'August','September','October','November','December'];

/* ── CSV parsing (mirrors the parser in index.html) ── */
function splitRow(line) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') q = !q;
    else if (c === ',' && !q) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

function parseCSV(text) {
  const lines = text.replace(/\r/g, '').split('\n');
  const headers = splitRow(lines[0]).map(h => h.trim());
  const rows = [];
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const vals = splitRow(line);
    const row = {};
    headers.forEach((h, i) => { row[h] = (vals[i] || '').trim(); });
    if (row.company && row.title) rows.push(row);
  }
  return rows;
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

/* ── main ── */
async function main() {
  const csv     = await loadCsv();
  const allRows = parseCSV(csv);
  if (!allRows.length) throw new Error('No rows parsed from CSV — refusing to overwrite with empty content.');

  const rows = allRows.filter(r => {
    const d = parseDate(r.date_start);
    return !d || d.getFullYear() !== HIDDEN_YEAR;
  });
  if (!rows.length) {
    throw new Error(`All ${allRows.length} rows were for ${HIDDEN_YEAR} (hidden) — refusing to overwrite with empty content.`);
  }
  rows.sort((a, b) => (a.date_start || '').localeCompare(b.date_start || ''));
  console.log(`Parsed ${allRows.length} productions (${rows.length} after hiding ${HIDDEN_YEAR}).`);

  let html = await readFile(PAGE_PATH, 'utf8');
  html = replaceRegion(html, 'TDX:SEO',    buildSeoSection(rows));
  html = replaceRegion(html, 'TDX:JSONLD', buildJsonLd(rows));
  await writeFile(PAGE_PATH, html);
  console.log(`Baked ${rows.length} productions into ${PAGE_PATH.replace(REPO_ROOT + '/', '')}.`);
}

main().catch(err => {
  console.error('build-theatredex failed:', err.message);
  process.exit(1);
});

/**
 * inject.js — build-time content injection (v2, self-healing)
 *
 * Reads active feed entries and insight articles from Supabase and writes them
 * directly into index.html between the FEED and INSIGHTS marker comments, so
 * the served HTML contains the real content for crawlers that do not run JS.
 *
 * v2 fixes the v1 defect that broke the live homepage: v1 used
 * String.replace() with a "$1 … $2" replacement string, so any dollar amount
 * in article text ("$1.7 billion", "$20 million") was treated as a regex
 * back-reference and replaced with a copy of a marker comment. Each run then
 * matched a stray marker and left the previous run's content behind, so the
 * feed accumulated duplicates and fragments like "7 billion to fund…".
 *
 * v2 does no regex substitution at all. It replaces everything from the FIRST
 * start marker to the LAST end marker — which also removes the accumulated
 * junk from v1, so the first v2 run repairs the page.
 *
 * Fails loudly and leaves index.html untouched if anything looks wrong.
 * No dependencies — Node 18+ has native fetch.
 */

import fs from 'node:fs';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const FILE = 'index.html';
const FEED_LIMIT = 4;
const ARTICLE_LIMIT = 4;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY must both be set.');
}

/* ── helpers ────────────────────────────────────────────────────────────── */

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));

async function sb(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) {
    throw new Error(`Supabase ${res.status} on ${path}: ${await res.text()}`);
  }
  return res.json();
}

const marker = (name, edge) => `<!-- ${name}:${edge} -->`;

function countOf(html, needle) {
  let n = 0;
  for (let i = html.indexOf(needle); i !== -1; i = html.indexOf(needle, i + needle.length)) n++;
  return n;
}

/**
 * Replace everything between the first START marker and the last END marker.
 * Plain string slicing — no regex, so "$" in content is always literal text.
 */
function replaceRegion(html, name, content) {
  const start = marker(name, 'START');
  const end = marker(name, 'END');
  const s = html.indexOf(start);
  const e = html.lastIndexOf(end);
  if (s === -1 || e === -1 || e < s) {
    throw new Error(`Markers ${start} / ${end} not found in order in ${FILE}.`);
  }
  if (content.includes('<!--')) {
    throw new Error(`Rendered ${name} content contains a comment marker — refusing to write.`);
  }
  return html.slice(0, s + start.length) + '\n' + content + '\n' + html.slice(e);
}

/* Keep the first entry per source URL / title so near-identical stories the
   agent publishes on consecutive days do not repeat on the page. */
function dedupe(rows, keyFns, limit) {
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const keys = keyFns.map((f) => f(r)).filter(Boolean);
    if (keys.some((k) => seen.has(k))) continue;
    keys.forEach((k) => seen.add(k));
    out.push(r);
    if (out.length === limit) break;
  }
  return out;
}

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/* ── pre-flight on the current file ─────────────────────────────────────── */

let html = fs.readFileSync(FILE, 'utf8');

const feedEndLast = html.lastIndexOf(marker('FEED', 'END'));
const insightsStartFirst = html.indexOf(marker('INSIGHTS', 'START'));
if (feedEndLast === -1 || insightsStartFirst === -1 || feedEndLast > insightsStartFirst) {
  throw new Error(
    'FEED and INSIGHTS regions overlap or are missing — index.html needs a manual repair. Nothing written.'
  );
}

const strayBefore =
  countOf(html, marker('FEED', 'START')) + countOf(html, marker('FEED', 'END')) +
  countOf(html, marker('INSIGHTS', 'START')) + countOf(html, marker('INSIGHTS', 'END')) - 4;

/* ── fetch ──────────────────────────────────────────────────────────────── */

const [feedRows, articleRows, sources] = await Promise.all([
  sb('feed_entries?select=*&active=eq.true&order=published_at.desc&limit=60'),
  sb('insight_articles?select=*&active=eq.true&order=published_at.desc&limit=20'),
  sb('insight_sources?select=*&order=display_order.asc'),
]);

const entries = dedupe(feedRows, [(e) => e.source_url, (e) => norm(e.title)], FEED_LIMIT);
const articles = dedupe(articleRows, [(a) => norm(a.title)], ARTICLE_LIMIT);

if (!entries.length || !articles.length) {
  throw new Error(
    `Refusing to inject empty content (${entries.length} entries, ` +
      `${articles.length} articles). index.html left unchanged.`
  );
}

/* ── render ─────────────────────────────────────────────────────────────── */

const feedHtml = entries
  .map((e) => {
    const meta = e.source_url
      ? `<a href="${esc(e.source_url)}" target="_blank" rel="noopener" class="blog-source-link">${esc(e.source_name || e.source_url)}</a>`
      : esc(e.source_name || '');
    return `          <div class="hero-blog-entry">
            <span class="hero-blog-tag">${esc(e.category)}</span>
            <p class="hero-blog-title">${esc(e.title)}</p>
            <p class="hero-blog-snippet">${esc(e.snippet)}</p>
            <span class="hero-blog-meta">${meta}</span>
          </div>`;
  })
  .join('\n');

const insightsHtml = articles
  .map((a) => {
    const mine = sources
      .filter((s) => s.article_id === a.id)
      .sort((x, y) => (x.display_order ?? 0) - (y.display_order ?? 0));

    const sourcesHtml = mine.length
      ? `
        <div class="insight-sources">
          <span class="insight-sources-label">Sources</span>
          <div class="insight-source-links">
${mine
  .map(
    (s) =>
      `            <a href="${esc(s.source_url)}" target="_blank" rel="noopener" class="insight-source-link">${esc(s.source_name)}</a>`
  )
  .join('\n')}
          </div>
        </div>`
      : '';

    const body = String(a.body || '')
      .split('\n\n')
      .map((para) => para.trim())
      .filter(Boolean)
      .map((para) => `<p>${esc(para)}</p>`)
      .join('');

    return `      <div class="insight-card">
        <span class="insight-category">${esc(a.category)}</span>
        <h3 class="insight-title">${esc(a.title)}</h3>
        <div class="insight-body">${body}</div>${sourcesHtml}
      </div>`;
  })
  .join('\n');

/* ── write, then verify before committing to disk ──────────────────────── */

let out = replaceRegion(html, 'FEED', feedHtml);
out = replaceRegion(out, 'INSIGHTS', insightsHtml);

for (const name of ['FEED', 'INSIGHTS']) {
  for (const edge of ['START', 'END']) {
    const n = countOf(out, marker(name, edge));
    if (n !== 1) throw new Error(`Post-check failed: ${marker(name, edge)} appears ${n} times. Nothing written.`);
  }
}
for (const anchor of ['id="feedContainer"', 'id="insightsContainer"', 'id="erp-bridge"', '</html>']) {
  if (!out.includes(anchor)) throw new Error(`Post-check failed: ${anchor} missing. Nothing written.`);
}

fs.writeFileSync(FILE, out, 'utf8');

console.log(
  `Injected ${entries.length} feed entries and ${articles.length} insight articles into ${FILE}.` +
    (strayBefore > 0 ? ` Repaired ${strayBefore} stray marker(s) left by the previous injector.` : '')
);

/**
 * inject.js — build-time content injection
 *
 * Reads active feed entries and insight articles from Supabase and writes them
 * directly into index.html between the FEED and INSIGHTS marker comments.
 *
 * Runs in GitHub Actions after the content agent. The point is that the served
 * HTML contains the real content, so crawlers that do not execute JavaScript
 * (GPTBot, ClaudeBot, PerplexityBot, and Googlebot's first crawl wave) can read
 * it. No dependencies — Node 18+ has native fetch.
 *
 * Fails loudly and leaves index.html untouched if anything is wrong, so a bad
 * run can never blank the homepage. The last good injected content stays.
 */

import fs from 'node:fs';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const FILE = 'index.html';

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

function replaceBlock(html, name, content) {
  const re = new RegExp(`(<!-- ${name}:START -->)[\\s\\S]*?(<!-- ${name}:END -->)`);
  if (!re.test(html)) {
    throw new Error(`Marker ${name}:START/${name}:END not found in ${FILE}.`);
  }
  return html.replace(re, `$1\n${content}\n$2`);
}

/* ── fetch ──────────────────────────────────────────────────────────────── */

const [entries, articles, sources] = await Promise.all([
  sb('feed_entries?select=*&active=eq.true&order=published_at.desc&limit=10'),
  sb('insight_articles?select=*&active=eq.true&order=published_at.desc&limit=4'),
  sb('insight_sources?select=*&order=display_order.asc'),
]);

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

/* ── write ──────────────────────────────────────────────────────────────── */

let html = fs.readFileSync(FILE, 'utf8');
html = replaceBlock(html, 'FEED', feedHtml);
html = replaceBlock(html, 'INSIGHTS', insightsHtml);
fs.writeFileSync(FILE, html, 'utf8');

console.log(
  `Injected ${entries.length} feed entries and ${articles.length} insight articles into ${FILE}.`
);

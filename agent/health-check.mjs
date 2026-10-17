/**
 * health-check.mjs — daily health report for beneficialenterprisegroup.com
 *
 * Loads the LIVE site (not the repo) and checks it the way a visitor and a
 * crawler would see it. Writes a report to the GitHub Actions run summary.
 * Exits 1 if any check FAILS, so GitHub emails you. WARN items are reported
 * but do not fail the run.
 *
 * Every URL in the live sitemap.xml is checked, so new pages are covered
 * as soon as they are added to the sitemap.
 *
 * No dependencies — Node 18+.
 */

import fs from 'node:fs';

const SITE = (process.env.SITE_URL || 'https://beneficialenterprisegroup.com').replace(/\/$/, '');
const CANONICAL_HOST = 'https://beneficialenterprisegroup.com';
const FEED_MAX = Number(process.env.FEED_MAX || 4);
const INSIGHTS_MAX = Number(process.env.INSIGHTS_MAX || 4);
const SITEMAP_MIN = Number(process.env.SITEMAP_MIN || 7);
const AGENT_MAX_AGE_HOURS = Number(process.env.AGENT_MAX_AGE_HOURS || 26);

const results = []; // { status: 'PASS'|'WARN'|'FAIL', check, detail }
const pass = (check, detail = '') => results.push({ status: 'PASS', check, detail });
const warn = (check, detail = '') => results.push({ status: 'WARN', check, detail });
const fail = (check, detail = '') => results.push({ status: 'FAIL', check, detail });

/* Always bypass caches: we want what a visitor gets right now. */
async function get(url, method = 'GET') {
  const bust = `${url.includes('?') ? '&' : '?'}hc=${Date.now()}`;
  const t0 = Date.now();
  try {
    const res = await fetch(url + bust, {
      method,
      redirect: 'follow',
      headers: { 'Cache-Control': 'no-cache', 'User-Agent': 'BEG-HealthCheck/1.0' },
      signal: AbortSignal.timeout(20000),
    });
    const body = method === 'GET' ? await res.text() : '';
    return { status: res.status, body, ms: Date.now() - t0, type: res.headers.get('content-type') || '' };
  } catch (e) {
    return { status: 0, body: '', ms: Date.now() - t0, error: e.message };
  }
}

const count = (s, needle) => s.split(needle).length - 1;
const between = (s, a, b) => {
  const i = s.indexOf(a), j = s.lastIndexOf(b);
  return i === -1 || j === -1 || j < i ? '' : s.slice(i + a.length, j);
};
const decode = (s) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const strip = (s) => decode(s.replace(/<[^>]+>/g, '')).trim();

/* ── 1. Homepage ───────────────────────────────────────────────────────── */

const home = await get(`${SITE}/`);
if (home.status !== 200) {
  fail('Homepage loads', `HTTP ${home.status || 'no response'} ${home.error || ''}`.trim());
} else {
  pass('Homepage loads', `HTTP 200 in ${home.ms} ms`);
  const h = home.body;
  const kb = Math.round(h.length / 1024);

  if (home.ms > 5000) warn('Homepage speed', `${home.ms} ms (slow)`);
  // The clean page is well under 150 KB. The corrupted page ballooned past 300 KB.
  if (kb > 200) fail('Page size', `${kb} KB — far larger than normal. Content is likely duplicated.`);
  else pass('Page size', `${kb} KB`);

  // Markers: exactly one of each
  const m = {};
  for (const k of ['FEED:START', 'FEED:END', 'INSIGHTS:START', 'INSIGHTS:END']) m[k] = count(h, `<!-- ${k} -->`);
  if (Object.values(m).every((n) => n === 1)) pass('Content markers', 'one of each');
  else fail('Content markers', Object.entries(m).map(([k, n]) => `${k}=${n}`).join(', ') + ' — injector damage');

  // Feed
  const feed = between(h, '<!-- FEED:START -->', '<!-- FEED:END -->');
  const feedTitles = [...feed.matchAll(/<p class="hero-blog-title"[^>]*>([\s\S]*?)<\/p>/g)].map((x) => strip(x[1]));
  if (feedTitles.length === 0) warn('Hero feed', 'no stories — showing the placeholder. Check the Content Agent run.');
  else if (feedTitles.length > FEED_MAX) fail('Hero feed', `${feedTitles.length} stories (limit ${FEED_MAX})`);
  else pass('Hero feed', `${feedTitles.length} stories`);

  const norm = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const dupes = feedTitles.filter((t, i) => feedTitles.findIndex((u) => norm(u) === norm(t)) !== i);
  if (dupes.length) fail('Feed duplicates', `repeated: ${[...new Set(dupes)].join(' | ')}`);
  else if (feedTitles.length) pass('Feed duplicates', 'none');

  // Insights (heading level may change; match any h1–h6 with the class)
  const ins = between(h, '<!-- INSIGHTS:START -->', '<!-- INSIGHTS:END -->');
  const insTitles = [...ins.matchAll(/<h[1-6] class="insight-title"[^>]*>([\s\S]*?)<\/h[1-6]>/g)].map((x) => strip(x[1]));
  if (insTitles.length === 0) warn('Insights section', 'no articles — showing the placeholder');
  else if (insTitles.length > INSIGHTS_MAX) fail('Insights section', `${insTitles.length} articles (limit ${INSIGHTS_MAX})`);
  else pass('Insights section', `${insTitles.length} articles: ${insTitles.join(' | ')}`);

  // Stray comments inside content regions = the $-substitution bug returning
  if (feed.includes('<!--') || ins.includes('<!--')) fail('Stray markers in content', 'comment markers found inside content — injector bug');

  // SEO basics
  const title = (h.match(/<title>([\s\S]*?)<\/title>/) || [])[1];
  const desc = (h.match(/<meta name="description" content="([^"]*)"/) || [])[1];
  title ? pass('Title tag', `${decode(title).length} chars`) : fail('Title tag', 'missing');
  if (!desc) fail('Meta description', 'missing');
  else if (decode(desc).length > 160) warn('Meta description', `${decode(desc).length} chars (Google shows ~160)`);
  else pass('Meta description', `${decode(desc).length} chars`);
  h.includes('rel="canonical"') ? pass('Canonical tag') : fail('Canonical tag', 'missing');
  h.includes('application/ld+json') ? pass('Structured data (JSON-LD)') : fail('Structured data (JSON-LD)', 'missing');
  if (/<meta name="robots" content="[^"]*noindex/i.test(h)) fail('Indexable', 'page says noindex — Google will drop it');
  else pass('Indexable');

  // The client-side fetch was removed on purpose; if it comes back, crawlers lose the content again
  if (h.includes('supabaseFetch') || h.includes('Loading insights')) warn('Server-side content', 'client-side loading code is back in index.html');
}

/* ── 2. Sitemap: every listed page must load ───────────────────────────── */

const sm = await get(`${SITE}/sitemap.xml`);
if (sm.status !== 200) {
  fail('GET /sitemap.xml', `HTTP ${sm.status || 'no response'}`);
} else {
  const locs = [...sm.body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((x) => x[1]);
  if (locs.length < SITEMAP_MIN) warn('Sitemap', `${locs.length} URLs (expected at least ${SITEMAP_MIN}) — a page may have been dropped`);
  else pass('Sitemap', `${locs.length} URLs`);

  for (const loc of locs) {
    // Test against SITE so a local copy can be checked too
    const path = loc.replace(/^https?:\/\/(www\.)?beneficialenterprisegroup\.com/, '') || '/';
    if (path === '/') continue; // homepage checked above
    const r = await get(SITE + path);
    if (r.status !== 200) { fail(`GET ${path}`, `HTTP ${r.status || 'no response'}`); continue; }
    const t = strip((r.body.match(/<title>([\s\S]*?)<\/title>/) || [, ''])[1]);
    const canon = (r.body.match(/<link rel="canonical" href="([^"]+)"/) || [])[1];
    if (!t) warn(`GET ${path}`, 'HTTP 200 but no <title>');
    else if (canon && canon !== CANONICAL_HOST + path) warn(`GET ${path}`, `canonical points to ${canon}`);
    else pass(`GET ${path}`, `HTTP 200 · ${t.slice(0, 60)}`);
  }
}

/* ── 3. Other files ────────────────────────────────────────────────────── */

for (const path of ['/robots.txt', '/og-image.png', '/logo.png']) {
  const r = await get(SITE + path, path.endsWith('.png') ? 'HEAD' : 'GET');
  r.status === 200 ? pass(`GET ${path}`, 'HTTP 200') : fail(`GET ${path}`, `HTTP ${r.status || 'no response'}`);
}

// www should reach the same site
if (SITE.startsWith('https://')) {
  const www = await get(SITE.replace('://', '://www.') + '/');
  www.status === 200 ? pass('www address', 'HTTP 200') : warn('www address', `HTTP ${www.status || 'no response'}`);
}

// Contact form function should exist (a GET is refused with 405, but must not be 404)
const fn = await get(`${SITE}/.netlify/functions/contact`);
if (fn.status === 404 || fn.status === 0) warn('Contact form function', `HTTP ${fn.status || 'no response'} — form submissions may fail`);
else pass('Contact form function', `reachable (HTTP ${fn.status})`);

/* ── 4. Content agent freshness (needs GITHUB_TOKEN in Actions) ────────── */

if (process.env.GITHUB_TOKEN && process.env.GITHUB_REPOSITORY) {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/actions/workflows/content-agent.yml/runs?per_page=1&event=schedule`,
      { headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' } }
    );
    const run = (await res.json()).workflow_runs?.[0];
    if (!run) warn('Content Agent', 'no scheduled runs found');
    else {
      const hours = Math.round((Date.now() - new Date(run.created_at)) / 36e5);
      if (run.conclusion !== 'success') fail('Content Agent', `last scheduled run ${run.conclusion || run.status} (${hours}h ago) — ${run.html_url}`);
      else if (hours > AGENT_MAX_AGE_HOURS) warn('Content Agent', `last success ${hours}h ago`);
      else pass('Content Agent', `last scheduled run succeeded ${hours}h ago`);
    }
  } catch (e) {
    warn('Content Agent', `could not read run history: ${e.message}`);
  }
}

/* ── Report ────────────────────────────────────────────────────────────── */

const fails = results.filter((r) => r.status === 'FAIL').length;
const warns = results.filter((r) => r.status === 'WARN').length;
const icon = { PASS: '✅', WARN: '⚠️', FAIL: '❌' };
const verdict = fails ? `❌ UNHEALTHY — ${fails} failure(s), ${warns} warning(s)` : warns ? `⚠️ HEALTHY with ${warns} warning(s)` : '✅ HEALTHY';

const md = [
  `## Site health: ${SITE}`,
  `**${verdict}** · checked ${new Date().toISOString().replace('T', ' ').slice(0, 16)} UTC`,
  '',
  '| | Check | Detail |',
  '|---|---|---|',
  ...results.map((r) => `| ${icon[r.status]} | ${r.check} | ${String(r.detail).replace(/\|/g, '/')} |`),
].join('\n');

console.log(md);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n');
process.exit(fails ? 1 : 0);

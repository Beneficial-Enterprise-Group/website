/* ══════════════════════════════════════════════
   FEED DEDUPE — used by agent.js before inserting feed entries
   File location: agent/dedupe.js

   The agent searches the web daily and often finds the same story again,
   reworded or with a slightly different link. These helpers decide whether
   a new entry is the same story as one already published.

   An entry is a repeat if EITHER:
   - its source URL matches a recent one (ignoring protocol, www, trailing
     slash, #fragment and tracking parameters like utm_*), OR
   - its title shares most of its meaningful words with a recent title
     (word-overlap similarity >= TITLE_SIMILARITY), OR
   - it cites the same figures as a recent entry: SHARED_STATS or more of the
     same percentages, dollar amounts or decimals across title + snippet
     (years ignored). Reworded headlines for one study ("73% ... 215%")
     share few words but always share their numbers.
   ══════════════════════════════════════════════ */

export const TITLE_SIMILARITY = 0.6;
export const SHARED_STATS = 2;

const TRACKING_PARAM = /^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$|ref$|ref_src$|source$|_gl$)/i;

/* Common words that make unrelated headlines look alike */
const STOP = new Set(
  'a an and are as at be by for from has have how in into is it its of on or that the their this to was what when why will with without new report reports study shows says'
    .split(' ')
);

export function normUrl(url) {
  if (!url) return '';
  try {
    const u = new URL(String(url).trim());
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const params = [...u.searchParams.entries()]
      .filter(([k]) => !TRACKING_PARAM.test(k))
      .sort(([a], [b]) => a.localeCompare(b));
    const query = params.length ? '?' + new URLSearchParams(params).toString() : '';
    const path = u.pathname.replace(/\/+$/, '') || '/';
    return `${host}${path.toLowerCase()}${query}`;
  } catch {
    return String(url).trim().toLowerCase().replace(/^https?:\/\/(www\.)?/, '').replace(/[#?].*$/, '').replace(/\/+$/, '');
  }
}

export function titleWords(title) {
  return new Set(
    String(title ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9%$]+/g, ' ')
      .split(' ')
      .filter((w) => w && !STOP.has(w))
  );
}

/* Overlap relative to the shorter title, so a reworded or shortened
   headline for the same story still matches. */
export function titleSimilarity(a, b) {
  const A = titleWords(a), B = titleWords(b);
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return shared / Math.min(A.size, B.size);
}

/* Distinctive figures: 73%, $19, 19b, 5.42, 1,200 — not bare years like 2025 */
export function stats(text) {
  const out = new Set();
  for (const m of String(text ?? '').toLowerCase().matchAll(/\$?\d[\d,]*(?:\.\d+)?\s?(?:%|percent|[kmb]\b|billion|million|thousand)?/g)) {
    let tok = m[0].replace(/[,\s]/g, '').replace('percent', '%').replace('billion', 'b').replace('million', 'm').replace('thousand', 'k').replace(/^\$/, '');
    if (/^(19|20)\d\d$/.test(tok)) continue;           // a year
    if (/^\d$/.test(tok)) continue;                     // a lone digit ("3 ways")
    out.add(tok);
  }
  return out;
}

export function sharedStats(a, b) {
  const A = stats(a), B = stats(b);
  let n = 0;
  for (const x of A) if (B.has(x)) n++;
  return n;
}

/* Returns { fresh, skipped } — skipped items carry the reason.
   Also removes repeats within the new batch itself. */
export function filterNewEntries(entries, recent) {
  const seenUrls = new Set(recent.map((r) => normUrl(r.source_url)).filter(Boolean));
  const seen = recent.filter((r) => r.title).map((r) => ({ title: r.title, text: `${r.title} ${r.snippet ?? ''}` }));
  const fresh = [], skipped = [];

  for (const e of entries) {
    const url = normUrl(e.source_url);
    let reason = null;
    if (url && seenUrls.has(url)) reason = 'same source URL as a recent entry';
    else {
      const text = `${e.title} ${e.snippet ?? ''}`;
      const byTitle = seen.find((r) => titleSimilarity(e.title, r.title) >= TITLE_SIMILARITY);
      const byStats = !byTitle && seen.find((r) => sharedStats(text, r.text) >= SHARED_STATS);
      if (byTitle) reason = `title too close to "${byTitle.title}"`;
      else if (byStats) reason = `cites the same figures as "${byStats.title}"`;
    }
    if (reason) { skipped.push({ title: e.title, reason }); continue; }
    fresh.push(e);
    if (url) seenUrls.add(url);
    seen.push({ title: e.title, text: `${e.title} ${e.snippet ?? ''}` });
  }
  return { fresh, skipped };
}

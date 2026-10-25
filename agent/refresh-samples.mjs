/**
 * refresh-samples.mjs — regenerate the supplier recovery demo's sample CSVs
 *
 * The demo builds its sample data relative to today, so its deadlines and
 * dispute windows always look current. The downloadable CSVs are a snapshot
 * of that data; this script retakes the snapshot. It runs monthly from
 * .github/workflows/refresh-samples.yml.
 *
 * The generator is read straight out of the demo page, so the files always
 * match what "Load sample data" shows. There is no second copy to drift.
 *
 * Usage:   node agent/refresh-samples.mjs
 * Testing: SAMPLE_DATE=2026-12-01 node agent/refresh-samples.mjs
 * No dependencies — Node 18+.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const demoDir = path.join(root, 'products', 'vendor-compliance', 'demo');
const html = fs.readFileSync(path.join(demoDir, 'index.html'), 'utf8');

/* Pull the pure pieces of the page's script by their markers. Fail loudly if
   the page has been restructured, rather than writing wrong files. */
function slice(startMarker, endMarker) {
  const i = html.indexOf(startMarker);
  const j = html.indexOf(endMarker, i + startMarker.length);
  if (i === -1 || j === -1) throw new Error(`Marker not found in demo page: "${startMarker}" … "${endMarker}"`);
  return html.slice(i, j);
}
const helpers = slice('const DAY=86400000;', 'function parseBool(');        // DAY, TODAY, date and number helpers
const rngLine = slice('function rng(seed)', 'function parseCSV(');          // seeded random generator
const samples = slice('function sampleDeductions()', '/* ---------- state ---------- */');

/* Optional fixed date for testing; otherwise today (UTC on GitHub Actions). */
let todayExpr = '';
if (process.env.SAMPLE_DATE) {
  const t = Date.parse(process.env.SAMPLE_DATE + 'T00:00:00Z');
  if (Number.isNaN(t)) throw new Error('SAMPLE_DATE must be YYYY-MM-DD');
  todayExpr = `TODAY=${Math.floor(t / 86400000)};`;
}

const build = new Function(`
  ${helpers.replace('const TODAY=', 'let TODAY=')}
  ${todayExpr}
  ${rngLine}
  ${samples}
  return { deductions: sampleDeductions(), payables: samplePayables(), today: TODAY };
`);
const { deductions, payables, today } = build();

const cell = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const toCSV = (d) => [d.headers.map(cell).join(',')].concat(d.rows.map((r) => d.headers.map((h) => cell(r[h])).join(','))).join('\n') + '\n';

const outputs = [
  ['sample-deductions.csv', toCSV(deductions), deductions.rows.length],
  ['sample-ap-payments.csv', toCSV(payables), payables.rows.length],
  ['template-deductions.csv', deductions.headers.map(cell).join(',') + '\n', 0],
  ['template-ap-payments.csv', payables.headers.map(cell).join(',') + '\n', 0],
];

/* The page's download links advertise row counts; stop if they no longer hold. */
const labels = [...html.matchAll(/sampleLabel:'[^']*\((\d+) rows\)'/g)].map((m) => Number(m[1]));
if (labels.length === 2 && (labels[0] !== deductions.rows.length || labels[1] !== payables.rows.length)) {
  throw new Error(`Row counts changed (${deductions.rows.length}, ${payables.rows.length}) but the page says (${labels.join(', ')}). Update the sampleLabel text in the demo.`);
}

fs.mkdirSync(path.join(demoDir, 'samples'), { recursive: true });
for (const [name, text, rows] of outputs) {
  fs.writeFileSync(path.join(demoDir, 'samples', name), text);
  console.log(`wrote samples/${name}${rows ? ` (${rows} rows)` : ' (header only)'}`);
}
console.log(`Sample dates anchored to ${new Date(today * 86400000).toISOString().slice(0, 10)}`);

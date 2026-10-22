#!/usr/bin/env node
// Run the classifier on the labelled sample (names only, value unknown) and write results.json and results.md.
//   node benchmarks/run.js [labels.jsonl] [label]
// The labels file must be committed before this is run on it: that ordering is the pre-registration.

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify, loadRules } from '../skills/apikeys-handler/scripts/classify.js';

const here = dirname(fileURLToPath(import.meta.url));
const file = process.argv[2] || 'labels.jsonl';
const tag = process.argv[3] || 'first';
const labels = readFileSync(join(here, file), 'utf8').trim().split('\n').map(JSON.parse);
const counts = JSON.parse(readFileSync(join(here, 'names.json'), 'utf8'));
const rules = loadRules();
const pct = (a, b) => (b ? Math.round(1000 * a / b) / 10 : 0);

const rows = labels.map(l => {
  const c = classify(l.name, null, rules);
  const marked = c.how !== 'none' && c.priority !== 'P3';
  return { name: l.name, repos: counts[l.name] || 1, secret: l.secret, labelCategory: l.category || null, marked, category: c.category, priority: c.priority, how: c.how, rule: c.rule };
});
const secrets = rows.filter(r => r.secret), marked = rows.filter(r => r.marked);
const tp = secrets.filter(r => r.marked);
const fp = marked.filter(r => !r.secret);
const fn = secrets.filter(r => !r.marked);
const catRight = tp.filter(r => r.category === r.labelCategory);
const w = (xs) => xs.reduce((n, r) => n + r.repos, 0);
const out = {
  tag, labelsFile: file, names: rows.length, secrets: secrets.length, marked: marked.length,
  recall: pct(tp.length, secrets.length), precision: pct(tp.length, marked.length),
  weightedRecall: pct(w(tp), w(secrets)), categoryAccuracy: pct(catRight.length, tp.length),
  truePositives: tp.length, falsePositives: fp.length, falseNegatives: fn.length,
  misses: fn.map(r => ({ name: r.name, labelled: r.labelCategory, classifiedAs: `${r.category}/${r.priority}`, rule: r.rule })),
  falseAlarms: fp.map(r => ({ name: r.name, classifiedAs: `${r.category}/${r.priority}`, rule: r.rule })),
  wrongCategory: tp.filter(r => r.category !== r.labelCategory).map(r => ({ name: r.name, labelled: r.labelCategory, classifiedAs: r.category, rule: r.rule })),
  howCounts: Object.fromEntries(['generate', 'provider', 'manual', 'none'].map(h => [h, rows.filter(r => r.how === h).length])),
};
writeFileSync(join(here, `results.${tag}.json`), JSON.stringify(out, null, 1) + '\n');

const L = [`# Classifier benchmark (${tag})`, '', `Labels: \`${file}\`, ${out.names} names, ${out.secrets} labelled secret. Names only, value unknown. Method: [method.md](../skills/apikeys-handler/references/method.md).`, ''];
L.push('| Metric | Result |', '|---|---|');
L.push(`| Secret recall (labelled secret that the classifier marks P0 to P2) | **${out.recall}%** (${tp.length} of ${secrets.length}) |`);
L.push(`| Popularity-weighted recall | ${out.weightedRecall}% |`);
L.push(`| Secret precision (marked for rotation that is a secret) | **${out.precision}%** (${tp.length} of ${marked.length}) |`);
L.push(`| Category accuracy (among correctly marked secrets) | **${out.categoryAccuracy}%** (${catRight.length} of ${tp.length}) |`, '');
L.push(`How the ${out.names} names were classified: generate ${out.howCounts.generate} · provider ${out.howCounts.provider} · manual ${out.howCounts.manual} · config (not rotated) ${out.howCounts.none}.`, '');
const table = (title, xs, cols) => { if (!xs.length) return; L.push(`## ${title} (${xs.length})`, '', `| ${cols.join(' | ')} |`, `|${cols.map(() => '---').join('|')}|`); for (const x of xs) L.push(`| ${cols.map(c => x[c] ?? '').join(' | ')} |`); L.push(''); };
table('Missed secrets', out.misses, ['name', 'labelled', 'classifiedAs', 'rule']);
table('False alarms', out.falseAlarms, ['name', 'classifiedAs', 'rule']);
table('Wrong category', out.wrongCategory, ['name', 'labelled', 'classifiedAs', 'rule']);
writeFileSync(join(here, `results.${tag}.md`), L.join('\n'));
console.log(L.slice(0, 12).join('\n'));
console.log(`misses ${fn.length}, false alarms ${fp.length}, wrong category ${out.wrongCategory.length}`);

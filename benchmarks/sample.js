#!/usr/bin/env node
// Draw a benchmark sample of unique variable names, uniformly without replacement, with a fixed seed.
//   node benchmarks/sample.js                                  first sample: 200 names, seed 20261022 -> sample.txt
//   node benchmarks/sample.js 100 20261023 sample2.txt sample.txt   holdout: 100 names, another seed, none from sample.txt
// The output has names only: no labels, no classifier output.

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const [count = '200', seed = '20261022', out = 'sample.txt', exclude = null] = process.argv.slice(2);
const skip = new Set(exclude ? readFileSync(join(here, exclude), 'utf8').split('\n').filter(Boolean) : []);
const names = Object.keys(JSON.parse(readFileSync(join(here, 'names.json'), 'utf8'))).filter(n => !skip.has(n));

function mulberry32(a) {
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const rnd = mulberry32(Number(seed));
const pool = [...names];
const pick = [];
for (let i = 0; i < Number(count) && pool.length; i++) pick.push(pool.splice(Math.floor(rnd() * pool.length), 1)[0]);
pick.sort();
writeFileSync(join(here, out), pick.join('\n') + '\n');
console.log(`sampled ${pick.length} of ${names.length} unique names -> ${out}`);

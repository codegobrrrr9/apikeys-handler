#!/usr/bin/env node
// Draw the benchmark sample: 200 unique variable names, uniformly without replacement, fixed seed.
//   node benchmarks/sample.js    writes benchmarks/sample.txt (one name per line, no labels, no classifier output)

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const names = Object.keys(JSON.parse(readFileSync(join(here, 'names.json'), 'utf8')));

function mulberry32(a) {
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const rnd = mulberry32(20261022);
const pool = [...names];
const pick = [];
for (let i = 0; i < 200 && pool.length; i++) pick.push(pool.splice(Math.floor(rnd() * pool.length), 1)[0]);
pick.sort();
writeFileSync(join(here, 'sample.txt'), pick.join('\n') + '\n');
console.log(`sampled ${pick.length} of ${names.length} unique names`);

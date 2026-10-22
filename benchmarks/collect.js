#!/usr/bin/env node
// Collect variable NAMES from public .env.example files of popular repositories. Names only: values are placeholders
// and are not read into the output. Uses the GitHub CLI (`gh`) for authenticated API calls; results are cached.
//   node benchmarks/collect.js            writes benchmarks/names.json (name -> number of repos) and benchmarks/repos.json

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const work = join(here, 'work');
mkdirSync(work, { recursive: true });
const GH = process.env.GH_BIN || (process.platform === 'win32' ? 'C:\\Program Files\\GitHub CLI\\gh.exe' : 'gh');

function gh(args) {
  const r = spawnSync(GH, ['api', ...args], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  if (r.status !== 0) return null;
  try { return JSON.parse(r.stdout); } catch { return null; }
}

const TOPICS = ['nextjs', 'laravel', 'django', 'express', 'nestjs', 'fastapi', 'rails', 'supabase', 'saas', 'discord-bot', 'telegram-bot', 'chatbot', 'self-hosted', 'docker-compose', 'wordpress', 'symfony', 'strapi', 'directus', 'nuxt', 'sveltekit'];
const FILES = ['.env.example', '.env.sample', '.env.template', '.env.local.example', 'example.env', '.env.dist'];

const cacheFile = join(work, 'repos-cache.json');
const cache = existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, 'utf8')) : { repos: null, files: {} };

if (!cache.repos) {
  const seen = new Map();
  for (const t of TOPICS) {
    const d = gh([`search/repositories?q=topic:${t}+stars:>500&sort=stars&order=desc&per_page=25`]);
    for (const r of d?.items || []) if (!r.fork && !r.archived) seen.set(r.full_name, r.stargazers_count);
    spawnSync(process.execPath, ['-e', 'setTimeout(()=>{}, 2200)']);       // search API: 30 requests a minute
  }
  cache.repos = [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([name, stars]) => ({ name, stars }));
  writeFileSync(cacheFile, JSON.stringify(cache));
}

const names = new Map();                                                  // NAME -> set of repos
const used = [];
for (const r of cache.repos) {
  if (!(r.name in cache.files)) {
    let text = null;
    for (const f of FILES) {
      const d = gh([`repos/${r.name}/contents/${f}`]);
      if (d?.content) { text = Buffer.from(d.content, 'base64').toString('utf8'); break; }
    }
    cache.files[r.name] = text === null ? null : text.split(/\r?\n/).map(l => { const m = l.match(/^\s*#?\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/); return m ? m[1] : null; }).filter(Boolean);
    writeFileSync(cacheFile, JSON.stringify(cache));
  }
  const list = cache.files[r.name];
  if (!list) continue;
  used.push({ name: r.name, stars: r.stars, variables: new Set(list).size });
  for (const n of new Set(list)) (names.get(n) || names.set(n, new Set()).get(n)).add(r.name);
}
const out = Object.fromEntries([...names.entries()].sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0])).map(([n, s]) => [n, s.size]));
writeFileSync(join(here, 'names.json'), JSON.stringify(out, null, 1) + '\n');
writeFileSync(join(here, 'repos.json'), JSON.stringify({ collectedAt: new Date().toISOString(), topics: TOPICS, files: FILES, repos: used }, null, 1) + '\n');
console.log(`repos searched ${cache.repos.length}, with an example env file ${used.length}, unique variable names ${Object.keys(out).length}`);

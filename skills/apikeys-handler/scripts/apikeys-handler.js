#!/usr/bin/env node
// apikeys-handler: rotate every API key and secret after a breach, in order, from one place.
//   apikeys-handler scan   [--platform railway,dotenv,netlify,cloudflare,supabase] [--exposed web,worker] [--json]
//   apikeys-handler plan   [selection]            dry run: what would be rotated, in what order, how many requests
//   apikeys-handler rotate [selection] --apply    rotate; generated values are made here, third-party keys are pasted by you
//   apikeys-handler status | report [--out file] | ui [--port n] | demo
// selection: --name A,B  --priority P0  --up-to P1  --category Database,Payments  --service web,api  --include-config  --again
// Values are never printed and never stored. Tokens come from your environment: RAILWAY_API_TOKEN (account or
// workspace token) or RAILWAY_TOKEN (project token), NETLIFY_AUTH_TOKEN, CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID,
// SUPABASE_ACCESS_TOKEN. Pre-supply a new value with AKH_NEW_<VARIABLE_NAME> in your own terminal.

import { realpathSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { redact, registerSecret, defaultRules, loadRules } from './classify.js';
import { inventory, buildPlan, rotate, loadState, reportMarkdown, summarize, findSplits, markSeen } from './engine.js';
import { railwayAdapter } from './railway.js';
import { dotenvAdapter } from './dotenv.js';

const out = (s = '') => process.stdout.write(redact(s) + '\n');
const err = (s = '') => process.stderr.write(redact(s) + '\n');

export function parseArgs(argv) {
  const a = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith('--')) {
      const k = t.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) a.flags[k] = true; else { a.flags[k] = next; i++; }
    } else a._.push(t);
  }
  return a;
}
const list = (v) => (typeof v === 'string' ? v.split(',').map(s => s.trim()).filter(Boolean) : null);

export function selectionFrom(flags) {
  const sel = {};
  if (flags.name) sel.names = list(flags.name);
  if (flags.priority) sel.priority = String(flags.priority).toUpperCase();
  if (flags['up-to']) sel.upTo = String(flags['up-to']).toUpperCase();
  if (flags.category) sel.categories = list(flags.category);
  if (flags.service) sel.services = list(flags.service);
  if (flags['include-config']) sel.includeConfig = true;
  if (flags.again) sel.again = true;
  return sel;
}

export async function makeAdapters(flags, env = process.env) {
  const dir = resolve(flags.dir || '.');
  const want = list(flags.platform) || (env.RAILWAY_API_TOKEN || env.RAILWAY_TOKEN ? ['railway'] : ['dotenv']);
  const adapters = [];
  for (const p of want) {
    if (p === 'railway') {
      const token = env.RAILWAY_API_TOKEN || env.RAILWAY_TOKEN;
      const tokenType = flags['token-type'] || (env.RAILWAY_API_TOKEN ? 'account' : 'project');
      if (token) registerSecret(token);
      adapters.push(railwayAdapter({ token, tokenType, endpoint: env.RAILWAY_ENDPOINT || undefined, workspaceId: flags.workspace || env.RAILWAY_WORKSPACE_ID || null, project: flags.project || null, environment: flags.environment || null }));
    } else if (p === 'dotenv') adapters.push(dotenvAdapter({ dir, includeExamples: !!flags['include-examples'] }));
    else if (['netlify', 'cloudflare', 'supabase'].includes(p)) {
      const hosts = await import('./hosts.js');
      adapters.push(hosts.makeHostAdapter(p, { env, flags }));
    } else throw new Error(`unknown platform "${p}". Try railway, dotenv, netlify, cloudflare or supabase.`);
  }
  return adapters;
}

// ---------- output ----------
const pad = (s, n) => String(s).padEnd(n).slice(0, Math.max(n, String(s).length));
function printScan(items, warnings, flags) {
  const live = items.filter(i => !i.derived && !i.empty && i.how !== 'none' && i.priority !== 'P3');
  const counts = { P0: 0, P1: 0, P2: 0 };
  for (const i of live) counts[i.priority]++;
  out(`apikeys-handler scan  ·  ${items.length} variables  ·  ${live.length} to rotate  (P0 ${counts.P0} · P1 ${counts.P1} · P2 ${counts.P2})  ·  values are never printed`);
  const byUnit = new Map();
  for (const i of items) { const k = `${i.platform} · ${i.project} · ${i.environment} · ${i.service ?? '(shared)'}`; (byUnit.get(k) || byUnit.set(k, []).get(k)).push(i); }
  for (const [unit, rows] of byUnit) {
    out('\n' + unit);
    rows.sort((a, b) => a.priority.localeCompare(b.priority) || a.name.localeCompare(b.name));
    for (const i of rows) {
      const tag = i.derived ? 'derived' : i.empty ? 'empty' : i.how;
      const users = [...new Set(i.usedBy.map(u => u.service))].filter(s => s !== i.service);
      const used = (users.length ? `  used by ${users.join(', ')}` : '') + ((i.links || []).length ? `  same secret as ${i.links.map(l => l.name + ' (' + (l.service ?? 'shared') + ')').join(', ')}` : '');
      const exp = (i.exposed === true ? '  EXPOSED' : '') + (i.seen ? '  SEEN BY AGENT' : '');
      out(`  ${i.priority}  ${pad(i.category, 22)} ${pad(i.name, 30)} ${pad(tag, 9)}${flags['no-fp'] || !i.fp ? '' : ' fp ' + i.fp}${used}${exp}`);
    }
  }
  for (const w of warnings) err('warning: ' + w);
}

function printPlan(plan, apply) {
  const e = plan.estimate;
  out(`apikeys-handler plan  ·  ${plan.groups.length} rotations  ·  P0 ${plan.counts.P0} · P1 ${plan.counts.P1} · P2 ${plan.counts.P2}  ·  ${e.writes} writes + ${e.redeploys} restarts = ${e.total} requests`);
  for (const g of plan.groups) {
    out(`\n${g.priority}  ${pad(g.category, 22)} ${g.names.join(', ')}  [${g.how}]  ${g.services.join(', ')}${g.exposed ? '  EXPOSED' : ''}${g.seen ? '  SEEN BY AGENT' : ''}${g.items.length > 1 ? `  (${g.items.length} places, one value)` : ''}`);
    if (g.link) out(`    new key: ${g.link}`);
    for (const w of g.warns) out(`    ! ${w}`);
  }
  const named = plan.units.filter(u => u.label !== '(environment)');
  if (named.length) out(`\nrestart order: ${named.map(u => u.label).join(' → ')}`);
  if (plan.skipped.length) { out(`\nskipped ${plan.skipped.length}:`); for (const s of plan.skipped.slice(0, 25)) out(`  ${s.service ?? '(shared)'} ${s.name}: ${s.reason}`); if (plan.skipped.length > 25) out(`  … ${plan.skipped.length - 25} more`); }
  if (!apply) out('\nDry run: nothing was written. Add --apply to rotate.');
}

// ---------- asking for a new value ----------
export function askSecret(prompt) {
  return new Promise((res) => {
    const stdin = process.stdin;
    process.stderr.write(prompt);
    let buf = '';
    stdin.setRawMode?.(true); stdin.resume(); stdin.setEncoding('utf8');
    const done = (v) => { stdin.setRawMode?.(false); stdin.pause(); stdin.removeListener('data', onData); process.stderr.write('\n'); res(v); };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return done(buf);
        if (ch === '\u0003') { process.stderr.write('\n'); process.exit(130); }
        if (ch === '\u007f' || ch === '\b') { buf = buf.slice(0, -1); continue; }
        if (ch >= ' ') buf += ch;
      }
    };
    stdin.on('data', onData);
  });
}

// AKH_NEW_<NAME> supplies a new value by variable name. A name can appear in several groups (production and staging both have
// STRIPE_SECRET_KEY, and they must not get the same value), so the plain form is used only when exactly one group in the plan
// carries the name; otherwise it is refused and AKH_NEW_<NAME>__<ENVIRONMENT> is needed.
export function provider(flags, plan, env = process.env, warn = (m) => err(m)) {
  const counts = new Map();
  for (const g of plan?.groups || []) for (const n of g.names) counts.set(n, (counts.get(n) || 0) + 1);
  const slug = (e) => String(e).toUpperCase().replace(/[^A-Z0-9]/g, '_');
  return async (g) => {
    const envs = [...new Set(g.items.map(i => i.environment))];
    for (const n of g.names) {
      for (const e of envs) { const v = env[`AKH_NEW_${n}__${slug(e)}`]; if (v) return v; }
      const plain = env['AKH_NEW_' + n];
      if (!plain) continue;
      if ((counts.get(n) || 0) <= 1) return plain;
      warn(`AKH_NEW_${n} is ambiguous: ${counts.get(n)} groups in this plan carry that name (environments: ${envs.join(', ')}). Set AKH_NEW_${n}__<ENVIRONMENT> (for example AKH_NEW_${n}__${slug(envs[0])}) or pass --environment. Not used.`);
    }
    if (!process.stdin.isTTY) return null;
    out(`\n${g.names.join(', ')}  [${g.priority} ${g.category}]  used in ${g.services.join(', ')}`);
    if (g.link) out(`  create the new key here: ${g.link}`);
    for (const w of g.warns) out(`  ! ${w}`);
    const v = await askSecret('  paste the new value (empty to skip, input hidden): ');
    return v.trim() || null;
  };
}

// ---------- main ----------
export async function main(argv) {
  const a = parseArgs(argv);
  const cmd = a._[0];
  const f = a.flags;
  if (!cmd || cmd === 'help' || f.help || f.h) { out(readHelp()); return 0; }
  const dir = resolve(f.dir || '.');
  if (cmd === 'status') {
    const s = loadState(dir);
    const t = summarize(s);
    out(`apikeys-handler  ·  ${t.total} tracked  ·  verified ${t.verified}  ·  written ${t.written}  ·  restarted ${t.redeployed}  ·  failed ${t.failed}  ·  staged ${t.staged}`);
    for (const i of Object.values(s.items).filter(i => i.status !== 'verified')) out(`  ${i.status.padEnd(10)} ${i.priority} ${i.name} (${i.service ?? 'shared'})${i.error ? ': ' + i.error : ''}`);
    for (const [k, d] of Object.entries(s.deploys).filter(([, d]) => d.status === 'manual')) out(`  restart by hand: ${d.hint}`);
    for (const sp of findSplits(s)) out(`  !! SPLIT SECRET ${sp.names.join(', ')}: ${sp.newValue.join(', ')} has the NEW value, ${sp.oldValue.join(', ')} still has the OLD one. Rerun the rotation for it.`);
    return t.failed ? 1 : 0;
  }
  if (cmd === 'ui' || cmd === 'demo') {
    const { startUi } = await import('./server.js');
    return startUi({ demo: cmd === 'demo', flags: f, dir, makeAdapters, out });
  }
  if (!['scan', 'plan', 'rotate', 'report'].includes(cmd)) { err(`unknown command "${cmd}". Run apikeys-handler help.`); return 2; }

  const adapters = await makeAdapters(f);
  const exposed = list(f.exposed) || [];
  const { items, warnings } = await inventory(adapters, { exposed, rules: loadRules(dir) });
  if (f.seen) {
    // fingerprints from `agent-residue seen`: secrets your agent has already seen are rotated first
    let seenFile; try { seenFile = JSON.parse(readFileSync(resolve(String(f.seen)), 'utf8')); } catch { err('apikeys-handler: could not read the --seen file (expected the JSON from `agent-residue seen`).'); return 2; }
    const n = markSeen(items, (seenFile.items || []).map(x => x.fp).filter(Boolean));
    err(`seen: ${n} variables match secrets your agent has seen (keyed fingerprints, no values).`);
  }
  const state = loadState(dir);

  if (cmd === 'scan') {
    if (f.json) out(JSON.stringify({ items: items.map(publicItem), warnings }, null, 2)); else printScan(items, warnings, f);
    return 0;
  }
  if (cmd === 'report') {
    const md = reportMarkdown(items, state, { exposed });
    if (f.out) { writeFileSync(resolve(f.out), md); out(`report written to ${f.out}`); } else process.stdout.write(redact(md));
    return 0;
  }
  const sel = selectionFrom(f);
  const byId = Object.fromEntries(adapters.map(x => [x.id, x]));
  if (cmd === 'plan' || (cmd === 'rotate' && !f.apply)) {
    const plan = buildPlan(items, byId, sel, state);
    if (f.json) out(JSON.stringify(publicPlan(plan), null, 2)); else printPlan(plan, false);
    for (const w of warnings) err('warning: ' + w);
    return 0;
  }
  // rotate --apply
  const plan = buildPlan(items, byId, sel, state);
  if (!plan.groups.length) { out('nothing to rotate for this selection.'); return 0; }
  printPlan(plan, true);
  if (!f.yes) {
    if (!process.stdin.isTTY) { err('\nrefusing to write without a person: run this in a terminal, or pass --yes after the user approved the plan above.'); return 2; }
    const ans = await new Promise((r) => { process.stdout.write(`\nRotate ${plan.groups.length} secrets now? Type yes: `); process.stdin.setEncoding('utf8'); process.stdin.once('data', d => { process.stdin.pause(); r(String(d).trim().toLowerCase()); }); });
    if (ans !== 'yes') { out('cancelled, nothing written.'); return 0; }
  }
  const res = await rotate(items, adapters, { apply: true, dir, exposed, sel, provide: provider(f, plan), log: err });
  out(`\ndone  ·  written ${res.written.length}  ·  restarted ${res.redeployed.length}  ·  verified ${res.verified.length}  ·  failed ${res.failed.length}  ·  skipped ${res.skippedGroups.length}`);
  for (const g of res.skippedGroups) out(`  skipped ${g.names.join(', ')}: ${g.reason}`);
  for (const x of res.failed) out(`  FAILED ${x.id}: ${x.error}`);
  for (const m of res.manualRedeploys) out(`  restart by hand (${m.unit}): ${m.hint}`);
  for (const u of res.unverified) out(`  unverified ${u.id}: ${u.why}`);
  for (const s of res.splits) out(`
  !! SPLIT SECRET ${s.names.join(', ')}: ${s.newValue.join(', ')} has the NEW value, ${s.oldValue.join(', ')} still has the OLD one. They must match. Rerun the same command to rewrite all of them with one value.`);
  out('\nStill yours to do: delete or revoke the OLD keys at each provider, and change database passwords in the database itself. A verified status means the platform variable changed, not that the old secret is dead.');
  return res.failed.length ? 1 : 0;
}

function publicItem(i) {
  const { value, scope, adapter, ...rest } = i;
  return rest;
}
function publicPlan(p) {
  return { ...p, groups: p.groups.map(g => ({ ...g, items: g.items.map(publicItem) })), writes: p.writes.map(({ scope, ...r }) => r), units: p.units.map(({ scope, ...r }) => r) };
}

function readHelp() {
  const here = fileURLToPath(import.meta.url);
  return `apikeys-handler: rotate every API key and secret after a breach, in order, from one place.

  scan    list every variable by service with category and priority (never values)
  plan    dry run: rotations in order, new-key links, warnings, request count
  rotate  --apply: generated values are made here; third-party keys are pasted by you (hidden prompt)
  status  progress of the current rotation (survives a restart)     report [--out file.md]
  ui      local dashboard on 127.0.0.1                              demo  the dashboard on made-up data

flags: --platform railway,dotenv,netlify,cloudflare,supabase  --dir .  --project P  --environment E
       --exposed web,worker   (everything those services can read goes first)
       --name A,B  --priority P0  --up-to P1  --category Database  --service web  --include-config  --again
       --yes (skip the confirmation, only after the person approved the plan)  --json

Nothing here patches a vulnerable runtime. Patch first, then rotate.  (${here.split(/[\\/]/).slice(-3).join('/')})`;
}

const samePath = (a, b) => { try { return realpathSync(a) === realpathSync(b); } catch { return a === b; } };
const isMain = process.argv[1] && samePath(fileURLToPath(import.meta.url), resolve(process.argv[1]));
if (isMain) {
  main(process.argv.slice(2)).then(code => { if (code !== undefined) process.exitCode = code; }).catch(e => { err('apikeys-handler: ' + (e && e.message ? e.message : e)); process.exitCode = 1; });
}

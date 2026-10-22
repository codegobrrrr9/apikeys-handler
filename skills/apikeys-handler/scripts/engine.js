// Inventory, planning, rotation and state. The engine never prints a value and never writes one to disk.
// State holds names, categories, priorities, statuses, timestamps and keyed-hash fingerprints.

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { classify, defaultRules, fingerprint, credentialOf, generateSecret, referencesIn, registerSecret, redact, priorityRank } from './classify.js';

const STATE_DIR = '.apikeys-handler';
const sha8 = (s) => createHash('sha1').update(String(s)).digest('hex').slice(0, 8);
const HOW_RANK = { manual: 0, provider: 1, generate: 2, none: 3 };
const PRI = ['P0', 'P1', 'P2', 'P3'];

// ---------- inventory ----------
export const itemId = (i) => [i.platform, i.project, i.environment, i.service ?? '(shared)', i.name].join('|');
const sourceKey = (platform, project, environment, service, name) => [platform, project, environment, service ?? '(shared)', name].join('|');

export async function inventory(adapters, { exposed = [], rules = defaultRules() } = {}) {
  const items = [];
  const warnings = [];
  for (const a of adapters) {
    const raw = await a.list();
    for (const w of a.warnings || []) warnings.push(w);
    for (const r of raw) {
      const known = typeof r.value === 'string';
      const c = classify(r.name, known ? r.value : null, rules);
      // only secrets are scrubbed from output: registering "production" or "3000" would mangle every line that mentions them
      if (known && !c.derived && (c.how !== 'none' || c.category !== 'Config')) registerSecret(r.value);
      const item = {
        adapter: a.id, platform: r.platform || a.id, project: r.project, environment: r.environment, service: r.service ?? null,
        shared: !!r.shared, name: r.name, scope: r.scope, value: known ? r.value : null, unreadable: !known,
        category: c.category, basePriority: c.priority, how: c.how, provider: c.provider, link: c.link, warn: c.warn, note: c.note || null,
        rule: c.rule, derived: c.derived, empty: c.empty, fp: c.derived ? null : fingerprint(known ? r.value : null),
        refs: c.derived || (known && /\$\{/.test(r.value)) ? referencesIn(r.value) : [], usedBy: [],
      };
      item.id = itemId(item);
      items.push(item);
    }
  }
  const index = new Map(items.map(i => [sourceKey(i.platform, i.project, i.environment, i.service, i.name), i]));
  for (const i of items) {
    for (const ref of i.refs) {
      const svc = ref.scope === null ? i.service : (ref.scope.toLowerCase() === 'shared' ? null : ref.scope);
      const src = index.get(sourceKey(i.platform, i.project, i.environment, svc, ref.name));
      if (src && src !== i && i.service && !src.usedBy.some(u => u.service === i.service)) src.usedBy.push({ service: i.service, scope: i.scope });
    }
  }
  // A URL such as redis://:pw@host holds a password that may also sit in its own variable (REDIS_PASSWORD). Rotating one
  // does not change the other, so say so: the two must change together.
  const byFp = new Map();
  for (const i of items) if (i.fp && !i.derived && !credentialOf(i.value)) (byFp.get(i.fp) || byFp.set(i.fp, []).get(i.fp)).push(i);
  for (const i of items) i.links = [];
  for (const i of items) {
    const cred = i.derived ? null : credentialOf(i.value);
    if (!cred) continue;
    registerSecret(cred);
    for (const o of byFp.get(fingerprint(cred)) || []) { i.links.push({ name: o.name, service: o.service }); (o.links ||= []).push({ name: i.name, service: i.service }); }
  }
  const exp = new Set(exposed.map(s => s.trim().toLowerCase()).filter(Boolean));
  for (const i of items) {
    const svcs = String(i.service || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    i.exposed = exp.size === 0 ? null : svcs.some(s => exp.has(s)) || i.usedBy.some(u => exp.has(String(u.service).toLowerCase()));
    i.priority = effectivePriority(i.basePriority, i.exposed);
  }
  return { items, warnings };
}

// With an exposed list given, what the exposed services can read keeps its priority; the rest drops one step.
export function effectivePriority(base, exposed) {
  if (exposed === null || exposed === true || base === 'P3') return base;
  return PRI[Math.min(PRI.indexOf(base) + 1, 3)];
}

// ---------- selection and grouping ----------
export function selectItems(items, sel = {}, state = null) {
  const ids = sel.ids ? new Set(sel.ids) : null;
  const names = sel.names ? new Set(sel.names.map(n => n.toUpperCase())) : null;
  const cats = sel.categories ? new Set(sel.categories.map(c => c.toLowerCase())) : null;
  const svcs = sel.services ? new Set(sel.services.map(s => s.toLowerCase())) : null;
  const skipped = [];
  const chosen = items.filter(i => {
    const skip = (reason) => { skipped.push({ id: i.id, name: i.name, service: i.service, reason }); return false; };
    if (ids && !ids.has(i.id)) return false;
    if (names && !names.has(i.name.toUpperCase())) return false;
    if (cats && !cats.has(i.category.toLowerCase())) return false;
    if (svcs && !String(i.service || '').split(',').some(s => svcs.has(s.trim().toLowerCase())) && !i.usedBy.some(u => svcs.has(String(u.service).toLowerCase()))) return false;
    if (sel.priority && i.priority !== sel.priority) return false;
    if (sel.upTo && priorityRank(i.priority) > priorityRank(sel.upTo)) return false;
    if (i.derived) return skip('built from other variables: rotate the source');
    if (i.empty) return skip('empty');
    if (i.how === 'none' && !sel.names && !ids) return false;            // config: not a rotation target unless named
    if (i.how === 'none') return skip('classified as config, not a secret');
    if (i.priority === 'P3' && !sel.includeConfig && !names && !ids) return false;
    const st = state?.items?.[i.id];
    if (st && st.status === 'verified' && !sel.again) return skip('already rotated and verified');
    return true;
  });
  return { chosen, skipped };
}

export function groupItems(items) {
  const byKey = new Map();
  for (const i of items) {
    const key = i.fp && !i.unreadable ? 'fp:' + i.fp : 'id:' + i.id;
    (byKey.get(key) || byKey.set(key, []).get(key)).push(i);
  }
  const cats = defaultRules().categoryOrder;
  const groups = [...byKey.entries()].map(([key, members]) => {
    const how = members.map(m => m.how).sort((a, b) => HOW_RANK[a] - HOW_RANK[b])[0];
    const best = [...members].sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority) || cats.indexOf(a.category) - cats.indexOf(b.category))[0];
    return {
      id: 'g-' + sha8(key), key, names: [...new Set(members.map(m => m.name))], category: best.category, priority: best.priority, how,
      provider: members.find(m => m.provider)?.provider || null, link: members.find(m => m.link)?.link || null,
      warns: [...new Set([...members.map(m => m.warn).filter(Boolean), ...members.flatMap(m => (m.links || []).map(l => `${m.name} shares its secret with ${l.name} (${l.service ?? 'shared'}): they hold the same value, so change them together`))])],
      services: [...new Set(members.map(m => m.service ?? '(shared)'))], exposed: members.some(m => m.exposed === true),
      fp: members[0].fp, items: members,
    };
  });
  groups.sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority) || cats.indexOf(a.category) - cats.indexOf(b.category) || Number(b.exposed) - Number(a.exposed) || a.names[0].localeCompare(b.names[0]));
  return groups;
}

// ---------- plan ----------
const defaultUnitKey = (s) => [s.projectId, s.environmentId, s.serviceId ?? 'shared'].join('|');
export function buildPlan(items, adaptersById, sel = {}, state = null) {
  const { chosen, skipped } = selectItems(items, sel, state);
  const groups = groupItems(chosen);
  const writes = new Map(), units = new Map();
  const keyOf = (i, scope) => i.adapter + '|' + (adaptersById[i.adapter]?.unitKey || defaultUnitKey)(scope);
  const addUnit = (i, scope, label, priority) => {
    const uk = keyOf(i, scope);
    const u = units.get(uk) || units.set(uk, { adapter: i.adapter, scope, label: label || '(environment)', unit: uk, priority, itemIds: [] }).get(uk);
    if (priorityRank(priority) < priorityRank(u.priority)) u.priority = priority;
    u.itemIds.push(i.id);
  };
  for (const g of groups) {
    for (const i of g.items) {
      const k = keyOf(i, i.scope);
      const w = writes.get(k) || writes.set(k, { adapter: i.adapter, scope: i.scope, unit: k, names: new Set() }).get(k);
      w.names.add(i.name);
      // the service that owns the variable restarts; so does every service that references it (a shared variable has no service of its own)
      if (!i.shared) addUnit(i, i.scope, i.service, g.priority);
      for (const u of i.usedBy) addUnit(i, u.scope, u.service, g.priority);
    }
  }
  const unitList = [...units.values()].sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority) || a.label.localeCompare(b.label));
  const writeList = [...writes.values()].map(w => ({ ...w, names: [...w.names] }));
  return {
    groups, skipped, writes: writeList, units: unitList,
    estimate: { writes: writeList.length, redeploys: unitList.length, total: writeList.length + unitList.length },
    counts: Object.fromEntries(PRI.map(p => [p, groups.filter(g => g.priority === p).length])),
  };
}

// ---------- state ----------
export function stateFile(dir = process.cwd()) { return join(resolve(dir), STATE_DIR, 'state.json'); }
export function loadState(dir = process.cwd()) {
  try { const s = JSON.parse(readFileSync(stateFile(dir), 'utf8')); if (s && s.v === 1) return s; } catch { /* none yet */ }
  return { v: 1, createdAt: new Date().toISOString(), items: {}, deploys: {}, runs: [] };
}
export function saveState(state, dir = process.cwd()) {
  const f = stateFile(dir);
  mkdirSync(join(resolve(dir), STATE_DIR), { recursive: true });
  excludeStateDir(dir);
  const tmp = f + '.tmp';
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, f);
}
// Keep state out of `git status` through .git/info/exclude, never through the tracked .gitignore.
function excludeStateDir(dir) {
  try {
    const r = spawnSync('git', ['rev-parse', '--git-path', 'info/exclude'], { cwd: resolve(dir), encoding: 'utf8' });
    if (r.status !== 0) return;
    const f = resolve(dir, r.stdout.trim());
    const cur = existsSync(f) ? readFileSync(f, 'utf8') : '';
    if (/^\s*\.apikeys-handler\/?\s*$/m.test(cur)) return;
    mkdirSync(join(f, '..'), { recursive: true });
    appendFileSync(f, (cur && !cur.endsWith('\n') ? '\n' : '') + '.apikeys-handler/\n');
  } catch { /* not fatal */ }
}
const clip = (s) => redact(String(s)).replace(/\s+/g, ' ').slice(0, 300);
function mark(state, item, patch) {
  const cur = state.items[item.id] || { id: item.id, platform: item.platform, project: item.project, environment: item.environment, service: item.service, name: item.name, category: item.category, priority: item.priority, how: item.how, oldFp: item.fp, status: 'pending' };
  Object.assign(cur, patch, { updatedAt: new Date().toISOString() });
  state.items[item.id] = cur;
}

// ---------- rotation ----------
// opts: {apply, provide(group) -> string|null, log(msg), dir, adapters (array), sel, exposed}
// Dry run (apply false) returns the plan and touches nothing: nothing generated, nothing asked, nothing written.
export async function rotate(items, adapters, opts = {}) {
  const log = opts.log || (() => {});
  const dir = opts.dir || process.cwd();
  const byId = Object.fromEntries(adapters.map(a => [a.id, a]));
  const state = loadState(dir);
  const plan = buildPlan(items, byId, opts.sel || {}, state);
  if (!opts.apply) return { plan, applied: false };

  state.runs.push({ at: new Date().toISOString(), ids: plan.groups.flatMap(g => g.items.map(i => i.id)) });
  const result = { plan, applied: true, written: [], failed: [], skippedGroups: [], redeployed: [], manualRedeploys: [], verified: [], unverified: [] };

  // 1. stage: one new value per group, in memory only
  const staged = new Map();                                              // group id -> new value
  const resumed = new Set();                                             // item ids already written by an earlier run
  for (const g of plan.groups) {
    const done = g.items.filter(i => {
      const st = state.items[i.id];
      return st && ['written', 'redeployed', 'verified'].includes(st.status) && (i.fp === null || i.fp !== st.oldFp);
    });
    for (const d of done) resumed.add(d.id);
    if (done.length === g.items.length) continue;
    let value = null;
    try {
      value = g.how === 'generate' ? generateSecret(g.items.find(i => typeof i.value === 'string')?.value) : await opts.provide?.(g);
    } catch (e) { value = null; log(`  ${g.names.join(', ')}: ${clip(e.message)}`); }
    if (typeof value !== 'string' || value === '') { result.skippedGroups.push({ id: g.id, names: g.names, reason: g.how === 'generate' ? 'could not generate' : 'no new value provided' }); continue; }
    registerSecret(value);
    staged.set(g.id, value);
    for (const i of g.items) if (!resumed.has(i.id)) mark(state, i, { status: 'staged', groupId: g.id, oldFp: state.items[i.id]?.oldFp ?? i.fp });
  }
  saveState(state, dir);

  // 2. write: one call per scope, skipDeploys on, replace never set
  const writeFailedUnits = new Set();
  for (const w of plan.writes) {
    const a = byId[w.adapter];
    const changes = {}, members = [];
    for (const g of plan.groups) for (const i of g.items) {
      if (i.adapter !== w.adapter || !w.names.includes(i.name)) continue;
      if ((a.unitKey || defaultUnitKey)(i.scope) !== (a.unitKey || defaultUnitKey)(w.scope)) continue;
      if (resumed.has(i.id) || !staged.has(g.id)) continue;
      changes[i.name] = staged.get(g.id); members.push(i);
    }
    if (!members.length) continue;
    try {
      await a.set(w.scope, changes, { skipDeploys: true });
      for (const i of members) { mark(state, i, { status: 'written', error: undefined }); result.written.push(i.id); }
    } catch (e) {
      writeFailedUnits.add(w.unit);
      for (const i of members) { mark(state, i, { status: 'failed', error: clip(e.message) }); result.failed.push({ id: i.id, error: clip(e.message) }); }
      log(`  write failed for ${members.map(m => m.name).join(', ')}: ${clip(e.message)}`);
    }
    saveState(state, dir);
  }
  staged.clear();                                                        // new values leave memory as soon as they are written

  // 3. redeploy each affected unit once, after all its variables are written
  for (const u of plan.units) {
    if (writeFailedUnits.has(u.unit)) continue;
    const a = byId[u.adapter];
    if (!u.itemIds.some(id => state.items[id]?.status === 'written')) continue;   // nothing written for this unit that still needs a restart
    try {
      const r = await a.redeploy(u.scope);
      if (r && r.manual) { result.manualRedeploys.push({ unit: u.label, hint: r.hint }); state.deploys[u.unit] = { status: 'manual', hint: r.hint, at: new Date().toISOString() }; }
      else { result.redeployed.push(u.label); state.deploys[u.unit] = { status: 'redeployed', at: new Date().toISOString() }; }
    } catch (e) { result.failed.push({ id: 'redeploy:' + u.label, error: clip(e.message) }); log(`  redeploy failed for ${u.label}: ${clip(e.message)}`); }
  }
  const redeployedUnits = new Set(Object.entries(state.deploys).filter(([, d]) => d.status === 'redeployed').map(([k]) => k));
  for (const g of plan.groups) for (const i of g.items) {
    const st = state.items[i.id];
    if (st?.status !== 'written') continue;
    const targets = [...(i.shared ? [] : [i.scope]), ...i.usedBy.map(u => u.scope)];
    const uk = (s) => i.adapter + '|' + (byId[i.adapter].unitKey || defaultUnitKey)(s);
    if (targets.length && targets.every(t => redeployedUnits.has(uk(t)))) mark(state, i, { status: 'redeployed' });
  }
  saveState(state, dir);

  // 4. verify: re-read the platform and compare fingerprints. This proves the variable changed, not that the provider revoked the old key.
  const fresh = await inventory(adapters, { exposed: opts.exposed || [] });
  const now = new Map(fresh.items.map(i => [i.id, i]));
  for (const g of plan.groups) for (const i of g.items) {
    const st = state.items[i.id];
    if (!st || !['written', 'redeployed'].includes(st.status)) continue;
    const cur = now.get(i.id);
    if (!cur || cur.unreadable || cur.fp === null) { result.unverified.push({ id: i.id, why: 'the platform does not return values, so the change cannot be confirmed' }); continue; }
    if (cur.fp !== st.oldFp) { mark(state, i, { status: st.status === 'redeployed' ? 'verified' : st.status, newFp: cur.fp }); if (state.items[i.id].status === 'verified') result.verified.push(i.id); }
    else result.unverified.push({ id: i.id, why: 'the variable still has its old value' });
  }
  saveState(state, dir);
  return result;
}

// ---------- status and report (names and statuses only) ----------
export function summarize(state) {
  const all = Object.values(state.items);
  const by = (s) => all.filter(i => i.status === s).length;
  return { total: all.length, staged: by('staged'), written: by('written'), redeployed: by('redeployed'), verified: by('verified'), failed: by('failed'), pending: by('pending') };
}

export function reportMarkdown(items, state, { exposed = [] } = {}) {
  const L = ['# Secret rotation report', '', `Generated ${new Date().toISOString()}. Names, categories, priorities and statuses only: this file never contains a secret value.`, ''];
  const s = summarize(state);
  L.push(`**Rotated and verified:** ${s.verified} · written, not yet restarted or verified: ${s.written + s.redeployed} · failed: ${s.failed}`, '');
  if (exposed.length) L.push(`Exposed services: ${exposed.join(', ')}.`, '');
  const rows = items.filter(i => !i.derived && !i.empty && i.how !== 'none' && i.priority !== 'P3');
  const groups = groupItems(rows);
  L.push('| Priority | Category | Variable(s) | Service(s) | How | Status | Notes |', '|---|---|---|---|---|---|---|');
  for (const g of groups) {
    const sts = g.items.map(i => state.items[i.id]?.status || 'pending');
    const status = sts.every(x => x === 'verified') ? 'verified' : sts.includes('failed') ? 'FAILED' : sts.every(x => x === 'pending') ? 'pending' : [...new Set(sts)].join('/');
    const note = [g.how === 'manual' ? 'needs a step outside this tool' : g.how === 'provider' ? 'new key issued at ' + (g.provider || 'the provider') : 'generated', ...g.warns.map(w => w.split('. ')[0])].join('; ');
    L.push(`| ${g.priority} | ${g.category} | ${g.names.join(', ')} | ${g.services.join(', ')} | ${g.how} | ${status} | ${note.replace(/\|/g, '/')} |`);
  }
  L.push('', '## What this tool cannot do', '', '- It changes the variable on the platform. It cannot revoke the old key at the provider or change a database password: do those, and delete the old credentials, yourself.', '- A verified status means the platform variable changed. It does not mean the old secret is dead.');
  const failed = Object.values(state.items).filter(i => i.status === 'failed');
  if (failed.length) { L.push('', '## Failures', ''); for (const f of failed) L.push(`- ${f.name} (${f.service ?? 'shared'}): ${f.error || 'unknown error'}`); }
  return L.join('\n') + '\n';
}

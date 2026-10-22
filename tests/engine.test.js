import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

process.env.APIKEYS_HANDLER_HOME = mkdtempSync(join(tmpdir(), 'akh-home-'));
const { startFakeRailway, demoData } = await import('../skills/apikeys-handler/scripts/demo-railway.js');
const { railwayAdapter } = await import('../skills/apikeys-handler/scripts/railway.js');
const { inventory, buildPlan, rotate, loadState, stateFile, reportMarkdown, summarize } = await import('../skills/apikeys-handler/scripts/engine.js');
const { clearSecrets } = await import('../skills/apikeys-handler/scripts/classify.js');

const dirOf = () => { const d = mkdtempSync(join(tmpdir(), 'akh-run-')); spawnSync('git', ['init', '-q'], { cwd: d }); return d; };
async function setup(opts = {}) {
  clearSecrets();
  const fake = await startFakeRailway(opts);
  const adapter = railwayAdapter({ token: 'demo', endpoint: fake.url, ...(opts.adapter || {}) });
  return { fake, adapter, dir: dirOf() };
}
// every literal (non-reference) value in the fixture, before any rotation
function allValues(data) {
  const out = new Set();
  for (const p of data.projects) for (const env of Object.values(p.vars)) for (const bag of Object.values(env)) for (const v of Object.values(bag)) if (typeof v === 'string' && v.length >= 16 && !v.includes('${{')) out.add(v);
  return [...out];
}
const provide = (map) => async (g) => { for (const n of g.names) if (n in map) return map[n]; return null; };
const prodOnly = { environment: 'production' };

test('inventory: classifies Railway variables, keeps references as references, skips system variables, and always reads unrendered', async () => {
  const { fake, adapter } = await setup({ adapter: prodOnly });
  const { items } = await inventory([adapter]);
  await fake.close();
  assert.ok(fake.calls.filter(c => c.op === 'variables').every(c => c.unrendered === true));
  assert.ok(!items.some(i => i.name === 'RAILWAY_PRIVATE_DOMAIN'));
  const web = (n) => items.find(i => i.service === 'web' && i.name === n);
  assert.equal(web('DATABASE_URL').derived, true);
  assert.equal(web('SESSION_SECRET').derived, true);
  assert.deepEqual([web('APP_KEY').category, web('APP_KEY').how], ['Auth & sessions', 'generate']);
  assert.deepEqual([web('STRIPE_SECRET_KEY').category, web('STRIPE_SECRET_KEY').how], ['Payments', 'provider']);
  assert.equal(web('PORT').priority, 'P3');
  const pg = items.find(i => i.service === 'Postgres' && i.name === 'PGPASSWORD');
  assert.deepEqual(pg.usedBy.map(u => u.service).sort(), ['Postgres', 'api', 'web'], 'api and web build DATABASE_URL from it; Postgres references it as ${{PGPASSWORD}}');
  const shared = items.find(i => i.shared && i.name === 'SESSION_SECRET');
  assert.deepEqual(shared.usedBy.map(u => u.service), ['web']);
  assert.equal(items.find(i => i.service === 'Postgres' && i.name === 'POSTGRES_PASSWORD').derived, true, '${{PGPASSWORD}} is a same-service reference');
});

test('plan: --exposed puts what the exposed service can read first; identical secrets are one group; derived and config are skipped with a reason', async () => {
  const { fake, adapter } = await setup({ adapter: prodOnly });
  const { items } = await inventory([adapter], { exposed: ['web'] });
  await fake.close();
  const plan = buildPlan(items, { railway: adapter }, {});
  assert.ok(plan.groups.length > 0);
  const ranks = plan.groups.map(g => g.priority);
  assert.deepEqual([...ranks].sort(), ranks, 'ordered P0 before P1 before P2');
  const jwt = plan.groups.find(g => g.names.includes('JWT_SECRET'));
  assert.equal(jwt.items.length, 2, 'api and worker share one JWT secret, so one rotation');
  assert.equal(jwt.priority, 'P1', 'not readable by the exposed web service: one step lower than the base P0');
  assert.equal(plan.groups.find(g => g.names.includes('APP_KEY')).priority, 'P0');
  assert.ok(plan.skipped.some(s => s.name === 'DATABASE_URL' && /rotate the source/.test(s.reason)));
  assert.ok(!plan.groups.some(g => g.names.includes('PORT')), 'config is not a rotation target');
  assert.ok(plan.estimate.writes > 0 && plan.estimate.redeploys > 0);
});

test('dry run: no new value is generated or asked for, nothing is written, no state file appears', async () => {
  const { fake, adapter, dir } = await setup({ adapter: prodOnly });
  const { items } = await inventory([adapter]);
  let asked = 0;
  const before = fake.calls.length;
  const r = await rotate(items, [adapter], { apply: false, dir, provide: async () => { asked++; return 'x'; } });
  await fake.close();
  assert.equal(r.applied, false); assert.equal(asked, 0);
  assert.equal(fake.calls.length, before);
  assert.equal(existsSync(stateFile(dir)), false);
});

test('apply: generated and pasted values are written once per scope with skipDeploys and never replace; one redeploy per service; verified by fingerprint', async () => {
  const { fake, adapter, dir } = await setup({ adapter: prodOnly });
  const before = allValues(fake.data);
  const { items } = await inventory([adapter], { exposed: ['web'] });
  const r = await rotate(items, [adapter], { apply: true, dir, exposed: ['web'], provide: provide({ STRIPE_SECRET_KEY: 'sk_live_NEWNEWNEWNEW', STRIPE_WEBHOOK_SECRET: 'whsec_NEWNEWNEWNEWNEWNEW0000', PGPASSWORD: 'new-postgres-password-1' }), sel: { upTo: 'P0' } });
  await fake.close();
  const upserts = fake.calls.filter(c => c.op === 'upsert');
  assert.ok(upserts.length > 0);
  for (const u of upserts) { assert.equal(u.input.skipDeploys, true); assert.ok(!('replace' in u.input), 'replace would delete every variable not listed'); }
  const keyOf = (u) => u.input.environmentId + '|' + (u.input.serviceId || 'shared');
  assert.equal(new Set(upserts.map(keyOf)).size, upserts.length, 'one write per scope');
  const redeploys = fake.calls.filter(c => c.op === 'redeploy').map(c => c.serviceId);
  assert.equal(new Set(redeploys).size, redeploys.length, 'one redeploy per service');
  assert.ok(redeploys.includes('svc-web') && redeploys.includes('svc-api'));
  const web = fake.data.projects[0].vars['env-prod']['svc-web'];
  assert.equal(web.STRIPE_SECRET_KEY, 'sk_live_NEWNEWNEWNEW');
  assert.notEqual(web.APP_KEY, 'base64:ZGVtby1hcHAta2V5LW5vdC1yZWFsLWRlbW8ta2V5LTEyMzQ=');
  assert.match(web.APP_KEY, /^base64:/, 'the generated value keeps the old format');
  assert.equal(fake.data.projects[0].vars['env-prod']['svc-api'].JWT_SECRET, fake.data.projects[0].vars['env-prod']['svc-worker'].JWT_SECRET, 'one secret used by two services stays equal');
  assert.equal(web.DATABASE_URL, 'postgres://shop:${{Postgres.PGPASSWORD}}@${{Postgres.RAILWAY_PRIVATE_DOMAIN}}:5432/shop', 'a reference is never overwritten');
  assert.equal(r.verified.length, 5, 'STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, PGPASSWORD, APP_KEY and the shared SESSION_SECRET: the P0 set readable by web');
  assert.notEqual(fake.data.projects[0].vars['env-prod'].shared.SESSION_SECRET, 'demo-session-secret-aaaaaaaaaaaaaaaaaaaaaaaa');
  assert.equal(r.failed.length, 0);
  // the service that only references PGPASSWORD restarts too
  assert.ok(redeploys.includes('svc-pg'));
  assert.equal(summarize(loadState(dir)).failed, 0);
  assert.ok(before.length > 5);
});

test('a group with no pasted value is skipped, not guessed', async () => {
  const { fake, adapter, dir } = await setup({ adapter: prodOnly });
  const { items } = await inventory([adapter]);
  const r = await rotate(items, [adapter], { apply: true, dir, provide: async () => null, sel: { names: ['STRIPE_SECRET_KEY', 'OPENAI_API_KEY'] } });
  await fake.close();
  assert.equal(fake.calls.filter(c => c.op === 'upsert').length, 0);
  assert.deepEqual(r.skippedGroups.map(g => g.reason), ['no new value provided', 'no new value provided']);
});

test('a shared variable is written at the shared scope and restarts the services that reference it', async () => {
  const { fake, adapter, dir } = await setup({ adapter: prodOnly });
  const { items } = await inventory([adapter]);
  await rotate(items, [adapter], { apply: true, dir, sel: { names: ['SESSION_SECRET'] } });
  await fake.close();
  const up = fake.calls.filter(c => c.op === 'upsert');
  const sharedWrite = up.find(u => !u.input.serviceId);
  assert.ok(sharedWrite && 'SESSION_SECRET' in sharedWrite.input.variables);
  assert.ok(!up.some(u => u.input.serviceId === 'svc-web' && 'SESSION_SECRET' in u.input.variables), 'the web reference is not overwritten');
  assert.deepEqual(fake.calls.filter(c => c.op === 'redeploy').map(c => c.serviceId).sort(), ['svc-web']);
});

test('resume: a crash between write and redeploy is picked up without writing anything twice', async () => {
  const { fake, adapter, dir } = await setup({ adapter: prodOnly });
  const { items } = await inventory([adapter]);
  const sel = { names: ['JWT_SECRET', 'APP_KEY'] };
  let n = 0;
  const flaky = Object.assign(Object.create(adapter), { redeploy: async (s) => { if (++n === 2) throw new Error('connection reset'); return adapter.redeploy(s); }, unitKey: adapter.unitKey, id: 'railway' });
  const r1 = await rotate(items, [flaky], { apply: true, dir, sel });
  assert.equal(r1.failed.length, 1);
  const upsertsAfterFirst = fake.calls.filter(c => c.op === 'upsert').length;
  const st1 = Object.values(loadState(dir).items).map(i => i.status);
  assert.ok(st1.includes('written') && st1.includes('verified'), st1.join());
  const { items: again } = await inventory([adapter]);
  const r2 = await rotate(again, [adapter], { apply: true, dir, sel });
  await fake.close();
  assert.equal(fake.calls.filter(c => c.op === 'upsert').length, upsertsAfterFirst, 'nothing rewritten on resume');
  assert.equal(r2.failed.length, 0);
  assert.ok(Object.values(loadState(dir).items).every(i => i.status === 'verified'));
});

test('leaks: a platform error that echoes the request, the state file, the report and every result never contain a secret value', async () => {
  const { fake, adapter, dir } = await setup({ adapter: prodOnly, echoErrors: true, failServiceIds: ['svc-worker'] });
  const old = allValues(fake.data);
  const { items } = await inventory([adapter]);
  const r = await rotate(items, [adapter], { apply: true, dir, provide: provide({ SENDGRID_API_KEY: 'SG.NEWNEWNEWNEWNEWNEW.NEWNEWNEWNEWNEWNEWNEWNEWNEWNEW', SLACK_BOT_TOKEN: 'xoxb-9999999999-NEWNEWNEW' }), sel: { upTo: 'P1' } });
  await fake.close();
  assert.ok(r.failed.length > 0, 'the worker write failed');
  const news = ['SG.NEWNEWNEWNEWNEWNEW.NEWNEWNEWNEWNEWNEWNEWNEWNEWNEW', 'xoxb-9999999999-NEWNEWNEW'];
  const state = readFileSync(stateFile(dir), 'utf8');
  const report = reportMarkdown(items, loadState(dir));
  const everything = [state, report, JSON.stringify(r.failed), JSON.stringify(r.skippedGroups)].join('\n');
  for (const v of [...old, ...news]) assert.ok(!everything.includes(v), `a secret value leaked: ${v.slice(0, 12)}…`);
  assert.match(state, /\[redacted\]/, 'the echoed value was scrubbed');
  const files = readdirSync(join(dir, '.apikeys-handler'));
  assert.deepEqual(files.filter(f => !/^state\.json$/.test(f)), [], 'only the state file is written: ' + files.join());
});

test('state lives in .git/info/exclude, not the tracked .gitignore', async () => {
  const { fake, adapter, dir } = await setup({ adapter: prodOnly });
  const { items } = await inventory([adapter]);
  await rotate(items, [adapter], { apply: true, dir, sel: { names: ['JWT_SECRET'] } });
  await fake.close();
  assert.match(readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf8'), /^\.apikeys-handler\/$/m);
  assert.equal(existsSync(join(dir, '.gitignore')), false);
  assert.equal(spawnSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }).stdout.trim(), '');
});

test('railway adapter: waits out one 429, rejects a bad token without echoing it, supports a project token header', async () => {
  clearSecrets();
  const fake = await startFakeRailway({ rateLimitFirst: 1 });
  const ok = railwayAdapter({ token: 'demo', endpoint: fake.url, environment: 'production' });
  const items = await ok.list();
  assert.ok(items.length > 10);
  const bad = railwayAdapter({ token: 'wrong-token-123456', endpoint: fake.url });
  await assert.rejects(() => bad.list(), (e) => /Not Authorized/.test(e.message) && !e.message.includes('wrong-token-123456'));
  const proj = railwayAdapter({ token: 'demo', tokenType: 'project', endpoint: fake.url });
  assert.ok((await proj.list()).length > 5);
  assert.throws(() => railwayAdapter({}), /No Railway token/);
  await fake.close();
});

test('a URL that embeds the password of another variable is linked to it, so the two are changed together', async () => {
  const { fake, adapter } = await setup({ adapter: prodOnly });
  const { items } = await inventory([adapter]);
  await fake.close();
  const url = items.find(i => i.service === 'api' && i.name === 'REDIS_URL');
  const pw = items.find(i => i.service === 'Redis' && i.name === 'REDIS_PASSWORD');
  assert.deepEqual(url.links.map(l => l.name), ['REDIS_PASSWORD']);
  assert.deepEqual(pw.links.map(l => `${l.name}@${l.service}`).sort(), ['REDIS_URL@api', 'REDIS_URL@worker']);
  const plan = buildPlan(items, { railway: adapter }, { names: ['REDIS_PASSWORD'] });
  assert.match(plan.groups[0].warns.join(' '), /shares its secret with REDIS_URL \(api\).*change them together/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { request } from 'node:http';
import { spawnSync } from 'node:child_process';

process.env.APIKEYS_HANDLER_HOME = mkdtempSync(join(tmpdir(), 'akh-home-'));
const { startFakeRailway } = await import('../skills/apikeys-handler/scripts/demo-railway.js');
const { railwayAdapter } = await import('../skills/apikeys-handler/scripts/railway.js');
const { createUi } = await import('../skills/apikeys-handler/scripts/server.js');
const { clearSecrets } = await import('../skills/apikeys-handler/scripts/classify.js');

const values = (data) => {
  const out = new Set();
  for (const p of data.projects) for (const env of Object.values(p.vars)) for (const bag of Object.values(env)) for (const v of Object.values(bag)) if (typeof v === 'string' && v.length >= 16 && !v.includes('${{')) out.add(v);
  return [...out];
};
function raw(port, { path = '/', method = 'GET', headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const r = request({ host: '127.0.0.1', port, path, method, headers }, (res) => { let t = ''; res.on('data', d => t += d); res.on('end', () => resolve({ status: res.statusCode, text: t, headers: res.headers })); });
    r.on('error', reject); if (body) r.write(body); r.end();
  });
}
async function boot() {
  clearSecrets();
  const fake = await startFakeRailway();
  const dir = mkdtempSync(join(tmpdir(), 'akh-ui-')); spawnSync('git', ['init', '-q'], { cwd: dir });
  const adapter = railwayAdapter({ token: fake.token, endpoint: fake.url, environment: 'production' });
  const ui = await createUi({ adapters: [adapter], dir });
  const seen = [];
  const call = async (path, body) => {
    const r = await raw(ui.port, { path, method: body ? 'POST' : 'GET', headers: { 'X-AKH-Token': ui.token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : null });
    seen.push(r.text);
    return { status: r.status, json: (() => { try { return JSON.parse(r.text); } catch { return null; } })(), text: r.text };
  };
  return { fake, ui, dir, call, seen, close: async () => { await ui.close(); await fake.close(); } };
}

test('guards: the page needs the one-time token, the API needs the header, a wrong Host or Origin is refused, no CORS headers', async () => {
  const s = await boot();
  const t = new URL(s.ui.url).searchParams.get('t');
  assert.equal((await raw(s.ui.port, { path: '/' })).status, 403);
  assert.equal((await raw(s.ui.port, { path: '/?t=nope' })).status, 403);
  const page = await raw(s.ui.port, { path: '/?t=' + t });
  assert.equal(page.status, 200); assert.match(page.text, /<title>apikeys-handler<\/title>/);
  assert.match(page.headers['content-security-policy'], /connect-src 'self'/);
  assert.ok(!('access-control-allow-origin' in page.headers));
  assert.equal((await raw(s.ui.port, { path: '/api/scan' })).status, 401);
  assert.equal((await raw(s.ui.port, { path: '/api/scan', headers: { 'X-AKH-Token': 'wrong' } })).status, 401);
  assert.equal((await raw(s.ui.port, { path: '/?t=' + t, headers: { Host: 'evil.example.com' } })).status, 403, 'DNS rebinding: a foreign Host header');
  assert.equal((await raw(s.ui.port, { path: '/api/plan', method: 'POST', headers: { 'X-AKH-Token': s.ui.token, Origin: 'http://evil.example.com', 'Content-Type': 'application/json' }, body: '{}' })).status, 403, 'a cross-origin write');
  assert.equal((await s.call('/api/scan')).status, 200);
  await s.close();
});

test('scan and plan responses carry no secret value and no internal scope', async () => {
  const s = await boot();
  const scan = await s.call('/api/scan?exposed=web');
  assert.ok(scan.json.items.length > 15);
  assert.ok(scan.json.items.every(i => !('value' in i) && !('scope' in i)));
  const ids = scan.json.items.filter(i => i.priority === 'P0' && !i.derived && i.how !== 'none').map(i => i.id);
  const plan = await s.call('/api/plan', { ids });
  assert.ok(plan.json.groups.length > 0 && plan.json.estimate.total > 0);
  for (const v of values(s.fake.data)) for (const text of s.seen) assert.ok(!text.includes(v), 'a response leaked ' + v.slice(0, 10));
  await s.close();
});

test('rotation job: generated and pasted values are applied, the job and the next scan show names and statuses only, pasted values are gone afterwards', async () => {
  const s = await boot();
  const old = values(s.fake.data);
  const scan = await s.call('/api/scan');
  const pick = (n, svc) => scan.json.items.find(i => i.name === n && (!svc || i.service === svc));
  const stripe = pick('STRIPE_SECRET_KEY'), jwtApi = pick('JWT_SECRET', 'api'), jwtWorker = pick('JWT_SECRET', 'worker');
  const plan = await s.call('/api/plan', { ids: [stripe.id, jwtApi.id, jwtWorker.id] });
  const gStripe = plan.json.groups.find(g => g.names.includes('STRIPE_SECRET_KEY'));
  const NEW = 'sk_live_PASTEDINTHEP';
  const start = await s.call('/api/rotate', { ids: plan.json.groups.flatMap(g => g.itemIds), values: { [gStripe.id]: NEW } });
  assert.equal(start.status, 202);
  let job; for (let i = 0; i < 60; i++) { job = (await s.call('/api/job')).json; if (job.status !== 'running') break; await new Promise(r => setTimeout(r, 100)); }
  assert.equal(job.status, 'done', JSON.stringify(job));
  assert.equal(job.result.failed.length, 0); assert.equal(job.result.verified, 3);
  const prod = s.fake.data.projects[0].vars['env-prod'];
  assert.equal(prod['svc-web'].STRIPE_SECRET_KEY, NEW);
  assert.equal(prod['svc-api'].JWT_SECRET, prod['svc-worker'].JWT_SECRET);
  const after = await s.call('/api/scan');
  assert.equal(after.json.items.find(i => i.id === stripe.id).status, 'verified');
  const newJwt = prod['svc-api'].JWT_SECRET;
  const state = readFileSync(join(s.dir, '.apikeys-handler', 'state.json'), 'utf8');
  for (const v of [...old, NEW, newJwt]) { for (const text of [...s.seen, state]) assert.ok(!text.includes(v), 'leaked ' + v.slice(0, 10)); }
  const report = await s.call('/api/report');
  for (const v of [...old, NEW, newJwt]) assert.ok(!report.text.includes(v));
  await s.close();
});

test('a second rotation while one runs is refused', async () => {
  const s = await boot();
  const scan = await s.call('/api/scan');
  const ids = scan.json.items.filter(i => ['JWT_SECRET', 'APP_KEY'].includes(i.name)).map(i => i.id);
  const [a, b] = await Promise.all([s.call('/api/rotate', { ids }), s.call('/api/rotate', { ids })]);
  assert.deepEqual([a.status, b.status].sort(), [202, 409]);
  for (let i = 0; i < 60; i++) { const j = (await s.call('/api/job')).json; if (j.status !== 'running') break; await new Promise(r => setTimeout(r, 100)); }
  await s.close();
});

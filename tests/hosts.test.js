import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';

process.env.APIKEYS_HANDLER_HOME = mkdtempSync(join(tmpdir(), 'akh-home-'));
const { makeHostAdapter } = await import('../skills/apikeys-handler/scripts/hosts.js');
const { inventory, rotate } = await import('../skills/apikeys-handler/scripts/engine.js');
const { clearSecrets, generateSecret } = await import('../skills/apikeys-handler/scripts/classify.js');

// A fake of the three vendors' APIs, shaped from their public documentation. It proves the adapters are consistent with
// that reading, not that the vendors behave this way: references/platforms.md lists these three as unverified.
async function fakeVendors({ failPut = false } = {}) {
  const calls = [];
  const db = {
    netlify: [{ key: 'JWT_SECRET', scopes: ['builds', 'functions', 'runtime'], is_secret: false, values: [{ id: 'v1', value: 'netlify-jwt-secret-aaaaaaaaaaaaaaaaaaaa', context: 'production' }, { id: 'v2', value: 'netlify-jwt-secret-bbbbbbbbbbbbbbbbbbbb', context: 'deploy-preview' }] }],
    cfWorkerSecrets: ['API_TOKEN'],
    pages: { name: 'site', deployment_configs: { production: { env_vars: { SESSION_SECRET: { type: 'secret_text' }, PUBLIC_URL: { type: 'plain_text', value: 'https://x.example' } } }, preview: { env_vars: {} } } },
    supa: ['STRIPE_KEY'],
  };
  const server = createServer((req, res) => {
    const chunks = []; req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
      calls.push({ method: req.method, path: req.url, body });
      const json = (s, b) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(b)); };
      if (req.headers.authorization !== 'Bearer tok') return json(401, { message: 'unauthorized' });
      const u = req.url;
      if (u.startsWith('/nl/accounts') && !u.includes('/env')) return json(200, [{ id: 'acct1', slug: 'me' }]);
      if (u.startsWith('/nl/sites') && u.includes('/builds')) return json(201, { id: 'b1' });
      if (u.startsWith('/nl/sites')) return json(200, [{ id: 'site1', name: 'shop-web', account_slug: 'me', account_id: 'acct1' }]);
      if (u.startsWith('/nl/accounts/acct1/env/') && req.method === 'PUT') {
        if (failPut) return json(400, { message: 'bad input: ' + JSON.stringify(body) });                 // an API that echoes its input
        const k = decodeURIComponent(u.split('/env/')[1].split('?')[0]); const v = db.netlify.find(x => x.key === k); v.values = body.values.map((e, i) => ({ id: 'v' + i, ...e })); return json(200, v);
      }
      if (u.startsWith('/nl/accounts/acct1/env')) return json(200, db.netlify);
      if (u === '/cf/accounts/acc/workers/scripts') return json(200, { result: [{ id: 'edge-api' }] });
      if (u === '/cf/accounts/acc/workers/scripts/edge-api/secrets' && req.method === 'GET') return json(200, { result: db.cfWorkerSecrets.map(name => ({ name, type: 'secret_text' })) });
      if (u === '/cf/accounts/acc/workers/scripts/edge-api/secrets' && req.method === 'PUT') return json(200, { result: { name: body.name } });
      if (u === '/cf/accounts/acc/pages/projects') return json(200, { result: [db.pages] });
      if (u === '/cf/accounts/acc/pages/projects/site' && req.method === 'PATCH') { Object.assign(db.pages.deployment_configs[Object.keys(body.deployment_configs)[0]].env_vars, body.deployment_configs.production?.env_vars); return json(200, { result: db.pages }); }
      if (u === '/cf/accounts/acc/pages/projects/site/deployments') return json(200, { result: { id: 'd1' } });
      if (u === '/sb/projects') return json(200, [{ id: 'ref123', name: 'shop-db' }]);
      if (u === '/sb/projects/ref123/secrets' && req.method === 'GET') return json(200, db.supa.map(name => ({ name, value: 'sha256-digest' })));
      if (u === '/sb/projects/ref123/secrets' && req.method === 'POST') return json(201, {});
      return json(404, { message: 'no route ' + u });
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return { port, calls, db, base: (p) => `http://127.0.0.1:${port}/${p}`, close: () => new Promise(r => { server.closeAllConnections?.(); server.close(r); }) };
}
const dirOf = () => { const d = mkdtempSync(join(tmpdir(), 'akh-host-')); spawnSync('git', ['init', '-q'], { cwd: d }); return d; };

test('netlify: lists variables per context, a secret stays unreadable, rotate writes the right context and triggers a build', async () => {
  clearSecrets();
  const f = await fakeVendors();
  const a = makeHostAdapter('netlify', { env: { NETLIFY_AUTH_TOKEN: 'tok' }, base: f.base('nl') });
  const { items } = await inventory([a]);
  assert.deepEqual(items.map(i => `${i.service}/${i.environment}/${i.name}`).sort(), ['shop-web/deploy-preview/JWT_SECRET', 'shop-web/production/JWT_SECRET']);
  const dir = dirOf();
  const r = await rotate(items, [a], { apply: true, dir, sel: { names: ['JWT_SECRET'] }, provide: async () => null });
  await f.close();
  assert.equal(r.failed.length, 0, JSON.stringify(r.failed));
  const put = f.calls.filter(c => c.method === 'PUT');
  assert.equal(put.length, 2, 'one PUT per context scope');
  assert.ok(f.db.netlify[0].values.every(v => v.value !== 'netlify-jwt-secret-aaaaaaaaaaaaaaaaaaaa'));
  assert.deepEqual(f.db.netlify[0].scopes, ['builds', 'functions', 'runtime'], 'scopes are preserved');
  assert.equal(f.calls.filter(c => c.method === 'POST' && c.path.includes('/builds')).length, 2);
});

test('cloudflare: Worker secrets and Pages variables are listed by name; a write-only platform is reported as unverifiable', async () => {
  clearSecrets();
  const f = await fakeVendors();
  const a = makeHostAdapter('cloudflare', { env: { CLOUDFLARE_API_TOKEN: 'tok', CLOUDFLARE_ACCOUNT_ID: 'acc' }, base: f.base('cf') });
  const { items } = await inventory([a]);
  assert.deepEqual(items.map(i => `${i.project}/${i.service}/${i.environment}/${i.name}`).sort(), ['pages/site/production/PUBLIC_URL', 'pages/site/production/SESSION_SECRET', 'workers/edge-api/production/API_TOKEN']);
  assert.ok(items.find(i => i.name === 'SESSION_SECRET').unreadable);
  const dir = dirOf();
  const r = await rotate(items, [a], { apply: true, dir, sel: { names: ['SESSION_SECRET', 'API_TOKEN'] }, provide: async (g) => (g.how === 'generate' ? generateSecret(null) : 'pasted-new-api-token-0000000000') });
  await f.close();
  assert.equal(r.failed.length, 0, JSON.stringify(r.failed));
  assert.equal(r.unverified.length, 2); assert.match(r.unverified[0].why, /does not return values/);
  assert.equal(f.calls.filter(c => c.method === 'PUT').length, 1);
  assert.equal(f.calls.filter(c => c.path.endsWith('/deployments')).length, 1, 'Pages needs a new deployment; a Worker does not');
});

test('supabase: Edge Function secrets are rotated, and the dashboard-only keys are called out', async () => {
  clearSecrets();
  const f = await fakeVendors();
  const a = makeHostAdapter('supabase', { env: { SUPABASE_ACCESS_TOKEN: 'tok' }, base: f.base('sb') });
  const { items, warnings } = await inventory([a]);
  assert.equal(items[0].name, 'STRIPE_KEY'); assert.ok(warnings.some(w => /service-role key and JWT secret .* cannot be rotated from here/.test(w)));
  const r = await rotate(items, [a], { apply: true, dir: dirOf(), sel: { names: ['STRIPE_KEY'] }, provide: async () => 'sk_live_NEWNEWNEWNEW' });
  await f.close();
  assert.equal(r.failed.length, 0);
  assert.deepEqual(f.calls.find(c => c.method === 'POST').body, [{ name: 'STRIPE_KEY', value: 'sk_live_NEWNEWNEWNEW' }]);
  assert.equal(r.manualRedeploys.length, 1);
});

test('hosts: a vendor error that echoes the request is scrubbed; a missing token says what to set', async () => {
  clearSecrets();
  const f = await fakeVendors({ failPut: true });
  const a = makeHostAdapter('netlify', { env: { NETLIFY_AUTH_TOKEN: 'tok' }, base: f.base('nl') });
  const { items } = await inventory([a]);
  const NEW = 'pasted-new-secret-value-0000000001';
  const r = await rotate(items, [a], { apply: true, dir: dirOf(), sel: { names: ['JWT_SECRET'] }, provide: async () => NEW });
  await f.close();
  assert.ok(r.failed.length > 0);
  assert.ok(!JSON.stringify(r).includes(NEW), 'the echoed new value must not reach the result');
  assert.match(JSON.stringify(r.failed), /redacted/);
  assert.throws(() => makeHostAdapter('netlify', { env: {} }), /No Netlify token/);
  assert.throws(() => makeHostAdapter('cloudflare', { env: { CLOUDFLARE_API_TOKEN: 'x' } }), /CLOUDFLARE_ACCOUNT_ID/);
});

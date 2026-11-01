import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, symlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startFakeRailway } from '../skills/apikeys-handler/scripts/demo-railway.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'skills', 'apikeys-handler', 'scripts', 'apikeys-handler.js');
const HOME = mkdtempSync(join(tmpdir(), 'akh-home-'));

function cli(cwd, args, env = {}, script = SCRIPT) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [script, ...args], { cwd, env: { ...process.env, APIKEYS_HANDLER_HOME: HOME, RAILWAY_API_TOKEN: '', RAILWAY_TOKEN: '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    p.stdout.on('data', d => stdout += d); p.stderr.on('data', d => stderr += d);
    p.on('close', (status) => resolve({ status, stdout, stderr, all: stdout + stderr }));
  });
}
const gitDir = () => { const d = mkdtempSync(join(tmpdir(), 'akh-cli-')); spawnSync('git', ['init', '-q'], { cwd: d }); return d; };
const values = (data) => {
  const out = new Set();
  for (const p of data.projects) for (const env of Object.values(p.vars)) for (const bag of Object.values(env)) for (const v of Object.values(bag)) if (typeof v === 'string' && v.length >= 16 && !v.includes('${{')) out.add(v);
  return [...out];
};
const envFor = (fake) => ({ RAILWAY_API_TOKEN: fake.token, RAILWAY_ENDPOINT: fake.url });

test('help prints and the script runs through a junction (the ~/.claude/skills install path)', async () => {
  const d = gitDir();
  const r = await cli(d, ['help']);
  assert.equal(r.status, 0); assert.match(r.stdout, /rotate every API key and secret after a breach/);
  const link = join(mkdtempSync(join(tmpdir(), 'akh-link-')), 'apikeys-handler');
  symlinkSync(join(ROOT, 'skills', 'apikeys-handler'), link, 'junction');
  const viaLink = await cli(d, ['help'], {}, join(link, 'scripts', 'apikeys-handler.js'));
  assert.match(viaLink.stdout, /rotate every API key and secret after a breach/, 'the main-check must survive a junction');
});

test('scan: by service, category and priority; --json too; no secret value anywhere in stdout or stderr', async () => {
  const fake = await startFakeRailway();
  const vals = values(fake.data);
  const d = gitDir();
  const r = await cli(d, ['scan', '--environment', 'production', '--exposed', 'web'], envFor(fake));
  const j = await cli(d, ['scan', '--environment', 'production', '--json'], envFor(fake));
  await fake.close();
  assert.equal(r.status, 0, r.all);
  assert.match(r.stdout, /railway · shop · production · web/);
  assert.match(r.stdout, /P0  Auth & sessions\s+APP_KEY\s+generate/);
  assert.match(r.stdout, /DATABASE_URL\s+derived/);
  assert.match(r.stdout, /EXPOSED/);
  assert.equal(JSON.parse(j.stdout).items.length > 15, true);
  for (const v of vals) { assert.ok(!r.all.includes(v), 'scan leaked ' + v.slice(0, 10)); assert.ok(!j.all.includes(v), 'scan --json leaked ' + v.slice(0, 10)); }
  assert.ok(!('value' in JSON.parse(j.stdout).items[0]));
});

test('plan is a dry run: ordered rotations, new-key links, warnings, a request count, nothing written', async () => {
  const fake = await startFakeRailway();
  const d = gitDir();
  const r = await cli(d, ['plan', '--environment', 'production', '--exposed', 'web', '--up-to', 'P0'], envFor(fake));
  await fake.close();
  assert.equal(r.status, 0, r.all);
  assert.match(r.stdout, /P0\s+Payments\s+STRIPE_SECRET_KEY\s+\[provider\]/);
  assert.match(r.stdout, /new key: https:\/\/dashboard\.stripe\.com\/apikeys/);
  assert.match(r.stdout, /Existing sessions and anything encrypted with the old APP_KEY/);
  assert.match(r.stdout, /requests/); assert.match(r.stdout, /Dry run: nothing was written/);
  assert.equal(fake.calls.filter(c => c.op === 'upsert').length, 0);
  assert.equal(existsSync(join(d, '.apikeys-handler')), false);
});

test('rotate --apply without a person and without --yes refuses, and writes nothing', async () => {
  const fake = await startFakeRailway();
  const d = gitDir();
  const r = await cli(d, ['rotate', '--apply', '--environment', 'production', '--name', 'JWT_SECRET'], envFor(fake));
  await fake.close();
  assert.equal(r.status, 2); assert.match(r.stderr, /refusing to write without a person/);
  assert.equal(fake.calls.filter(c => c.op === 'upsert').length, 0);
});

test('rotate --apply --yes: generated secret is written, a pre-supplied AKH_NEW_ value is used, neither is ever printed, status and report show names only', async () => {
  const fake = await startFakeRailway();
  const vals = values(fake.data);
  const d = gitDir();
  const NEW = 'sk_live_BRANDNEWSTRI';
  const r = await cli(d, ['rotate', '--apply', '--yes', '--environment', 'production', '--name', 'JWT_SECRET,STRIPE_SECRET_KEY'], { ...envFor(fake), AKH_NEW_STRIPE_SECRET_KEY: NEW });
  assert.equal(r.status, 0, r.all);
  const prod = fake.data.projects[0].vars['env-prod'];
  assert.equal(prod['svc-web'].STRIPE_SECRET_KEY, NEW);
  assert.notEqual(prod['svc-api'].JWT_SECRET, 'demo-jwt-secret-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  assert.equal(prod['svc-api'].JWT_SECRET, prod['svc-worker'].JWT_SECRET);
  const newJwt = prod['svc-api'].JWT_SECRET;
  assert.match(r.stdout, /verified 3/); assert.match(r.stdout, /Still yours to do: delete or revoke the OLD keys/);
  const st = await cli(d, ['status']);
  const rep = await cli(d, ['report', '--environment', 'production'], envFor(fake));
  await fake.close();
  for (const text of [r.all, st.all, rep.all, readFileSync(join(d, '.apikeys-handler', 'state.json'), 'utf8')]) for (const v of [...vals, NEW, newJwt]) assert.ok(!text.includes(v), 'leaked ' + v.slice(0, 10));
  assert.match(st.stdout, /verified 3/);
  assert.match(rep.stdout, /What this tool cannot do/);
});

test('a missing token says what to set, in your own terminal', async () => {
  const d = gitDir();
  const r = await cli(d, ['scan', '--platform', 'railway']);
  assert.equal(r.status, 1); assert.match(r.stderr, /No Railway token\. Set RAILWAY_API_TOKEN/);
});

test('dotenv end to end: rotate a generated secret in a local .env and print the restart hint, not a restart', async () => {
  const d = gitDir();
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(d, '.env'), '# keep me\nJWT_SECRET=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nPORT=3000\n');
  writeFileSync(join(d, 'docker-compose.yml'), 'services:\n  web:\n    image: x\n    env_file: .env\n');
  const r = await cli(d, ['rotate', '--apply', '--yes', '--platform', 'dotenv', '--name', 'JWT_SECRET']);
  assert.equal(r.status, 0, r.all);
  const after = readFileSync(join(d, '.env'), 'utf8');
  assert.match(after, /^# keep me\nJWT_SECRET=[0-9a-f]{40}\nPORT=3000\n$/);
  assert.ok(!after.includes('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'));
  assert.match(r.stdout, /restart by hand \(web\): docker compose .* up -d --force-recreate web/);
});

test('AKH_NEW_<NAME> is refused when two groups carry the name (production and staging), and the per-environment form works', async () => {
  const fake = await startFakeRailway();
  const d = gitDir();
  const LIVE = 'sk_live_LIVEKEYFORPR';
  const amb = await cli(d, ['rotate', '--apply', '--yes', '--name', 'STRIPE_SECRET_KEY'], { ...envFor(fake), AKH_NEW_STRIPE_SECRET_KEY: LIVE });
  const prod = () => fake.data.projects[0].vars['env-prod']['svc-web'].STRIPE_SECRET_KEY;
  const stg = () => fake.data.projects[0].vars['env-stg']['svc-web'].STRIPE_SECRET_KEY;
  assert.match(amb.all, /AKH_NEW_STRIPE_SECRET_KEY is ambiguous: 2 groups/);
  assert.match(amb.all, /AKH_NEW_STRIPE_SECRET_KEY__PRODUCTION/);
  assert.notEqual(prod(), LIVE); assert.notEqual(stg(), LIVE);
  assert.equal(fake.calls.filter(c => c.op === 'upsert').length, 0, 'nothing was written');
  const ok = await cli(d, ['rotate', '--apply', '--yes', '--name', 'STRIPE_SECRET_KEY'], { ...envFor(fake), AKH_NEW_STRIPE_SECRET_KEY__PRODUCTION: LIVE });
  await fake.close();
  assert.equal(prod(), LIVE, ok.all);
  assert.ok(!stg().includes('LIVEKEY'), 'the live key never reaches staging');
  assert.ok(!ok.all.includes(LIVE) && !amb.all.includes(LIVE));
});

test('--seen: secrets listed by agent-residue (keyed fingerprints, no values) are marked SEEN BY AGENT, also through the password inside a URL, and sorted first', async () => {
  process.env.APIKEYS_HANDLER_HOME = HOME;                       // the same machine key the CLI child uses
  const { fingerprint, resetKeyCache } = await import('../skills/apikeys-handler/scripts/classify.js');
  resetKeyCache();
  const { writeFileSync } = await import('node:fs');
  const d = gitDir();
  const seenPw = 'Zq8mK2vR9xTe5LbN3wYc', otherPw = 'Hd4pS7aU1gJf6QoV0iXz', jwt = 'Pn3rT8yWk1Bv5HcM9eLx';
  writeFileSync(join(d, '.env'), `DATABASE_URL=postgres://app:${seenPw}@db:5432/app\nREDIS_URL=redis://:${otherPw}@cache:6379\nJWT_SECRET=${jwt}\n`);
  const seenFile = join(d, 'seen.json');
  writeFileSync(seenFile, JSON.stringify({ version: 1, items: [{ fp: fingerprint(seenPw), type: 'url_credential' }, { fp: fingerprint(jwt), type: 'named_secret' }] }));
  const r = await cli(d, ['plan', '--platform', 'dotenv', '--seen', seenFile], { APIKEYS_HANDLER_HOME: HOME });
  assert.equal(r.status, 0, r.all);
  assert.match(r.all, /seen: 2 variables match secrets your agent has seen/);
  assert.match(r.all, /DATABASE_URL.*SEEN BY AGENT/); assert.match(r.all, /JWT_SECRET.*SEEN BY AGENT/);
  assert.ok(!/REDIS_URL.*SEEN BY AGENT/.test(r.all), 'a secret the agent has not seen is not marked');
  assert.ok(r.all.indexOf('DATABASE_URL') < r.all.indexOf('REDIS_URL'), 'seen first within the same priority');
  for (const v of [seenPw, otherPw, jwt]) assert.ok(!r.all.includes(v));
  const bad = await cli(d, ['plan', '--platform', 'dotenv', '--seen', join(d, 'missing.json')], { APIKEYS_HANDLER_HOME: HOME });
  assert.equal(bad.status, 2);
});

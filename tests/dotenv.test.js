import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { parseEnv, parseCompose, applyChanges, parseValueToken, renderValueToken, dotenvAdapter } from '../skills/apikeys-handler/scripts/dotenv.js';

const ENV = [
  '# app settings',
  'PORT=3000',
  '',
  'export JWT_SECRET="old-jwt-secret-value-1234567890"   # signs sessions',
  "STRIPE_SECRET_KEY='sk_live_oldoldoldold'",
  'DATABASE_URL=postgres://app:oldpass@db:5432/app',
  'EMPTY=',
  '   INDENTED = spaced',
  'MULTI="line one',
  'line two"',
  '# trailing comment',
  '',
].join('\n');

test('a .env rewrite changes only the targeted line: comments, order, spacing, quoting and the trailing newline survive', () => {
  const p = parseEnv(ENV);
  const r = applyChanges(ENV, p, { JWT_SECRET: 'NEW-jwt-secret' });
  const before = ENV.split('\n'), after = r.text.split('\n');
  assert.equal(after.length, before.length);
  const diff = before.map((l, i) => [l, after[i]]).filter(([a, b]) => a !== b);
  assert.equal(diff.length, 1);
  assert.equal(diff[0][1], 'export JWT_SECRET="NEW-jwt-secret"   # signs sessions');
  assert.deepEqual(r.changed, ['JWT_SECRET']);
});

test('quote style is kept; a value that needs quoting gets them; single quotes fall back to double when the value has one', () => {
  const p = parseEnv(ENV);
  assert.match(applyChanges(ENV, p, { STRIPE_SECRET_KEY: 'sk_live_new' }).text, /^STRIPE_SECRET_KEY='sk_live_new'$/m);
  assert.match(applyChanges(ENV, p, { STRIPE_SECRET_KEY: "it's" }).text, /^STRIPE_SECRET_KEY="it's"$/m);
  assert.match(applyChanges(ENV, p, { DATABASE_URL: 'postgres://u:p@h/d' }).text, /^DATABASE_URL=postgres:\/\/u:p@h\/d$/m);
  assert.match(applyChanges(ENV, p, { DATABASE_URL: 'has space' }).text, /^DATABASE_URL="has space"$/m);
  assert.match(applyChanges(ENV, p, { DATABASE_URL: 'a#b' }).text, /^DATABASE_URL="a#b"$/m);
  assert.equal(renderValueToken('q"uote\\', '"'), '"q\\"uote\\\\"');
  assert.throws(() => renderValueToken('a\nb', ''), /line break/);
});

test('a multiline value is reported, never touched; an empty value stays listed', () => {
  const p = parseEnv(ENV);
  assert.ok(p.unsupported.some(u => u.name === 'MULTI' && /multiline/.test(u.why)));
  assert.ok(!p.entries.some(e => e.name === 'MULTI'));
  const r = applyChanges(ENV, p, { PORT: '4000' });
  assert.ok(r.text.includes('MULTI="line one\nline two"'));
  assert.equal(p.entries.find(e => e.name === 'EMPTY').value, '');
  assert.equal(p.entries.find(e => e.name === 'INDENTED').value, 'spaced');
});

test('CRLF files keep their line endings', () => {
  const crlf = 'A=1\r\nSECRET=old\r\nB=2\r\n';
  const r = applyChanges(crlf, parseEnv(crlf), { SECRET: 'new' });
  assert.equal(r.text, 'A=1\r\nSECRET=new\r\nB=2\r\n');
});

test('value tokens: trailing comments, quotes with spaces, escaped quotes', () => {
  assert.deepEqual(parseValueToken('abc   # note'), { value: 'abc', quote: '', tail: '   # note' });
  assert.deepEqual(parseValueToken('"a b" # c'), { value: 'a b', quote: '"', tail: ' # c' });
  assert.equal(parseValueToken('"a\\"b"').value, 'a"b');
  assert.equal(parseValueToken('"never ends'), null);
  assert.equal(parseValueToken('a#b').value, 'a#b');
});

const COMPOSE = [
  'name: shop',
  'services:',
  '  web:',
  '    image: php:8.4-apache',
  '    env_file:',
  '      - .env',
  '      - ./web.env',
  '    environment:',
  '      APP_KEY: "base64:oldoldold"',
  '      DB_HOST: db',
  '      SMTP_PASSWORD: oldsmtp # mail',
  '  worker:',
  '    image: shop-worker',
  '    environment:',
  '      - QUEUE_TOKEN=oldqueue',
  '      - "API_SECRET=oldapi"',
  '      - ONLY_NAME',
  '    env_file: .env',
  '  odd:',
  '    environment: &shared',
  '      X: 1',
  '    command: |',
  '      run it',
  '',
].join('\n');

test('compose: environment mapping and list, env_file scalar and list, whole-item quotes, per-service scoping', () => {
  const p = parseCompose(COMPOSE);
  const by = (n, s) => p.entries.find(e => e.name === n && e.service === s);
  assert.equal(by('APP_KEY', 'web').value, 'base64:oldoldold');
  assert.equal(by('SMTP_PASSWORD', 'web').value, 'oldsmtp');
  assert.equal(by('QUEUE_TOKEN', 'worker').value, 'oldqueue');
  assert.equal(by('API_SECRET', 'worker').value, 'oldapi');
  assert.ok(!p.entries.some(e => e.name === 'ONLY_NAME'), 'a name with no value is inherited from the shell: nothing to rewrite');
  assert.deepEqual(p.envFiles.map(f => `${f.service}:${f.file}`).sort(), ['web:./web.env', 'web:.env', 'worker:.env'].sort());
  assert.ok(p.unsupported.some(u => /inline environment/.test(u.why)), 'an anchor is reported');
});

test('compose rewrite changes only the targeted lines, keeps whole-item quoting, and leaves the other service alone', () => {
  const p = parseCompose(COMPOSE);
  const r = applyChanges(COMPOSE, p, { APP_KEY: 'base64:NEW', API_SECRET: 'newapi' }, 'web');
  assert.deepEqual(r.changed, ['APP_KEY']);
  assert.deepEqual(r.missing, ['API_SECRET']);                      // API_SECRET lives in worker, not web
  const r2 = applyChanges(COMPOSE, p, { API_SECRET: 'newapi', SMTP_PASSWORD: 'newsmtp' }, 'worker');
  assert.ok(r2.text.includes('      - "API_SECRET=newapi"'));
  assert.ok(r2.text.includes('SMTP_PASSWORD: oldsmtp # mail'), 'web is untouched');
  const lines = COMPOSE.split('\n'), out = applyChanges(COMPOSE, p, { SMTP_PASSWORD: 'newsmtp' }, 'web').text.split('\n');
  assert.deepEqual(lines.map((l, i) => l === out[i] ? null : i).filter(x => x !== null).length, 1);
  assert.ok(out.includes('      SMTP_PASSWORD: newsmtp # mail'));
});

function project() {
  const d = mkdtempSync(join(tmpdir(), 'akh-env-'));
  spawnSync('git', ['init', '-q'], { cwd: d });
  writeFileSync(join(d, '.env'), 'JWT_SECRET=oldjwtoldjwtoldjwt\nDB_PASSWORD=olddb\n');
  writeFileSync(join(d, '.env.example'), 'JWT_SECRET=changeme\n');
  writeFileSync(join(d, 'docker-compose.yml'), COMPOSE);
  return d;
}

test('adapter: lists .env and compose entries with services, skips .env.example, warns on tracked files and unsupported lines', async () => {
  const d = project();
  spawnSync('git', ['add', '.env'], { cwd: d });
  const a = dotenvAdapter({ dir: d });
  const items = await a.list();
  assert.ok(!items.some(i => i.environment === '.env.example'));
  const jwt = items.find(i => i.name === 'JWT_SECRET');
  assert.equal(jwt.service, 'web, worker', 'the .env file is attributed to the compose services that load it');
  assert.ok(items.some(i => i.name === 'APP_KEY' && i.service === 'web'));
  assert.ok(a.warnings.some(w => /\.env is tracked by git/.test(w)));
  assert.ok(a.warnings.some(w => /not understood/.test(w)));
});

test('adapter: set writes the file, a missing name is an error, redeploy is a printed hint and not an action', async () => {
  const d = project();
  const a = dotenvAdapter({ dir: d });
  const items = await a.list();
  const jwt = items.find(i => i.name === 'JWT_SECRET');
  assert.deepEqual(await a.set(jwt.scope, { JWT_SECRET: 'brand-new-secret-value' }), ['JWT_SECRET']);
  assert.equal(readFileSync(join(d, '.env'), 'utf8'), 'JWT_SECRET=brand-new-secret-value\nDB_PASSWORD=olddb\n');
  await assert.rejects(() => a.set(jwt.scope, { NOPE: 'x' }), /could not find NOPE/);
  const app = items.find(i => i.name === 'APP_KEY');
  const h = await a.redeploy(app.scope);
  assert.equal(h.manual, true); assert.match(h.hint, /docker compose .* up -d --force-recreate web/);
  mkdirSync(join(d, 'sub'), { recursive: true });
});

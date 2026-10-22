import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.APIKEYS_HANDLER_HOME = mkdtempSync(join(tmpdir(), 'akh-home-'));
const { classify, defaultRules, fingerprint, generateSecret, redact, registerSecret, clearSecrets, isReference, referencesIn, priorityRank } = await import('../skills/apikeys-handler/scripts/classify.js');

// [name, value (null = unreadable), category, priority, how]
const TABLE = [
  ['DATABASE_URL', 'postgres://app:hunter2hunter2@db.internal:5432/app', 'Database', 'P0', 'manual'],
  ['DATABASE_URL', 'sqlite:///data/app.db', 'Config', 'P3', 'none'],
  ['DATABASE_URL', null, 'Database', 'P0', 'manual'],
  ['POSTGRES_PASSWORD', 'abc12345', 'Database', 'P0', 'manual'],
  ['PGPASSWORD', 'abc12345', 'Database', 'P0', 'manual'],
  ['DB_PASSWORD', 'abc12345', 'Database', 'P0', 'manual'],
  ['REDIS_URL', 'rediss://:s3cretpass@cache.internal:6379', 'Database', 'P0', 'manual'],
  ['MONGODB_URI', 'mongodb+srv://u:p4ssw0rd@cluster0.example.net/db', 'Database', 'P0', 'manual'],
  ['APP_KEY', 'base64:aGVsbG8gd29ybGQgdGhpcyBpcyBhIHRlc3Qga2V5IQ==', 'Auth & sessions', 'P0', 'generate'],
  ['JWT_SECRET', 'a'.repeat(48), 'Auth & sessions', 'P0', 'generate'],
  ['SESSION_SECRET', 'b'.repeat(32), 'Auth & sessions', 'P0', 'generate'],
  ['SECRET_KEY_BASE', 'c'.repeat(64), 'Auth & sessions', 'P0', 'generate'],
  ['NEXTAUTH_SECRET', 'd'.repeat(32), 'Auth & sessions', 'P0', 'generate'],
  ['ENCRYPTION_KEY', 'e'.repeat(32), 'Auth & sessions', 'P0', 'manual'],
  ['STRIPE_SECRET_KEY', 'sk_live_' + 'x'.repeat(24), 'Payments', 'P0', 'provider'],
  ['STRIPE_WEBHOOK_SECRET', 'whsec_' + 'x'.repeat(24), 'Payments', 'P0', 'provider'],
  ['STRIPE_PUBLISHABLE_KEY', 'pk_live_' + 'x'.repeat(24), 'Config', 'P3', 'none'],
  ['NEXT_PUBLIC_STRIPE_KEY', 'pk_live_' + 'x'.repeat(24), 'Config', 'P3', 'none'],
  ['AWS_ACCESS_KEY_ID', 'AKIAABCDEFGHIJKLMNOP', 'Cloud & infra', 'P0', 'provider'],
  ['AWS_SECRET_ACCESS_KEY', 'z'.repeat(40), 'Cloud & infra', 'P0', 'provider'],
  ['AWS_REGION', 'us-east-1', 'Config', 'P3', 'none'],
  ['CLOUDFLARE_API_TOKEN', 'q'.repeat(40), 'Cloud & infra', 'P0', 'provider'],
  ['RAILWAY_TOKEN', 'q'.repeat(36), 'Cloud & infra', 'P0', 'provider'],
  ['GITHUB_TOKEN', 'ghp_' + 'a'.repeat(36), 'Source & CI', 'P0', 'provider'],
  ['NPM_TOKEN', 'npm_' + 'a'.repeat(36), 'Source & CI', 'P0', 'provider'],
  ['SENTRY_AUTH_TOKEN', 'q'.repeat(40), 'Source & CI', 'P1', 'provider'],
  ['SENTRY_DSN', 'https://abc@o1.ingest.sentry.io/1', 'Monitoring & analytics', 'P2', 'provider'],
  ['OPENAI_API_KEY', 'sk-proj-' + 'a'.repeat(40), 'AI & LLM', 'P1', 'provider'],
  ['ANTHROPIC_API_KEY', 'sk-ant-' + 'a'.repeat(40), 'AI & LLM', 'P1', 'provider'],
  ['SENDGRID_API_KEY', 'SG.' + 'a'.repeat(22) + '.' + 'b'.repeat(43), 'Email & SMS', 'P1', 'provider'],
  ['SMTP_PASSWORD', 'smtp-pass-1', 'Email & SMS', 'P1', 'provider'],
  ['TWILIO_AUTH_TOKEN', 'f'.repeat(32), 'Email & SMS', 'P1', 'provider'],
  ['GITHUB_CLIENT_SECRET', 'f'.repeat(40), 'Auth & sessions', 'P0', 'provider'],
  ['SUPABASE_SERVICE_ROLE_KEY', 'eyJ' + 'a'.repeat(20) + '.eyJ' + 'b'.repeat(20) + '.' + 'c'.repeat(20), 'Auth & sessions', 'P0', 'provider'],
  ['SUPABASE_URL', 'https://x.supabase.co', 'Config', 'P3', 'none'],
  ['SUPABASE_ANON_KEY', 'eyJ' + 'a'.repeat(20), 'Config', 'P3', 'none'],
  ['SLACK_BOT_TOKEN', 'xoxb-1234567890-abcdefghij', 'Other secret', 'P1', 'provider'],
  ['SOMETHING_API_KEY', 'f'.repeat(32), 'Other secret', 'P1', 'manual'],
  ['ADMIN_PASSWORD', 'hunter2', 'Other secret', 'P1', 'manual'],
  ['PORT', '3000', 'Config', 'P3', 'none'],
  ['NODE_ENV', 'production', 'Config', 'P3', 'none'],
  ['APP_URL', 'https://example.com', 'Config', 'P3', 'none'],
];

test('classification table: category, priority and how for 44 realistic variables', () => {
  for (const [name, value, category, priority, how] of TABLE) {
    const c = classify(name, value);
    assert.deepEqual([c.category, c.priority, c.how], [category, priority, how], `${name} -> ${c.category}/${c.priority}/${c.how} via ${c.rule}`);
  }
});

test('"generate" is a tight allowlist: never for database passwords, webhook secrets, encryption keys or provider-prefixed values', () => {
  const never = [
    ['POSTGRES_PASSWORD', 'abc12345'], ['PGPASSWORD', 'abc12345'], ['MYSQL_ROOT_PASSWORD', 'abc12345'], ['DATABASE_URL', 'postgres://u:p4ssw0rd@h/d'],
    ['STRIPE_WEBHOOK_SECRET', 'whsec_' + 'x'.repeat(24)], ['GITHUB_WEBHOOK_SECRET', 'x'.repeat(30)], ['WEBHOOK_SECRET', 'x'.repeat(30)], ['SLACK_SIGNING_SECRET', 'x'.repeat(30)],
    ['ENCRYPTION_KEY', 'x'.repeat(32)], ['MASTER_KEY', 'x'.repeat(32)],
    ['UNKNOWN_SECRET', 'x'.repeat(32)], ['SOMETHING_TOKEN', null], ['MYSTERY', 'x'.repeat(32)],
    // a provider-issued value under an allowlisted name is still not generated
    ['JWT_SECRET', 'sk_live_' + 'x'.repeat(24)], ['SESSION_SECRET', 'ghp_' + 'x'.repeat(36)], ['APP_KEY', 'AKIAABCDEFGHIJKLMNOP'],
  ];
  for (const [name, value] of never) assert.notEqual(classify(name, value).how, 'generate', `${name} must not be generated`);
  // and a write-only store (value unknown) still generates only the allowlisted names
  assert.equal(classify('JWT_SECRET', null).how, 'generate');
  assert.notEqual(classify('API_TOKEN', null).how, 'generate');
});

test('references are derived: never rotated directly', () => {
  assert.equal(isReference('${{Postgres.DATABASE_URL}}'), true);
  assert.equal(isReference('postgres://u:${{Postgres.PGPASSWORD}}@h/d'), true);
  assert.equal(isReference('${DB_PASS}'), true);
  assert.equal(isReference('plain'), false);
  const c = classify('DATABASE_URL', '${{Postgres.DATABASE_URL}}');
  assert.equal(c.derived, true); assert.equal(c.how, 'none');
  assert.deepEqual(referencesIn('x ${{Postgres.PGPASSWORD}} y ${{shared.KEY}} ${PLAIN}'), [{ scope: 'Postgres', name: 'PGPASSWORD' }, { scope: 'shared', name: 'KEY' }, { scope: null, name: 'PLAIN' }]);
});

test('a provider link comes with provider-issued keys', () => {
  assert.match(classify('OPENAI_API_KEY', 'sk-proj-' + 'a'.repeat(40)).link, /platform\.openai\.com/);
  assert.match(classify('STRIPE_SECRET_KEY', 'sk_live_' + 'x'.repeat(24)).link, /stripe\.com/);
  assert.equal(classify('SOMETHING_API_KEY', 'x'.repeat(32)).link, null);
});

test('value shape finds a secret under a boring name; a stripe test key is lower priority', () => {
  const c = classify('FOO', 'ghp_' + 'a'.repeat(36));
  assert.deepEqual([c.category, c.priority, c.how, c.provider], ['Source & CI', 'P0', 'provider', 'GitHub']);
  assert.equal(classify('FOO', 'sk_test_' + 'a'.repeat(24)).priority, 'P2');
});

test('fingerprints: stable, keyed, twelve hex characters, never the value; empty and unreadable have none', () => {
  const f = fingerprint('hunter2-hunter2');
  assert.match(f, /^[0-9a-f]{12}$/);
  assert.equal(fingerprint('hunter2-hunter2'), f);
  assert.notEqual(fingerprint('hunter2-hunter3'), f);
  assert.equal(fingerprint(''), null); assert.equal(fingerprint(null), null);
});

test('generated secrets keep the old format and length, and are always at least 32 characters', () => {
  assert.match(generateSecret('base64:' + Buffer.alloc(32, 1).toString('base64')), /^base64:[A-Za-z0-9+/]{43}=$/);
  const hex = generateSecret('a'.repeat(64)); assert.match(hex, /^[0-9a-f]{64}$/); assert.notEqual(hex, 'a'.repeat(64));
  assert.match(generateSecret('Abc_def-' + 'x'.repeat(40)), /^[A-Za-z0-9_-]{48}$/);
  assert.match(generateSecret(null), /^[0-9a-f]{64}$/);
  assert.match(generateSecret('short'), /^[0-9a-f]{64}$/);
  assert.notEqual(generateSecret(null), generateSecret(null));
});

test('redact scrubs registered values from any text and ignores very short ones', () => {
  clearSecrets();
  registerSecret('sk_live_abcdefghijkl'); registerSecret('1234');
  assert.equal(redact('failed for sk_live_abcdefghijkl on 1234'), 'failed for [redacted] on 1234');
  clearSecrets();
});

test('priority order is P0 < P1 < P2 < P3 and the default rules load', () => {
  assert.ok(priorityRank('P0') < priorityRank('P1') && priorityRank('P2') < priorityRank('P3'));
  assert.ok(defaultRules().rules.length > 20);
});

test('credentialOf finds the password in a connection URL and nothing else', async () => {
  const { credentialOf } = await import('../skills/apikeys-handler/scripts/classify.js');
  assert.equal(credentialOf('redis://:s3cr3tpass@cache:6379'), 's3cr3tpass');
  assert.equal(credentialOf('postgres://app:hunter2hunter2@db:5432/app'), 'hunter2hunter2');
  assert.equal(credentialOf('https://example.com/path'), null);
  assert.equal(credentialOf('plain-value'), null);
  assert.equal(credentialOf(null), null);
});

test('rules added after the first benchmark run: CRYPTO prefix, webhook URLs, plural keys, IMAP, consumer secret, refresh token', () => {
  const t = (n, cat, how) => { const c = classify(n, null); assert.deepEqual([c.category, c.how].join('/'), [cat, how].join('/'), `${n} -> ${c.category}/${c.how} via ${c.rule}`); };
  t('CRYPTOQUANT_API_KEY', 'Other secret', 'manual');
  t('CRYPTO_KEY', 'Auth & sessions', 'manual');
  t('GOOGLE_WEBHOOK_URL', 'Webhooks & signing', 'provider');
  t('SERPAPI_KEYS', 'Other secret', 'manual');
  t('IMAP_PASSWORD', 'Email & SMS', 'provider');
  t('TWITTER_CONSUMER_SECRET', 'Auth & sessions', 'provider');
  t('GOOGLE_OAUTH_REFRESH_TOKEN', 'Auth & sessions', 'provider');
});

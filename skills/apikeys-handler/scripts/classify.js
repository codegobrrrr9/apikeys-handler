// Classifier, fingerprints, secret generation and output redaction. Zero dependencies.
//
// Nothing in this file writes a secret anywhere. fingerprint() is a keyed hash: it lets the tool say "same secret
// in three services" and "still the old value" without holding the value.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { createHmac, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// ---------- redaction: every value this process holds is registered and scrubbed from anything printed or saved ----------
const known = new Set();
export function registerSecret(v) { if (typeof v === 'string' && v.length >= 6) known.add(v); }
export function redact(text) {
  let s = String(text ?? '');
  for (const v of known) if (s.includes(v)) s = s.split(v).join('[redacted]');
  return s;
}
export function clearSecrets() { known.clear(); }

// ---------- rules ----------
let cached = null;
export function loadRules(projectDir = null) {
  const base = JSON.parse(readFileSync(join(here, 'rules.json'), 'utf8'));
  let extra = [];
  if (projectDir) {
    const f = join(projectDir, '.apikeys-handler.json');
    if (existsSync(f)) { try { extra = JSON.parse(readFileSync(f, 'utf8')).rules || []; } catch { /* a broken user file must not break a rotation */ } }
  }
  const compile = (r) => ({ ...r, _re: new RegExp(r.re, 'i'), _val: r.requireValue ? new RegExp(r.requireValue, 'i') : null });
  return {
    categoryOrder: base.categoryOrder,
    providers: base.providers,
    defaults: base.defaults,
    rules: [...extra.map(compile), ...base.rules.map(compile)],
    shapes: base.shapes.map(s => ({ ...s, _re: new RegExp(s.re) })),
  };
}
export function defaultRules() { return (cached ||= loadRules()); }

// A value built from other variables: ${{Postgres.PASSWORD}} (Railway), ${VAR} or $VAR (compose and dotenv).
export const REF_RE = /\$\{\{\s*[^}]+\}\}|\$\{[A-Za-z_][A-Za-z0-9_]*(?::?[-?+][^}]*)?\}/;
export function isReference(value) { return typeof value === 'string' && REF_RE.test(value); }
export function referencesIn(value) {
  const out = [];
  if (typeof value !== 'string') return out;
  for (const m of value.matchAll(/\$\{\{\s*([^}]+?)\s*\}\}/g)) {
    const [scope, ...rest] = m[1].split('.');
    // ${{NAME}} (no dot) is a variable of the same service; ${{Service.NAME}} and ${{shared.NAME}} name their scope
    out.push(rest.length ? { scope: scope.trim(), name: rest.join('.').trim() } : { scope: null, name: scope.trim() });
  }
  for (const m of value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::?[-?+][^}]*)?\}/g)) out.push({ scope: null, name: m[1] });
  return out;
}

const PRIORITY_RANK = { P0: 0, P1: 1, P2: 2, P3: 3 };
export const priorityRank = (p) => PRIORITY_RANK[p] ?? 9;

// classify(name, value, rules): value is a string when the platform lets us read it, null when it is write-only.
export function classify(name, value, rules = defaultRules()) {
  const upper = String(name).toUpperCase();
  const known_ = typeof value === 'string';
  let rule = null;
  for (const r of rules.rules) {
    if (!r._re.test(upper)) continue;
    if (r._val && known_ && !r._val.test(value)) continue;
    rule = r; break;
  }
  let out = rule
    ? { category: rule.category, priority: rule.priority, how: rule.how, provider: rule.provider || null, warn: rule.warn || null, rule: rule.id }
    : { ...rules.defaults, provider: null, warn: null, rule: 'default' };

  if (known_ && value !== '') {
    const shape = rules.shapes.find(s => s._re.test(value));
    if (shape) {
      const generic = !rule || rule.category === 'Config' || rule.category === 'Other secret';
      if (generic) out = { category: shape.category, priority: shape.priority, how: shape.how || 'provider', provider: shape.provider || null, warn: shape.warn || null, rule: 'shape:' + shape.id };
      else {
        if (out.how === 'generate') out.how = 'provider';            // a value with a provider prefix is never replaced by a made-up one
        if (!out.provider && shape.provider) out.provider = shape.provider;
        if (shape.how === 'manual' && out.how !== 'manual') out.how = 'manual';
      }
    }
  }
  if (out.how === 'generate' && known_ && /^(sk|pk|rk)_|^gh[pousr]_|^AKIA/.test(value)) out.how = 'provider';

  out.link = out.provider ? (rules.providers[out.provider] || null) : null;
  out.empty = known_ && value === '';
  out.derived = known_ && isReference(value);
  if (out.derived) { out.how = 'none'; out.note = 'Built from other variables; rotate the source, not this.'; }
  return out;
}

// ---------- fingerprints ----------
function home() { return process.env.APIKEYS_HANDLER_HOME || join(homedir(), '.apikeys-handler'); }
let keyCache = null;
export function localKey() {
  if (keyCache) return keyCache;
  const p = join(home(), 'key');
  try { if (existsSync(p)) return (keyCache = readFileSync(p, 'utf8').trim()); } catch { /* fall through */ }
  const k = randomBytes(32).toString('hex');
  try { mkdirSync(home(), { recursive: true }); writeFileSync(p, k, { mode: 0o600 }); } catch { /* an unwritable home still works for this run */ }
  return (keyCache = k);
}
export function resetKeyCache() { keyCache = null; }
export function fingerprint(value) {
  if (typeof value !== 'string' || value === '') return null;
  return createHmac('sha256', localKey()).update(value).digest('hex').slice(0, 12);
}

// ---------- generation (only ever for how === 'generate') ----------
export function generateSecret(old) {
  const o = typeof old === 'string' ? old : '';
  if (/^base64:/.test(o)) return 'base64:' + randomBytes(32).toString('base64');
  if (/^[0-9a-f]{16,}$/i.test(o)) { const len = Math.min(Math.max(o.length, 32), 256); return randomBytes(Math.ceil(len / 2)).toString('hex').slice(0, len); }
  if (/^[A-Za-z0-9+/]{16,}={0,2}$/.test(o) && /[+/=]/.test(o)) { const n = Math.max(Buffer.from(o, 'base64').length, 32); return randomBytes(n).toString('base64'); }
  if (/^[A-Za-z0-9_-]{16,}$/.test(o)) { const len = Math.min(Math.max(o.length, 32), 256); return randomBytes(len).toString('base64url').slice(0, len); }
  return randomBytes(32).toString('hex');
}

export const GENERATE_ALLOWLIST_NOTE = 'Only names matching rules with how "generate" are ever generated: APP_KEY, JWT_SECRET, SESSION_SECRET, COOKIE_SECRET, SECRET_KEY, SECRET_KEY_BASE, NEXTAUTH_SECRET, AUTH_SECRET, BETTER_AUTH_SECRET, APP_SECRET and similar. Database passwords, webhook secrets, encryption keys and anything with a provider prefix are never generated.';

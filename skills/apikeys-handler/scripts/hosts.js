// Netlify, Cloudflare (Workers secrets and Pages variables) and Supabase (Edge Function secrets) adapters.
//
// STATUS: written from the vendors' public API documentation and tested against a fake server only. They have NOT
// been run against a real account. Every endpoint is in OPS so a wrong shape is a one-line fix, and
// references/platforms.md lists them as unverified until someone runs the live test. The engine's rules still hold:
// values never printed, never stored, errors redacted, nothing written without --apply.

import { redact } from './classify.js';

export class HostError extends Error {
  constructor(message, extra = {}) { super(redact(message)); this.name = 'HostError'; Object.assign(this, extra); }
}

export const OPS = {
  netlify: {
    base: 'https://api.netlify.com/api/v1',
    sites: '/sites?per_page=100',
    accounts: '/accounts',
    env: (acct, site) => `/accounts/${acct}/env?site_id=${site}`,
    envKey: (acct, key, site) => `/accounts/${acct}/env/${encodeURIComponent(key)}?site_id=${site}`,
    build: (site) => `/sites/${site}/builds`,
  },
  cloudflare: {
    base: 'https://api.cloudflare.com/client/v4',
    scripts: (acct) => `/accounts/${acct}/workers/scripts`,
    secrets: (acct, name) => `/accounts/${acct}/workers/scripts/${encodeURIComponent(name)}/secrets`,
    pages: (acct) => `/accounts/${acct}/pages/projects`,
    pagesProject: (acct, name) => `/accounts/${acct}/pages/projects/${encodeURIComponent(name)}`,
    pagesDeploy: (acct, name) => `/accounts/${acct}/pages/projects/${encodeURIComponent(name)}/deployments`,
  },
  supabase: {
    base: 'https://api.supabase.com/v1',
    projects: '/projects',
    secrets: (ref) => `/projects/${ref}/secrets`,
  },
};

function client({ token, base, fetchImpl = globalThis.fetch, label }) {
  if (!token) throw new HostError(`No ${label} token. Set it in your own terminal (see apikeys-handler help).`);
  return async function call(method, path, body) {
    let res;
    try { res = await fetchImpl(base + path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); }
    catch (e) { throw new HostError(`Could not reach ${label}: ` + (e.cause?.code || e.message)); }
    if (res.status === 429) throw new HostError(`${label} rate limit hit`, { rateLimited: true, retryAfter: Number(res.headers.get('retry-after') || 0) });
    const text = await res.text();
    let data = null; try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (!res.ok) {
      const m = data?.errors?.map?.(e => e.message).join('; ') || data?.message || data?.error || `HTTP ${res.status}`;
      throw new HostError(`${label}: ${String(m).slice(0, 300)}`, { status: res.status });
    }
    return data;
  };
}

function netlify({ env, fetchImpl, base }) {
  const o = OPS.netlify;
  const call = client({ token: env.NETLIFY_AUTH_TOKEN, base: base || o.base, fetchImpl, label: 'Netlify' });
  const adapter = {
    id: 'netlify', label: 'Netlify', capabilities: { readValues: true, redeploy: true }, warnings: [],
    async list() {
      adapter.warnings.length = 0;
      const accounts = await call('GET', o.accounts);
      const idBySlug = new Map(accounts.map(a => [a.slug, a.id]));
      const items = [];
      for (const site of await call('GET', o.sites)) {
        const acct = site.account_id || idBySlug.get(site.account_slug);
        if (!acct) { adapter.warnings.push(`${site.name}: no account id`); continue; }
        for (const v of await call('GET', o.env(acct, site.id))) {
          for (const entry of v.values || []) {
            items.push({ platform: 'netlify', project: site.account_slug || 'account', environment: entry.context || 'all', service: site.name, name: v.key, value: v.is_secret || entry.value == null ? null : entry.value, shared: false, scope: { accountId: acct, siteId: site.id, context: entry.context || 'all' } });
          }
        }
      }
      return items;
    },
    async set(scope, changes) {
      const current = await call('GET', o.env(scope.accountId, scope.siteId));
      for (const [key, value] of Object.entries(changes)) {
        const v = current.find(x => x.key === key);
        if (!v) throw new HostError(`Netlify: variable ${key} not found on the site`);
        const values = (v.values || []).map(e => (e.context || 'all') === scope.context ? { ...e, value } : e);
        await call('PUT', o.envKey(scope.accountId, key, scope.siteId), { key, scopes: v.scopes, values: values.map(e => ({ value: e.value, context: e.context })) });
      }
      return Object.keys(changes);
    },
    async redeploy(scope) { await call('POST', o.build(scope.siteId), {}); return { manual: false }; },
    unitKey: (s) => `${s.siteId}|${s.context}`,
  };
  return adapter;
}

function cloudflare({ env, fetchImpl, base }) {
  const o = OPS.cloudflare;
  const acct = env.CLOUDFLARE_ACCOUNT_ID;
  const call = client({ token: env.CLOUDFLARE_API_TOKEN, base: base || o.base, fetchImpl, label: 'Cloudflare' });
  if (!acct) throw new HostError('No Cloudflare account id. Set CLOUDFLARE_ACCOUNT_ID in your own terminal.');
  const adapter = {
    id: 'cloudflare', label: 'Cloudflare', capabilities: { readValues: false, redeploy: true }, warnings: [],
    async list() {
      adapter.warnings.length = 0;
      const items = [];
      for (const s of (await call('GET', o.scripts(acct))).result || []) {
        for (const sec of (await call('GET', o.secrets(acct, s.id))).result || []) items.push({ platform: 'cloudflare', project: 'workers', environment: 'production', service: s.id, name: sec.name, value: null, shared: false, scope: { kind: 'worker', name: s.id } });
      }
      for (const p of (await call('GET', o.pages(acct))).result || []) {
        for (const stage of ['production', 'preview']) {
          for (const [name, v] of Object.entries(p.deployment_configs?.[stage]?.env_vars || {})) {
            if (!v) continue;
            items.push({ platform: 'cloudflare', project: 'pages', environment: stage, service: p.name, name, value: v.type === 'plain_text' ? v.value ?? null : null, shared: false, scope: { kind: 'pages', name: p.name, stage } });
          }
        }
      }
      return items;
    },
    async set(scope, changes) {
      if (scope.kind === 'worker') { for (const [name, text] of Object.entries(changes)) await call('PUT', o.secrets(acct, scope.name), { name, text, type: 'secret_text' }); return Object.keys(changes); }
      const env_vars = Object.fromEntries(Object.entries(changes).map(([k, value]) => [k, { type: 'secret_text', value }]));
      await call('PATCH', o.pagesProject(acct, scope.name), { deployment_configs: { [scope.stage]: { env_vars } } });
      return Object.keys(changes);
    },
    // A Worker picks up a changed secret on its own; a Pages project needs a new deployment.
    async redeploy(scope) { if (scope.kind === 'pages') await call('POST', o.pagesDeploy(acct, scope.name), {}); return { manual: false }; },
    unitKey: (s) => `${s.kind}|${s.name}|${s.stage || ''}`,
  };
  return adapter;
}

function supabase({ env, fetchImpl, base }) {
  const o = OPS.supabase;
  const call = client({ token: env.SUPABASE_ACCESS_TOKEN, base: base || o.base, fetchImpl, label: 'Supabase' });
  const adapter = {
    id: 'supabase', label: 'Supabase Edge Function secrets', capabilities: { readValues: false, redeploy: false }, warnings: [],
    async list() {
      adapter.warnings.length = 0;
      const items = [];
      for (const p of await call('GET', o.projects)) {
        for (const s of await call('GET', o.secrets(p.id))) items.push({ platform: 'supabase', project: p.name, environment: 'edge functions', service: p.name, name: s.name, value: null, shared: false, scope: { ref: p.id } });
      }
      adapter.warnings.push('Supabase: only Edge Function secrets are listed. The anon key, service-role key and JWT secret are issued in the dashboard (Project Settings > API) and cannot be rotated from here.');
      return items;
    },
    async set(scope, changes) { await call('POST', o.secrets(scope.ref), Object.entries(changes).map(([name, value]) => ({ name, value }))); return Object.keys(changes); },
    async redeploy() { return { manual: true, hint: 'Edge Functions read the new secret on their next cold start; redeploy a function from the dashboard or the Supabase CLI if you need it now' }; },
    unitKey: (s) => s.ref,
  };
  return adapter;
}

export function makeHostAdapter(kind, { env = process.env, flags = {}, fetchImpl, base } = {}) {
  const make = { netlify, cloudflare, supabase }[kind];
  if (!make) throw new HostError(`unknown host "${kind}"`);
  return make({ env, flags, fetchImpl, base });
}

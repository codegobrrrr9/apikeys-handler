// A small fake of Railway's GraphQL API: the tests run against it, and `apikeys-handler demo` uses it so you can
// try the dashboard with no account and no real secrets. Every value in demoData() is made up.

import { createServer } from 'node:http';

export function demoData() {
  const env = (id, name) => ({ id, name });
  return {
    projects: [{
      id: 'proj-shop', name: 'shop',
      environments: [env('env-prod', 'production'), env('env-stg', 'staging')],
      services: [{ id: 'svc-web', name: 'web' }, { id: 'svc-api', name: 'api' }, { id: 'svc-worker', name: 'worker' }, { id: 'svc-pg', name: 'Postgres' }, { id: 'svc-redis', name: 'Redis' }],
      vars: {
        'env-prod': {
          shared: { SESSION_SECRET: 'demo-session-secret-aaaaaaaaaaaaaaaaaaaaaaaa', SENTRY_DSN: 'https://demo@o0.ingest.sentry.io/0' },
          'svc-web': {
            APP_KEY: 'base64:ZGVtby1hcHAta2V5LW5vdC1yZWFsLWRlbW8ta2V5LTEyMzQ=', APP_ENV: 'production', PORT: '8080',
            DATABASE_URL: 'postgres://shop:${{Postgres.PGPASSWORD}}@${{Postgres.RAILWAY_PRIVATE_DOMAIN}}:5432/shop', SESSION_SECRET: '${{shared.SESSION_SECRET}}',
            STRIPE_SECRET_KEY: 'sk_live_demo00000000', STRIPE_WEBHOOK_SECRET: 'whsec_demo000000000000000000demo', STRIPE_PUBLISHABLE_KEY: 'pk_live_demo00000000',
            MAIL_PASSWORD: 'demo-smtp-password', SENTRY_DSN: '${{shared.SENTRY_DSN}}',
          },
          'svc-api': {
            JWT_SECRET: 'demo-jwt-secret-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', OPENAI_API_KEY: 'sk-proj-demo00000000000000000000000000demo',
            DATABASE_URL: 'postgres://shop:${{Postgres.PGPASSWORD}}@${{Postgres.RAILWAY_PRIVATE_DOMAIN}}:5432/shop', REDIS_URL: 'redis://:demo-redis-pass@redis.internal:6379',
            AWS_ACCESS_KEY_ID: 'AKIADEMO000000000000', AWS_SECRET_ACCESS_KEY: 'demo/aws/secret/access/key/0000000000demo', AWS_REGION: 'us-east-1', NODE_ENV: 'production',
          },
          'svc-worker': {
            JWT_SECRET: 'demo-jwt-secret-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', REDIS_URL: 'redis://:demo-redis-pass@redis.internal:6379',
            SENDGRID_API_KEY: 'SG.demo00000000000000demo.demo0000000000000000000000000000000000demo', SLACK_BOT_TOKEN: 'xoxb-0000000000-demo000000',
          },
          'svc-pg': { PGPASSWORD: 'demo-postgres-password', POSTGRES_PASSWORD: '${{PGPASSWORD}}', PGUSER: 'shop', RAILWAY_PRIVATE_DOMAIN: 'postgres.railway.internal' },
          'svc-redis': { REDIS_PASSWORD: 'demo-redis-pass' },
        },
        'env-stg': {
          shared: {},
          'svc-web': { APP_KEY: 'base64:c3RhZ2luZy1kZW1vLWFwcC1rZXktbm90LXJlYWwtMTIzNDU=', STRIPE_SECRET_KEY: 'sk_test_demo00000000', PORT: '8080' },
          'svc-api': { JWT_SECRET: 'demo-staging-jwt-secret-cccccccccccccccccc' },
          'svc-worker': {}, 'svc-pg': {}, 'svc-redis': {},
        },
      },
    }],
  };
}

// opts: {data, token, echoErrors, failServiceIds:[], rateLimitFirst, sealedNames:[]}. Returns {url, close, calls, data}.
export function startFakeRailway(opts = {}) {
  const data = opts.data || demoData();
  const token = opts.token || 'demo';
  const calls = [];
  let limited = opts.rateLimitFirst || 0;
  const proj = (id) => data.projects.find(p => p.id === id);
  const conn = (arr) => ({ edges: arr.map(node => ({ node })), pageInfo: { hasNextPage: false, endCursor: null } });
  const project = (p) => ({ id: p.id, name: p.name, services: conn(p.services), environments: conn(p.environments) });

  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const send = (status, body, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
      if (limited > 0) { limited--; return send(429, { errors: [{ message: 'Rate limit exceeded' }] }, { 'Retry-After': '1' }); }
      const auth = req.headers.authorization === `Bearer ${token}` || req.headers['project-access-token'] === token;
      let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return send(400, { errors: [{ message: 'bad json' }] }); }
      const { query = '', variables = {} } = body;
      if (!auth) return send(200, { data: null, errors: [{ message: 'Not Authorized' }] });
      const err = (m) => send(200, { data: null, errors: [{ message: m }] });
      if (/\bprojectToken\b/.test(query)) { calls.push({ op: 'projectToken' }); return send(200, { data: { projectToken: { projectId: data.projects[0].id, environmentId: data.projects[0].environments[0].id } } }); }
      if (/\bprojects\s*\(/.test(query)) { calls.push({ op: 'projects' }); return send(200, { data: { projects: conn(data.projects.map(project)) } }); }
      if (/\bproject\s*\(/.test(query)) { calls.push({ op: 'project' }); const p = proj(variables.id); return p ? send(200, { data: { project: project(p) } }) : err('Project not found'); }
      if (/\bvariables\s*\(/.test(query)) {
        calls.push({ op: 'variables', serviceId: variables.serviceId || null, environmentId: variables.environmentId, unrendered: variables.unrendered });
        const p = proj(variables.projectId); const e = p?.vars[variables.environmentId];
        if (!e) return err('Environment not found');
        const bag = variables.serviceId ? e[variables.serviceId] : e.shared;
        if (!bag) return err('Service not found in environment');
        const out = { ...bag };
        for (const n of opts.sealedNames || []) if (n in out) out[n] = '';       // a sealed variable: the API never returns its value
        return send(200, { data: { variables: out } });
      }
      if (/\bvariableCollectionUpsert\b/.test(query)) {
        const i = variables.input || {};
        calls.push({ op: 'upsert', input: JSON.parse(JSON.stringify(i)) });
        if (opts.failServiceIds?.includes(i.serviceId)) return err('Problem processing request: ' + JSON.stringify(variables));     // an API that echoes its input
        const p = proj(i.projectId); const e = p?.vars[i.environmentId];
        const bag = e && (i.serviceId ? e[i.serviceId] : e.shared);
        if (!bag) return err('Scope not found');
        if (i.replace) for (const k of Object.keys(bag)) if (!(k in i.variables)) delete bag[k];
        Object.assign(bag, i.variables);
        return send(200, { data: { variableCollectionUpsert: true } });
      }
      if (/\bserviceInstanceRedeploy\b/.test(query)) { calls.push({ op: 'redeploy', serviceId: variables.serviceId, environmentId: variables.environmentId }); return send(200, { data: { serviceInstanceRedeploy: true } }); }
      return err('Unknown operation');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ url: `http://127.0.0.1:${port}/graphql/v2`, token, calls, data, close: () => new Promise(r => { server.closeAllConnections?.(); server.close(() => r()); }) });
    });
  });
}

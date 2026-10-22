// Railway adapter (public GraphQL API, https://backboard.railway.com/graphql/v2).
//
// Every operation string lives in OPS below. They were checked against the live schema by unauthenticated
// introspection on 2026-10-22; the behaviour behind a real token (which projects an account or workspace token
// lists, what a project token may query) is NOT verified until the live test in references/platforms.md is run.
//
// Safety rules enforced here:
//  - variableCollectionUpsert is always sent with skipDeploys: true and never with replace (replace deletes every
//    variable not listed).
//  - Variables are read with unrendered: true, so ${{Service.VAR}} references stay references (the engine never
//    writes to a variable it classified as derived).
//  - Errors carry the GraphQL message only, never the request, and pass through redact().

import { redact } from './classify.js';

export const OPS = {
  projects: 'query projects($after: String, $workspaceId: String) { projects(first: 50, after: $after, workspaceId: $workspaceId) { edges { node { id name services(first: 100) { edges { node { id name } } } environments(first: 50) { edges { node { id name } } } } } pageInfo { hasNextPage endCursor } } }',
  projectToken: 'query projectToken { projectToken { projectId environmentId } }',
  project: 'query project($id: String!) { project(id: $id) { id name services(first: 100) { edges { node { id name } } } environments(first: 50) { edges { node { id name } } } } }',
  variables: 'query variables($projectId: String!, $environmentId: String!, $serviceId: String, $unrendered: Boolean) { variables(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId, unrendered: $unrendered) }',
  upsertMany: 'mutation variableCollectionUpsert($input: VariableCollectionUpsertInput!) { variableCollectionUpsert(input: $input) }',
  redeploy: 'mutation serviceInstanceRedeploy($environmentId: String!, $serviceId: String!) { serviceInstanceRedeploy(environmentId: $environmentId, serviceId: $serviceId) }',
};

// Variables Railway injects itself; they cannot be set and are not secrets.
const SYSTEM = /^RAILWAY_(ENVIRONMENT|PROJECT|SERVICE|PUBLIC|PRIVATE|STATIC|GIT|DEPLOYMENT|REPLICA|VOLUME|TCP|RUN|SNAPSHOT|REGION)[A-Z_]*$/;

export class RailwayError extends Error {
  constructor(message, extra = {}) { super(redact(message)); this.name = 'RailwayError'; Object.assign(this, extra); }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const edges = (c) => (c?.edges || []).map(e => e.node);

export function railwayAdapter({ token, tokenType = 'account', endpoint = 'https://backboard.railway.com/graphql/v2', workspaceId = null, project = null, environment = null, maxWaitMs = 60000, fetchImpl = globalThis.fetch } = {}) {
  if (!token) throw new RailwayError('No Railway token. Set RAILWAY_API_TOKEN (account or workspace token) or RAILWAY_TOKEN (project token) in your own terminal.');
  const headers = { 'Content-Type': 'application/json', ...(tokenType === 'project' ? { 'Project-Access-Token': token } : { Authorization: `Bearer ${token}` }) };
  let calls = 0;

  async function gql(query, variables = {}, attempt = 0) {
    calls++;
    let res;
    try { res = await fetchImpl(endpoint, { method: 'POST', headers, body: JSON.stringify({ query, variables }) }); }
    catch (e) { throw new RailwayError('Could not reach Railway: ' + (e.cause?.code || e.message)); }
    if (res.status === 429) {
      const wait = Math.max(1, Number(res.headers.get('retry-after') || 5)) * 1000;
      if (attempt < 3 && wait <= maxWaitMs) { await sleep(wait); return gql(query, variables, attempt + 1); }
      throw new RailwayError(`Railway rate limit hit; retry after ${Math.round(wait / 1000)}s`, { rateLimited: true, retryAfter: wait / 1000 });
    }
    let body;
    const text = await res.text();
    try { body = JSON.parse(text); } catch { throw new RailwayError(`Railway answered HTTP ${res.status} with a non-JSON body`); }
    if (body.errors?.length) throw new RailwayError('Railway: ' + body.errors.map(e => e.message).join('; ').slice(0, 300), { status: res.status });
    if (!res.ok) throw new RailwayError(`Railway answered HTTP ${res.status}`);
    return body.data;
  }

  async function enumerate() {
    const out = [];
    if (tokenType === 'project') {
      const t = (await gql(OPS.projectToken)).projectToken;
      const p = (await gql(OPS.project, { id: t.projectId })).project;
      const envs = edges(p.environments).filter(e => e.id === t.environmentId);
      out.push({ id: p.id, name: p.name, services: edges(p.services), environments: envs.length ? envs : [{ id: t.environmentId, name: 'environment' }] });
      return out;
    }
    let after = null;
    do {
      const d = await gql(OPS.projects, { after, workspaceId });
      for (const n of edges(d.projects)) out.push({ id: n.id, name: n.name, services: edges(n.services), environments: edges(n.environments) });
      after = d.projects.pageInfo?.hasNextPage ? d.projects.pageInfo.endCursor : null;
    } while (after);
    return out;
  }

  const adapter = {
    id: 'railway',
    label: 'Railway',
    capabilities: { readValues: true, redeploy: true },
    warnings: [],
    get calls() { return calls; },
    async list() {
      adapter.warnings.length = 0;
      const items = [];
      for (const p of await enumerate()) {
        if (project && ![p.id, p.name].some(x => String(x).toLowerCase() === String(project).toLowerCase())) continue;
        for (const env of p.environments) {
          if (environment && String(env.name).toLowerCase() !== String(environment).toLowerCase()) continue;
          const targets = [{ id: null, name: null }, ...p.services];
          for (const svc of targets) {
            let vars;
            try { vars = (await gql(OPS.variables, { projectId: p.id, environmentId: env.id, serviceId: svc.id, unrendered: true })).variables; }
            catch (e) {
              if (e.rateLimited) throw e;
              adapter.warnings.push(`${p.name}/${env.name}/${svc.name || 'shared'}: ${e.message}`); continue;
            }
            for (const [name, value] of Object.entries(vars || {})) {
              if (SYSTEM.test(name)) continue;
              items.push({ platform: 'railway', project: p.name, environment: env.name, service: svc.name, shared: svc.id === null, name, value: typeof value === 'string' ? value : String(value ?? ''), scope: { projectId: p.id, environmentId: env.id, serviceId: svc.id } });
            }
          }
        }
      }
      return items;
    },
    // changes: {NAME: value}. One call per scope; skipDeploys true, replace never set.
    async set(scope, changes) {
      const input = { projectId: scope.projectId, environmentId: scope.environmentId, variables: changes, skipDeploys: true };
      if (scope.serviceId) input.serviceId = scope.serviceId;
      await gql(OPS.upsertMany, { input });
      return Object.keys(changes);
    },
    async redeploy(scope) {
      if (!scope.serviceId) throw new RailwayError('a shared-variable scope has no service to redeploy');
      await gql(OPS.redeploy, { environmentId: scope.environmentId, serviceId: scope.serviceId });
      return { manual: false };
    },
    unitKey(scope) { return [scope.projectId, scope.environmentId, scope.serviceId ?? 'shared'].join('|'); },
  };
  return adapter;
}

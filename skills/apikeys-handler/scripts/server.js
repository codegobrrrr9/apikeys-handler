// Local dashboard. Binds 127.0.0.1 on a random port, serves one HTML file, makes no outside requests.
//
// Guards: a one-time token in the URL (sent back as X-AKH-Token on every API call), a Host check (DNS rebinding),
// an Origin check on writes, no CORS headers, no cookies. API responses never contain a value: items are stripped
// of value and scope before they leave this file. New values pasted in the page live in memory for the length of
// one rotation job and are dropped when it ends.

import { createServer } from 'node:http';
import { readFileSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { redact, loadRules } from './classify.js';
import { inventory, buildPlan, rotate, loadState, reportMarkdown, summarize } from './engine.js';

const here = dirname(fileURLToPath(import.meta.url));
const publicItem = (i, state) => {
  const { value, scope, adapter, refs, ...rest } = i;
  const st = state.items[i.id];
  return { ...rest, status: st?.status || 'pending', error: st?.error || null, usedBy: [...new Set(i.usedBy.map(u => u.service))].filter(s => s !== i.service), links: (i.links || []).map(l => `${l.name} (${l.service ?? 'shared'})`) };
};
const publicGroup = (g) => ({ id: g.id, names: g.names, category: g.category, priority: g.priority, how: g.how, provider: g.provider, link: g.link, warns: g.warns, services: g.services, exposed: g.exposed, itemIds: g.items.map(i => i.id) });

export async function createUi({ adapters, dir, exposed = [], port = 0 }) {
  const token = randomBytes(24).toString('hex');
  const html = readFileSync(join(here, 'ui.html'), 'utf8');
  let inv = null, job = null, rules = loadRules(dir);
  const byId = Object.fromEntries(adapters.map(a => [a.id, a]));
  const refresh = async (exp) => { inv = await inventory(adapters, { exposed: exp ?? exposed, rules }); return inv; };
  const eq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };

  const server = createServer(async (req, res) => {
    const addr = server.address();
    const hostOk = [`127.0.0.1:${addr.port}`, `localhost:${addr.port}`].includes(req.headers.host || '');
    const send = (status, body, type = 'application/json') => { res.writeHead(status, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'none'" }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
    if (!hostOk) return send(403, { error: 'bad host' });
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === 'GET' && url.pathname === '/') {
      if (!eq(url.searchParams.get('t') || '', token)) return send(403, 'Open the exact link printed in your terminal.', 'text/plain');
      return send(200, html, 'text/html');
    }
    if (!url.pathname.startsWith('/api/')) return send(404, { error: 'not found' });
    if (!eq(req.headers['x-akh-token'] || '', token)) return send(401, { error: 'missing or wrong token' });
    if (req.method !== 'GET') {
      const origin = req.headers.origin;
      if (origin && ![`http://127.0.0.1:${addr.port}`, `http://localhost:${addr.port}`].includes(origin)) return send(403, { error: 'bad origin' });
    }
    let body = {};
    if (req.method === 'POST') {
      const chunks = []; let n = 0;
      for await (const c of req) { n += c.length; if (n > 1e6) return send(413, { error: 'too large' }); chunks.push(c); }
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return send(400, { error: 'bad json' }); }
    }
    try {
      const state = loadState(dir);
      if (url.pathname === '/api/scan') {
        const exp = (url.searchParams.get('exposed') || '').split(',').map(s => s.trim()).filter(Boolean);
        const r = await refresh(exp.length ? exp : exposed);
        return send(200, { platforms: adapters.map(a => a.label || a.id), warnings: r.warnings.map(redact), exposed: exp.length ? exp : exposed, categoryOrder: rules.categoryOrder, items: r.items.map(i => publicItem(i, state)), summary: summarize(state), job: jobView() });
      }
      if (url.pathname === '/api/plan' && req.method === 'POST') {
        if (!inv) await refresh();
        const plan = buildPlan(inv.items, byId, { ids: body.ids || [], again: !!body.again }, state);
        return send(200, { groups: plan.groups.map(publicGroup), skipped: plan.skipped, estimate: plan.estimate, restartOrder: plan.units.map(u => u.label) });
      }
      if (url.pathname === '/api/rotate' && req.method === 'POST') {
        if (job && job.status === 'running') return send(409, { error: 'a rotation is already running' });
        if (!inv) await refresh();
        const values = body.values && typeof body.values === 'object' ? { ...body.values } : {};
        job = { status: 'running', log: [], startedAt: Date.now(), result: null };
        const me = job;
        (async () => {
          try {
            const r = await rotate(inv.items, adapters, { apply: true, dir, exposed: body.exposed || exposed, sel: { ids: body.ids || [], again: !!body.again }, log: (m) => me.log.push(redact(m)), provide: async (g) => { const v = values[g.id]; values[g.id] = ''; return typeof v === 'string' && v ? v : null; } });
            me.result = { splits: r.splits, written: r.written.length, redeployed: r.redeployed, verified: r.verified.length, failed: r.failed, skipped: r.skippedGroups, manual: r.manualRedeploys, unverified: r.unverified };
            me.status = 'done';
          } catch (e) { me.status = 'error'; me.log.push(redact(e.message)); }
          for (const k of Object.keys(values)) delete values[k];     // pasted values leave memory when the job ends
          try { await refresh(body.exposed || exposed); } catch { /* the next scan will show it */ }
        })();
        return send(202, { started: true });
      }
      if (url.pathname === '/api/job') return send(200, jobView());
      if (url.pathname === '/api/report') return send(200, reportMarkdown((inv || await refresh()).items, state, { exposed }), 'text/markdown');
      if (url.pathname === '/api/quit' && req.method === 'POST') { send(200, { bye: true }); setTimeout(() => server.close(), 50); return; }
      return send(404, { error: 'not found' });
    } catch (e) { return send(500, { error: redact(e && e.message ? e.message : 'error') }); }
  });
  const jobView = () => job ? { status: job.status, log: job.log.slice(-50), result: job.result } : null;
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const p = server.address().port;
  return { url: `http://127.0.0.1:${p}/?t=${token}`, port: p, token, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }), server };
}

function openBrowser(url) {
  try {
    if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url.replace(/&/g, '^&')], { stdio: 'ignore', detached: true }).unref();
    else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore', detached: true }).unref();
  } catch { /* the link is printed anyway */ }
}

export async function startUi({ demo, flags, dir, makeAdapters, out }) {
  let adapters, workDir = dir, fake = null;
  if (demo) {
    const { startFakeRailway } = await import('./demo-railway.js');
    const { railwayAdapter } = await import('./railway.js');
    fake = await startFakeRailway();
    adapters = [railwayAdapter({ token: fake.token, endpoint: fake.url, environment: 'production' })];
    workDir = mkdtempSync(join(tmpdir(), 'apikeys-handler-demo-'));
    out('demo: a fake Railway project with made-up secrets. Nothing real is read or written.');
  } else adapters = await makeAdapters(flags);
  const exposed = typeof flags.exposed === 'string' ? flags.exposed.split(',').map(s => s.trim()).filter(Boolean) : [];
  const ui = await createUi({ adapters, dir: workDir, exposed, port: Number(flags.port) || 0 });
  out(`dashboard: ${ui.url}`);
  out('Local only. Values are held in memory while this runs and never saved. Ctrl+C to stop.');
  if (!flags['no-open']) openBrowser(ui.url);
  await new Promise((r) => ui.server.on('close', r));
  if (fake) await fake.close();
  return 0;
}

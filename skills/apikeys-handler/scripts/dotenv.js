// .env and docker-compose adapter. Rewrites only the value of the lines it changes: comments, order, quoting,
// spacing and line endings elsewhere stay byte for byte. Anything it cannot parse safely is reported, never guessed.
//
// Supported: KEY=VALUE (optional "export "), single and double quotes, trailing " # comment"; docker-compose
// `environment:` as a mapping (KEY: value) or a list (- KEY=value, optionally whole-item quoted), and `env_file:`
// as a scalar or a list. Not supported (reported as "not understood"): multiline values, YAML anchors and aliases,
// flow mappings, block scalars.

import { readFileSync, writeFileSync, readdirSync, existsSync, renameSync, statSync } from 'node:fs';
import { join, basename, relative, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

const NAME = '[A-Za-z_][A-Za-z0-9_.-]*';

// Parse the value token at the start of `rest`. Returns {value, quote, tail} or null when it cannot be parsed on one line.
export function parseValueToken(rest) {
  const first = rest[0];
  if (first === '"' || first === "'") {
    let i = 1;
    while (i < rest.length) {
      if (first === '"' && rest[i] === '\\') { i += 2; continue; }
      if (rest[i] === first) break;
      i++;
    }
    if (i >= rest.length) return null;                       // unterminated on this line: multiline
    const inner = rest.slice(1, i);
    const value = first === '"' ? inner.replace(/\\(["\\])/g, '$1') : inner;
    return { value, quote: first, tail: rest.slice(i + 1) };
  }
  const m = rest.match(/\s+#/);
  const end = m ? m.index : rest.length;
  const raw = rest.slice(0, end);
  const value = raw.replace(/\s+$/, '');
  return { value, quote: '', tail: rest.slice(value.length) };
}

export function renderValueToken(newValue, quote) {
  if (/[\r\n]/.test(newValue)) throw new Error('a new value cannot contain a line break');
  const dq = (v) => '"' + v.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  if (quote === '"') return dq(newValue);
  if (quote === "'") return newValue.includes("'") ? dq(newValue) : "'" + newValue + "'";
  return newValue === '' || /[\s#'"$`\\]/.test(newValue) ? dq(newValue) : newValue;
}

const splitLines = (text) => {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  return { lines: text.split(/\r?\n/), eol };
};

// ---- .env ----
export function parseEnv(text) {
  const { lines } = splitLines(text);
  const entries = [], unsupported = [];
  lines.forEach((line, i) => {
    if (/^\s*(#|$)/.test(line)) return;
    const m = line.match(new RegExp(`^(\\s*(?:export\\s+)?)(${NAME})(\\s*=\\s*)(.*)$`));
    if (!m) { unsupported.push({ line: i + 1, why: 'not a KEY=VALUE line' }); return; }
    const tok = parseValueToken(m[4]);
    if (!tok) { unsupported.push({ line: i + 1, name: m[2], why: 'multiline value' }); return; }
    entries.push({ name: m[2], value: tok.value, lineIndex: i, head: m[1] + m[2] + m[3], quote: tok.quote, tail: tok.tail, kind: 'env', service: null });
  });
  return { entries, unsupported };
}

// ---- docker-compose (limited, line based) ----
export function parseCompose(text) {
  const { lines } = splitLines(text);
  const entries = [], unsupported = [], envFiles = [];            // envFiles: {service, file}
  let inServices = false, serviceIndent = null, service = null;
  let block = null;                                                // {type:'environment'|'env_file', indent}
  const indentOf = (l) => l.match(/^ */)[0].length;
  lines.forEach((line, i) => {
    if (/^\s*(#|$)/.test(line)) return;
    const ind = indentOf(line), t = line.trim();
    if (ind === 0) { inServices = /^services:\s*(#.*)?$/.test(t); service = null; block = null; return; }
    if (!inServices) return;
    if (serviceIndent === null && /^[\w.-]+:\s*(#.*)?$/.test(t)) serviceIndent = ind;
    if (ind === serviceIndent) {
      const m = t.match(/^([\w.-]+):\s*(#.*)?$/);
      if (m) { service = m[1]; block = null; } else { service = null; block = null; unsupported.push({ line: i + 1, why: 'service not understood' }); }
      return;
    }
    if (!service) return;
    if (block && ind > block.indent) {
      if (block.type === 'env_file') {
        const lm = t.match(/^-\s*(?:"([^"]+)"|'([^']+)'|(\S+))\s*(#.*)?$/);
        if (lm) envFiles.push({ service, file: lm[1] || lm[2] || lm[3] });
        return;
      }
      // environment block: list item or mapping line
      const li = line.match(new RegExp(`^(\\s*-\\s+)(.*)$`));
      if (li) {
        const item = li[2];
        let q = '', body = item, tailC = '';
        const wq = item.match(/^(["'])(.*)\1(\s*#.*)?$/);
        if (wq) { q = wq[1]; body = wq[2]; tailC = wq[3] || ''; }
        const km = body.match(new RegExp(`^(${NAME})=(.*)$`));
        if (!km) { if (!new RegExp(`^${NAME}$`).test(body)) unsupported.push({ line: i + 1, why: 'environment item not understood' }); return; }
        if (q) entries.push({ name: km[1], value: km[2], lineIndex: i, head: li[1], quote: q, wholeItem: true, tail: tailC, kind: 'compose-list', service });
        else {
          const tok = parseValueToken(km[2]);
          if (!tok) { unsupported.push({ line: i + 1, name: km[1], why: 'multiline value' }); return; }
          entries.push({ name: km[1], value: tok.value, lineIndex: i, head: li[1] + km[1] + '=', quote: tok.quote, tail: tok.tail, kind: 'compose-list', service });
        }
        return;
      }
      const mm = line.match(new RegExp(`^(\\s+${NAME}:\\s+)(.*)$`)) || null;
      const nm = line.match(new RegExp(`^\\s+(${NAME}):\\s*(#.*)?$`));
      if (nm) return;                                               // KEY: with no value
      if (!mm) { unsupported.push({ line: i + 1, why: 'environment line not understood' }); return; }
      const rest = mm[2];
      if (/^[&*|>{[]|^<</.test(rest)) { unsupported.push({ line: i + 1, name: mm[1].trim().slice(0, -1), why: 'anchor, alias, flow or block value' }); return; }
      const tok = parseValueToken(rest);
      if (!tok) { unsupported.push({ line: i + 1, why: 'multiline value' }); return; }
      const nameOnly = mm[1].trim().replace(/:$/, '');
      entries.push({ name: nameOnly, value: tok.value, lineIndex: i, head: mm[1], quote: tok.quote, tail: tok.tail, kind: 'compose-map', service });
      return;
    }
    block = null;
    const em = t.match(/^environment:\s*(.*)$/);
    if (em) {
      if (em[1] && !em[1].startsWith('#')) { unsupported.push({ line: i + 1, why: 'inline environment not understood' }); return; }
      block = { type: 'environment', indent: ind }; return;
    }
    const fm = t.match(/^env_file:\s*(.*)$/);
    if (fm) {
      const v = fm[1].replace(/\s+#.*$/, '').trim();
      if (v) envFiles.push({ service, file: v.replace(/^["']|["']$/g, '') });
      else block = { type: 'env_file', indent: ind };
    }
  });
  return { entries, unsupported, envFiles };
}

export function renderEntry(e, newValue) {
  if (e.wholeItem) {
    const q = e.quote;
    const inner = e.name + '=' + newValue;
    const esc = q === '"' ? inner.replace(/\\/g, '\\\\').replace(/"/g, '\\"') : inner.replace(/'/g, "''");
    return e.head + q + esc + q + e.tail;
  }
  return e.head + renderValueToken(newValue, e.quote) + e.tail;
}

// Apply {NAME: value} to the text. Only the matching lines change. Returns {text, changed:[names], missing:[names]}.
export function applyChanges(text, parsed, changes, service = null) {
  const { lines, eol } = splitLines(text);
  const changed = [], seen = new Set();
  for (const e of parsed.entries) {
    if (!(e.name in changes)) continue;
    if (service !== null && (e.service || null) !== service) continue;
    lines[e.lineIndex] = renderEntry(e, changes[e.name]);
    changed.push(e.name); seen.add(e.name);
  }
  return { text: lines.join(eol), changed, missing: Object.keys(changes).filter(n => !seen.has(n)) };
}

const isEnvFile = (n) => /^\.env(\..+)?$/.test(n) && !/\.(example|sample|template|dist)$/i.test(n);
const isComposeFile = (n) => /^(docker-)?compose(\..+)?\.ya?ml$/.test(n);

function gitTracked(dir, file) {
  const r = spawnSync('git', ['ls-files', '--error-unmatch', '--', file], { cwd: dir, encoding: 'utf8' });
  return r.status === 0;
}

function atomicWrite(file, text) {
  const tmp = file + '.akh-tmp';
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

export function dotenvAdapter({ dir = process.cwd(), includeExamples = false } = {}) {
  const root = resolve(dir);
  const warnings = [];
  const files = () => {
    const out = { env: [], compose: [] };
    const walk = (d, depth) => {
      let names; try { names = readdirSync(d); } catch { return; }
      for (const n of names) {
        const p = join(d, n);
        let st; try { st = statSync(p); } catch { continue; }
        if (st.isDirectory()) { if (depth < 2 && !/^(node_modules|\.git|vendor|dist|build|\.next)$/.test(n)) walk(p, depth + 1); continue; }
        if (isEnvFile(n) || (includeExamples && /^\.env\./.test(n))) out.env.push(p);
        else if (isComposeFile(n)) out.compose.push(p);
      }
    };
    walk(root, 0);
    return out;
  };

  return {
    id: 'dotenv',
    label: 'Local .env and docker-compose files',
    capabilities: { readValues: true, redeploy: false },
    warnings,
    async list() {
      warnings.length = 0;
      const { env, compose } = files();
      const items = [];
      const fileServices = new Map();                                 // abs env file -> Map(compose service -> compose file)
      for (const cf of compose) {
        const text = readFileSync(cf, 'utf8');
        const p = parseCompose(text);
        for (const u of p.unsupported) warnings.push(`${relative(root, cf)}:${u.line} not understood (${u.why}${u.name ? ', ' + u.name : ''}): rotate by hand`);
        for (const ef of p.envFiles) { const abs = resolve(dirname(cf), ef.file); (fileServices.get(abs) || fileServices.set(abs, new Map()).get(abs)).set(ef.service, cf); }
        for (const e of p.entries) items.push({ platform: 'dotenv', project: basename(root), environment: relative(root, cf), service: e.service, name: e.name, value: e.value, shared: false, scope: { file: cf, kind: 'compose', service: e.service } });
      }
      for (const f of env) {
        const text = readFileSync(f, 'utf8');
        const p = parseEnv(text);
        for (const u of p.unsupported) warnings.push(`${relative(root, f)}:${u.line} not understood (${u.why}${u.name ? ', ' + u.name : ''}): rotate by hand`);
        if (gitTracked(root, f)) warnings.push(`${relative(root, f)} is tracked by git: its old values stay in history, so treat them as exposed and rotate`);
        const svcs = fileServices.get(resolve(f));
        for (const e of p.entries) items.push({ platform: 'dotenv', project: basename(root), environment: relative(root, f), service: svcs ? [...svcs.keys()].sort().join(', ') : null, name: e.name, value: e.value, shared: false, scope: { file: f, kind: 'env', service: null, composeRefs: svcs ? [...svcs.entries()].map(([service, file]) => ({ service, file })) : [] } });
      }
      return items;
    },
    // changes: {NAME: value}. One file write per scope.
    async set(scope, changes) {
      const text = readFileSync(scope.file, 'utf8');
      const parsed = scope.kind === 'compose' ? parseCompose(text) : parseEnv(text);
      const r = applyChanges(text, parsed, changes, scope.kind === 'compose' ? (scope.service || null) : null);
      if (r.missing.length) throw new Error(`${relative(root, scope.file)}: could not find ${r.missing.join(', ')} to rewrite`);
      atomicWrite(scope.file, r.text);
      return r.changed;
    },
    // Nothing to call: say what to run. The tool never restarts your containers for you.
    async redeploy(scope) {
      const rel = relative(root, scope.file);
      if (scope.kind === 'compose' && scope.service) return { manual: true, hint: `docker compose -f ${rel} up -d --force-recreate ${scope.service}` };
      if (scope.composeRefs?.length) return { manual: true, hint: scope.composeRefs.map(r => `docker compose -f ${relative(root, r.file)} up -d --force-recreate ${r.service}`).join(' && ') };
      return { manual: true, hint: `restart whatever reads ${rel}` };
    },
    unitKey(scope) { return `${scope.file}|${scope.service || ''}`; },
  };
}

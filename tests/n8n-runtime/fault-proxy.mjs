// TEST-ONLY deterministic fault injector for the disposable n8n runtime stack.
//
// Data plane (:8080) owns the `analyzer` hostname on the private test network.
// A request matching an armed scenario consumes that scenario's next scripted
// response; everything else is forwarded to the single hard-coded upstream.
// The control plane (:8081) arms scenarios and reads counters; it requires a
// runtime-generated token and never accepts a URL, host or port.
//
// Security properties (see tests/workflows/runtime-harness.test.mjs):
// - forwarding target is the constant UPSTREAM below, never request-derived;
// - absolute-form request targets, CONNECT and unknown methods are refused;
// - header values are never logged or stored; only a boolean records whether
//   n8n attached an X-API-Key header;
// - no host port is published by tests/n8n-runtime/compose.yml.
import crypto from 'node:crypto';
import http from 'node:http';
import { pathToFileURL } from 'node:url';

const UPSTREAM = Object.freeze({ host: 'analyzer-upstream', port: 8080 });
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']);
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host']);
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const MAX_LOG = 5000;

export function templateOf(target) {
  return target.replace(new RegExp(UUID, 'gi'), ':id');
}

export function compilePattern(pattern) {
  if (typeof pattern !== 'string' || !/^\/[A-Za-z0-9/_.:?=&-]{0,300}$/.test(pattern) || pattern.includes('//')) {
    throw new Error('INVALID_PATTERN');
  }
  const source = pattern.split(':uuid').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join(UUID);
  return new RegExp(`^${source}$`, 'i');
}

export function validateResponses(list) {
  if (!Array.isArray(list) || list.length < 1 || list.length > 10) throw new Error('INVALID_RESPONSES');
  return list.map((item) => {
    if (item && Number.isInteger(item.timeout_ms)) {
      if (item.timeout_ms < 1000 || item.timeout_ms > 30000) throw new Error('INVALID_TIMEOUT');
      return { timeout_ms: item.timeout_ms };
    }
    if (!item || !Number.isInteger(item.status) || item.status < 200 || item.status > 599) throw new Error('INVALID_STATUS');
    const out = { status: item.status, forward: item.forward === true };
    if (item.retry_after !== undefined) {
      if (!Number.isInteger(item.retry_after) || item.retry_after < 0 || item.retry_after > 60) throw new Error('INVALID_RETRY_AFTER');
      out.retry_after = item.retry_after;
    }
    if (item.error !== undefined) {
      if (typeof item.error !== 'string' || !/^[A-Z_]{1,40}$/.test(item.error)) throw new Error('INVALID_ERROR_CODE');
      out.error = item.error;
    }
    return out;
  });
}

export function createFaultProxy({ controlToken, upstream = UPSTREAM, now = () => Date.now() }) {
  if (typeof controlToken !== 'string' || controlToken.length < 32) throw new Error('FAULT_CONTROL_TOKEN must be at least 32 characters');
  const scenarios = new Map();
  let log = [];
  let seq = 0;

  function record(entry) {
    seq += 1;
    log.push({ seq, ...entry });
    if (log.length > MAX_LOG) log = log.slice(-MAX_LOG);
    console.log(JSON.stringify({ evt: 'request', method: entry.method, route: entry.route, scenario: entry.scenario ?? null, kind: entry.kind, status: entry.status }));
  }

  function forward(req, onResponse, onError) {
    const headers = {};
    for (const [name, value] of Object.entries(req.headers)) if (!HOP_BY_HOP.has(name)) headers[name] = value;
    headers.host = `${upstream.host}:${upstream.port}`;
    const out = http.request({ host: upstream.host, port: upstream.port, method: req.method, path: req.url, headers }, onResponse);
    out.on('error', onError);
    req.pipe(out);
  }

  function synthetic(res, response) {
    const headers = { 'content-type': 'application/json', 'cache-control': 'no-store' };
    if (response.retry_after !== undefined) headers['retry-after'] = String(response.retry_after);
    res.writeHead(response.status, headers).end(JSON.stringify({ error: response.error ?? `FAULT_INJECTED_${response.status}` }));
  }

  const data = http.createServer((req, res) => {
    if (!METHODS.has(req.method ?? '') || !(req.url ?? '').startsWith('/') || (req.url ?? '').startsWith('//')) {
      res.writeHead(400, { 'content-type': 'application/json' }).end('{"error":"FAULT_PROXY_BAD_TARGET"}');
      req.resume();
      return;
    }
    const target = req.url;
    const route = templateOf(target);
    const hasApiKey = typeof req.headers['x-api-key'] === 'string' && req.headers['x-api-key'].length > 0;
    const scenario = [...scenarios.values()].find((s) => s.method === req.method && s.regex.test(target));
    const base = { method: req.method, route, scenario: scenario?.id, has_api_key: hasApiKey, at: now() };
    // Non-sensitive request shape only (media type and size), never header values.
    const shape = { content_type: String(req.headers['content-type'] ?? '').split(';')[0].slice(0, 60) || null, content_length: Number(req.headers['content-length'] ?? 0) };
    const attempt = scenario ? { n: scenario.attempts.length + 1, t_ms: now() - scenario.armedAt, has_api_key: hasApiKey, ...shape } : null;
    const scripted = scenario && scenario.cursor < scenario.responses.length ? scenario.responses[scenario.cursor++] : null;

    const finish = (kind, status, extra = {}) => {
      record({ ...base, kind, status, ...extra });
      if (attempt) scenario.attempts.push({ ...attempt, kind, status, ...extra });
    };

    if (scripted?.timeout_ms) {
      req.resume();
      const timer = setTimeout(() => { res.socket?.destroy(); }, scripted.timeout_ms);
      res.on('close', () => { clearTimeout(timer); finish('timeout', 0); });
      return;
    }
    if (scripted && !scripted.forward) {
      req.resume();
      synthetic(res, scripted);
      finish('synthetic', scripted.status);
      return;
    }
    forward(req, (upstreamRes) => {
      if (scripted) {
        upstreamRes.resume();
        upstreamRes.on('end', () => { synthetic(res, scripted); finish('forward-then-synthetic', scripted.status, { upstream_status: upstreamRes.statusCode }); });
        return;
      }
      const headers = {};
      for (const [name, value] of Object.entries(upstreamRes.headers)) if (!HOP_BY_HOP.has(name)) headers[name] = value;
      res.writeHead(upstreamRes.statusCode ?? 502, headers);
      upstreamRes.pipe(res);
      finish(scenario ? 'passthrough-after-script' : 'passthrough', upstreamRes.statusCode ?? 0);
    }, () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' }).end('{"error":"FAULT_PROXY_UPSTREAM_UNAVAILABLE"}');
      finish('upstream-error', 502);
    });
  });

  const expected = Buffer.from(controlToken);
  const authorized = (req) => {
    const provided = Buffer.from(String(req.headers['x-fault-control-token'] ?? ''));
    return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
  };
  const json = (res, status, body) => res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body));

  const control = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://control.invalid');
    if (req.method === 'GET' && url.pathname === '/healthz') return json(res, 200, { status: 'ok' });
    if (!authorized(req)) { req.resume(); return json(res, 401, { error: 'UNAUTHORIZED' }); }
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => { size += chunk.length; if (size > 16 * 1024) req.destroy(); else chunks.push(chunk); });
    req.on('end', () => {
      try {
        const match = /^\/scenarios\/([a-z0-9-]{1,64})$/.exec(url.pathname);
        if (req.method === 'PUT' && match) {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
          if (scenarios.has(match[1])) return json(res, 409, { error: 'SCENARIO_EXISTS' });
          if (!['GET', 'POST'].includes(body.method)) return json(res, 400, { error: 'INVALID_METHOD' });
          scenarios.set(match[1], { id: match[1], method: body.method, pattern: body.path, regex: compilePattern(body.path),
            responses: validateResponses(body.responses), cursor: 0, attempts: [], armedAt: now() });
          return json(res, 201, { id: match[1] });
        }
        if (req.method === 'GET' && match) {
          const s = scenarios.get(match[1]);
          if (!s) return json(res, 404, { error: 'SCENARIO_NOT_FOUND' });
          return json(res, 200, { id: s.id, method: s.method, path: s.pattern, scripted: s.responses.length, consumed: s.cursor, attempts: s.attempts });
        }
        if (req.method === 'DELETE' && match) { scenarios.delete(match[1]); return json(res, 204, {}); }
        if (req.method === 'GET' && url.pathname === '/requests') {
          const since = Number(url.searchParams.get('since') ?? 0);
          return json(res, 200, { seq, requests: log.filter((e) => e.seq > since) });
        }
        if (req.method === 'DELETE' && url.pathname === '/state') { scenarios.clear(); log = []; return json(res, 204, {}); }
        return json(res, 404, { error: 'NOT_FOUND' });
      } catch (err) {
        return json(res, 400, { error: String(err.message).startsWith('INVALID') ? err.message : 'BAD_REQUEST' });
      }
    });
  });
  return { data, control };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { data, control } = createFaultProxy({ controlToken: process.env.FAULT_CONTROL_TOKEN });
  data.listen(8080, '0.0.0.0');
  control.listen(8081, '0.0.0.0', () => console.log('fault proxy ready (TEST ONLY): data :8080 -> analyzer-upstream:8080, control :8081'));
}

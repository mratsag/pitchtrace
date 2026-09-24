// TEST-ONLY helpers shared by the n8n runtime scenarios. Runs inside the
// disposable runner container; every address is an internal Compose hostname.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// The runner image is the analyzer image: reuse its pinned dependencies.
export const appRequire = createRequire('/app/package.json');

// The runner shares n8n's network namespace (see compose.yml).
export const N8N = 'http://localhost:5678';
export const OWNER_EMAIL = 'owner@pitchtrace.test';
export const ids = {
  retry: '1a9fd477-eab9-4e4d-9e30-21b7358d0d12',
  main: 'a7c51a73-6dcb-4eb5-a22c-bcd507dc3f80',
  harness: '5d0c3f9e-7a51-4d0b-9f2e-3c1a8e6b2f70',
};

export const env = (name) => {
  const value = process.env[name];
  assert.ok(value, `${name} is required`);
  return value;
};

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Decodes n8n's `flatted` execution payload without an extra dependency. */
export function unflatten(text) {
  const input = JSON.parse(text);
  const seen = new Map();
  const revive = (index) => {
    const value = input[index];
    if (typeof value !== 'object' || value === null) return value;
    if (seen.has(index)) return seen.get(index);
    const out = Array.isArray(value) ? [] : {};
    seen.set(index, out);
    for (const [key, item] of Object.entries(value)) out[key] = typeof item === 'string' ? revive(Number(item)) : item;
    return out;
  };
  return revive(0);
}

export class N8nSession {
  cookie = '';

  async setupOwner(password) {
    const res = await fetch(`${N8N}/rest/owner/setup`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: OWNER_EMAIL, firstName: 'Runtime', lastName: 'Owner', password }),
    });
    assert.equal(res.status, 200, `owner setup failed: ${res.status}`);
    await res.arrayBuffer();
  }

  async login(password) {
    const res = await fetch(`${N8N}/rest/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ emailOrLdapLoginId: OWNER_EMAIL, password }),
    });
    assert.equal(res.status, 200, `n8n login failed: ${res.status}`);
    this.cookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    await res.arrayBuffer();
  }

  async get(path) {
    const res = await fetch(`${N8N}${path}`, { headers: { cookie: this.cookie, accept: 'application/json' } });
    const body = await res.json().catch(() => null);
    assert.equal(res.status, 200, `GET ${path} -> ${res.status}`);
    return body?.data ?? body;
  }

  /** Full execution with decoded runData. */
  async execution(id) {
    const raw = await this.get(`/rest/executions/${id}`);
    const data = typeof raw.data === 'string' ? unflatten(raw.data) : raw.data;
    return { id: String(raw.id), status: raw.status, finished: raw.finished, mode: raw.mode, workflowId: raw.workflowId, data };
  }

  async executions(workflowId, limit = 50) {
    const filter = encodeURIComponent(JSON.stringify({ workflowId }));
    const list = await this.get(`/rest/executions?filter=${filter}&limit=${limit}`);
    return list.results ?? list;
  }

  async waitForExecution(id, predicate, timeoutMs = 60_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const execution = await this.execution(id);
      if (predicate(execution)) return execution;
      if (Date.now() > deadline) throw new Error(`execution ${id} did not reach expected state (status=${execution.status})`);
      await sleep(500);
    }
  }
}

/** Sub-execution references recorded by Execute Workflow nodes. */
export function subExecutions(execution, nodeName) {
  const runs = execution.data?.resultData?.runData?.[nodeName] ?? [];
  return runs.map((run) => run.metadata?.subExecution ?? run.data?.main?.[0]?.[0]?.metadata?.subExecution).filter(Boolean);
}

export const nodeRuns = (execution, nodeName) => execution.data?.resultData?.runData?.[nodeName]?.length ?? 0;

export class FaultControl {
  constructor(token) { this.token = token; }

  async call(method, path, body) {
    const res = await fetch(`http://fault-proxy:8081${path}`, {
      method, headers: { 'x-fault-control-token': this.token, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }

  async arm(id, method, path, responses) {
    const res = await this.call('PUT', `/scenarios/${id}`, { method, path, responses });
    assert.equal(res.status, 201, `arming ${id} failed: ${JSON.stringify(res.body)}`);
  }

  async scenario(id) { return (await this.call('GET', `/scenarios/${id}`)).body; }
  async requests(since = 0) { return (await this.call('GET', `/requests?since=${since}`)).body; }
  async reset() { await this.call('DELETE', '/state'); }
}

export function countRoutes(entries) {
  const counts = {};
  for (const e of entries) counts[`${e.method} ${e.route}`] = (counts[`${e.method} ${e.route}`] ?? 0) + 1;
  return counts;
}

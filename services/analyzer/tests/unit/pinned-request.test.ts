import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { pinnedRequest } from '../../src/security/pinned-request.js';
import { SsrfGuard } from '../../src/security/ssrf.js';

await test('pinli istek Node all:true DNS lookup biçimiyle çalışır', async (t) => {
  const server = http.createServer((_request, response) => response.end('pinned-ok'));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/`;
  const guard = new SsrfGuard({ allowLoopback: true });
  guard.allowLoopbackOrigin(url);

  const result = await pinnedRequest(url, {
    guard,
    maxRedirects: 0,
    maxBytes: 1024,
    timeoutMs: 2_000,
    ignoreHttpsErrors: false,
    method: 'GET',
    headers: {},
    body: null,
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.toString(), 'pinned-ok');
});

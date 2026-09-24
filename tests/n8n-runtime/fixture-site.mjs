// TEST-ONLY fictional website for the disposable n8n runtime stack.
// Binds 127.0.0.1 inside the analyzer's network namespace; serves the
// analyzer's own committed HTML fixtures read-only. No outbound requests.
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

// Runtime-test pages first, then the analyzer's own committed fixtures.
const roots = ['/site-runtime', '/site'];
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript' };

http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://site.pitchtrace.test');
  if (url.pathname === '/robots.txt') {
    res.writeHead(200, { 'content-type': 'text/plain' }).end('User-agent: *\nAllow: /\n');
    return;
  }
  const name = path.basename(url.pathname === '/' ? '/opportunity.html' : url.pathname);
  if (!/^[a-z0-9-]+\.html$/.test(name)) {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    return;
  }
  for (const root of roots) {
    const body = await fs.readFile(path.join(root, name)).catch(() => null);
    if (body) {
      res.writeHead(200, { 'content-type': types[path.extname(name)] ?? 'application/octet-stream' }).end(body);
      return;
    }
  }
  res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
}).listen(9000, '127.0.0.1', () => console.log('fixture site listening on 127.0.0.1:9000 (test only)'));

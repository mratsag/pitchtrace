import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** dist/tests/helpers → services/analyzer/tests/fixtures/site */
const fixtureDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../tests/fixtures/site',
);

export interface FixtureServer {
  origin: string;
  /** Sunucuya ulaşan tüm isteklerin yolları (robots.txt dahil). */
  requests: string[];
  /** robots.txt ve sitemap.xml dışındaki sayfa istekleri. */
  pageRequests(): string[];
  /** Sunucu ayağa kalktıktan sonra sitemap gövdesini ayarlar (origin gerektiği için). */
  setSitemap(body: string | null): void;
  close(): Promise<void>;
}

export interface FixtureServerOptions {
  /** robots.txt gövdesi. null ise 404 döner. */
  robots?: string | null;
  /** sitemap.xml gövdesi. Verilmezse 404 döner. */
  sitemap?: string | null;
}

/** Verilen yolları içeren basit bir urlset sitemap'i üretir. */
export function sitemapXml(origin: string, paths: string[]): string {
  const entries = paths.map((p) => `  <url><loc>${origin}${p}</loc></url>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</urlset>\n`;
}

export async function startFixtureServer(
  options: FixtureServerOptions = {},
): Promise<FixtureServer> {
  const requests: string[] = [];
  const robots = options.robots === undefined ? 'User-agent: *\nAllow: /\n' : options.robots;
  let sitemap = options.sitemap ?? null;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    requests.push(url.pathname);

    if (url.pathname === '/robots.txt') {
      if (robots === null) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(robots);
      return;
    }

    if (url.pathname === '/sitemap.xml') {
      if (sitemap === null) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/xml' });
      res.end(sitemap);
      return;
    }

    // Performans testleri: N bayt gövde döndürür (sayfa ağırlığı ölçümü).
    const bytesMatch = /^\/bytes\/(\d+)$/.exec(url.pathname);
    if (bytesMatch) {
      const size = Math.min(Number.parseInt(bytesMatch[1]!, 10), 20 * 1024 * 1024);
      res.writeHead(200, { 'content-type': 'text/css', 'content-length': String(size) });
      res.end(Buffer.alloc(size, 0x20));
      return;
    }

    // Performans testleri: yanıtı geciktirir (TTFB ölçümü).
    const delayMatch = /^\/delay\/(\d+)\/(.+)$/.exec(url.pathname);
    if (delayMatch) {
      const ms = Math.min(Number.parseInt(delayMatch[1]!, 10), 30_000);
      const name = delayMatch[2]!;
      setTimeout(() => {
        void fs
          .readFile(path.join(fixtureDir, name), 'utf8')
          .then((body) => {
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            res.end(body);
          })
          .catch(() => {
            res.writeHead(404, { 'content-type': 'text/plain' });
            res.end('not found');
          });
      }, ms);
      return;
    }

    // SSRF testi: link-local / cloud metadata adresine yönlendirme.
    if (url.pathname === '/redirect-to-metadata') {
      res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
      res.end();
      return;
    }

    // Redirect zinciri testi.
    if (url.pathname.startsWith('/loop/')) {
      const n = Number.parseInt(url.pathname.slice('/loop/'.length), 10) || 0;
      res.writeHead(302, { location: `/loop/${n + 1}` });
      res.end();
      return;
    }

    const name = url.pathname === '/' ? 'good.html' : url.pathname.replace(/^\//, '');
    if (!/^[a-z0-9._-]+\.html$/i.test(name)) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }

    void fs
      .readFile(path.join(fixtureDir, name), 'utf8')
      .then((body) => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(body);
      })
      .catch(() => {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
      });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no server address');

  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    pageRequests: () => requests.filter((p) => p !== '/robots.txt' && p !== '/sitemap.xml'),
    setSitemap: (body) => {
      sitemap = body;
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

import fs from 'node:fs/promises';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import forge from 'node-forge';

const fixtureDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../tests/fixtures/site',
);

export interface SelfSignedCert {
  key: string;
  cert: string;
}

/**
 * Test için kendinden imzalı sertifika üretir. Geçerlilik penceresi
 * serbestçe verilebildiği için "süresi dolmuş" ve "dolmak üzere"
 * senaryoları gerçek bir TLS sunucusuna karşı test edilebilir.
 *
 * Depoda anahtar saklanmaz; her koşuda yeniden üretilir.
 */
export function generateCert(validFrom: Date, validTo: Date, commonName = 'localhost'): SelfSignedCert {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = validFrom;
  cert.validity.notAfter = validTo;

  const attrs = [{ name: 'commonName', value: commonName }];
  cert.setSubject(attrs);
  cert.setIssuer([{ name: 'commonName', value: 'PitchTrace Test CA' }, ...attrs]);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    {
      name: 'subjectAltName',
      altNames: [
        { type: 2, value: 'localhost' },
        { type: 7, ip: '127.0.0.1' },
      ],
    },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  return {
    key: forge.pki.privateKeyToPem(keys.privateKey),
    cert: forge.pki.certificateToPem(cert),
  };
}

export interface HttpsFixtureServer {
  origin: string;
  requests: string[];
  close(): Promise<void>;
}

export interface HttpsFixtureOptions {
  validFrom?: Date;
  validTo?: Date;
  /** Sayfaya eklenecek ham HTTP (güvensiz) kaynak adresi — mixed content testi. */
  insecureAssetUrl?: string;
}

/**
 * Yerel bir HTTPS fixture sunucusu başlatır.
 * `/tls.html` basit bir sayfa döner; `insecureAssetUrl` verilirse sayfa o
 * adresten bir görsel yükleyerek mixed content üretir.
 */
export async function startHttpsFixtureServer(
  options: HttpsFixtureOptions = {},
): Promise<HttpsFixtureServer> {
  const now = Date.now();
  const validFrom = options.validFrom ?? new Date(now - 86_400_000);
  const validTo = options.validTo ?? new Date(now + 365 * 86_400_000);
  const { key, cert } = generateCert(validFrom, validTo);

  const requests: string[] = [];
  const insecureTag = options.insecureAssetUrl
    ? `<img src="${options.insecureAssetUrl}" alt="guvensiz gorsel" width="10" height="10">`
    : '';

  const server = https.createServer({ key, cert }, (req, res) => {
    const url = new URL(req.url ?? '/', 'https://127.0.0.1');
    requests.push(url.pathname);

    if (url.pathname === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('User-agent: *\nAllow: /\n');
      return;
    }
    if (url.pathname === '/sitemap.xml') {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }

    void fs
      .readFile(path.join(fixtureDir, 'f4-clean.html'), 'utf8')
      .then((body) => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(body.replace('</body>', `${insecureTag}</body>`));
      })
      .catch(() => {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('fixture read error');
      });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no server address');

  return {
    origin: `https://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

import '../helpers/setup-env.js';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { AuditSession } from '../../src/audit/browser.js';
import { technicalChecks } from '../../src/audit/checks/technical.js';
import { evaluateCertificate, fetchCertificate } from '../../src/audit/tls.js';
import { startFixtureServer, type FixtureServer } from '../helpers/fixture-server.js';
import { startHttpsFixtureServer, type HttpsFixtureServer } from '../helpers/tls-fixture.js';

const DAY = 86_400_000;

describe('TLS ve mixed content (gerçek HTTPS fixture sunucusu)', () => {
  let httpServer: FixtureServer;

  before(async () => {
    httpServer = await startFixtureServer();
  });

  after(async () => {
    await httpServer.close();
  });

  it('gerçek sunucudan sertifika okunur ve geçerliyse bulgu üretilmez', async () => {
    const server = await startHttpsFixtureServer();
    try {
      const port = Number.parseInt(new URL(server.origin).port, 10);
      const cert = await fetchCertificate('127.0.0.1', port);
      assert.ok(cert, 'sertifika okunamadı');
      assert.deepEqual(evaluateCertificate(server.origin, cert), []);
    } finally {
      await server.close();
    }
  });

  it('pozitif: süresi dolmuş sertifika gerçek sunucuda TECH_TLS_EXPIRED üretir', async () => {
    const server = await startHttpsFixtureServer({
      validFrom: new Date(Date.now() - 400 * DAY),
      validTo: new Date(Date.now() - 5 * DAY),
    });
    try {
      const port = Number.parseInt(new URL(server.origin).port, 10);
      const cert = await fetchCertificate('127.0.0.1', port);
      assert.ok(cert, 'sertifika okunamadı');
      const findings = evaluateCertificate(server.origin, cert);
      assert.equal(findings[0]?.code, 'TECH_TLS_EXPIRED');
    } finally {
      await server.close();
    }
  });

  it('pozitif: yakında dolacak sertifika gerçek sunucuda uyarı üretir', async () => {
    const server = await startHttpsFixtureServer({
      validTo: new Date(Date.now() + 9 * DAY),
    });
    try {
      const port = Number.parseInt(new URL(server.origin).port, 10);
      const cert = await fetchCertificate('127.0.0.1', port);
      assert.ok(cert, 'sertifika okunamadı');
      assert.equal(evaluateCertificate(server.origin, cert)[0]?.code, 'TECH_TLS_EXPIRING_SOON');
    } finally {
      await server.close();
    }
  });

  it('TLS konuşmayan porttan sertifika okunamaz ve null döner', async () => {
    const port = Number.parseInt(new URL(httpServer.origin).port, 10);
    assert.equal(await fetchCertificate('127.0.0.1', port, 2_000), null);
  });

  it('pozitif: HTTPS sayfada http:// kaynak TECH_MIXED_CONTENT üretir', async () => {
    const server = await startHttpsFixtureServer({
      insecureAssetUrl: `${httpServer.origin}/good.html`,
    });
    // Kendinden imzalı sertifikayı kabul etmesi için tarayıcı ayarı gerekir.
    const session = await AuditSession.open({ allowLoopback: true, ignoreHttpsErrors: true });
    try {
      const rendered = await session.render(`${server.origin}/tls.html`);
      const findings = technicalChecks({
        url: rendered.finalUrl,
        observations: rendered.observations,
        subresourceUrls: rendered.subresourceUrls,
      });
      const mixed = findings.find((f) => f.code === 'TECH_MIXED_CONTENT');
      assert.ok(mixed, `bulgular: ${findings.map((f) => f.code).join(',')}`);
      assert.ok((mixed.metricValue ?? 0) >= 1);
      assert.ok(String((mixed.evidence['samples'] as string[])[0]).startsWith('http://'));
    } finally {
      await session.close();
      await server.close();
    }
  });

  it('negatif: güvensiz kaynak yoksa HTTPS sayfada TECH_MIXED_CONTENT üretilmez', async () => {
    const server = await startHttpsFixtureServer();
    const session = await AuditSession.open({ allowLoopback: true, ignoreHttpsErrors: true });
    try {
      const rendered = await session.render(`${server.origin}/tls.html`);
      const findings = technicalChecks({
        url: rendered.finalUrl,
        observations: rendered.observations,
        subresourceUrls: rendered.subresourceUrls,
      });
      assert.ok(!findings.some((f) => f.code === 'TECH_MIXED_CONTENT'));
    } finally {
      await session.close();
      await server.close();
    }
  });
});

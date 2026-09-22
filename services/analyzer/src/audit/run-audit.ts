import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PAGE_LIMIT_CEILING, config } from '../config.js';
import { query } from '../db/pool.js';
import { getFindingDefinition, type RawFinding } from '../findings/catalog.js';
import { acquireDomainSlot } from '../lib/rate-limiter.js';
import { resolveArtifactPath } from '../security/artifact-path.js';
import { checkUrl } from '../security/ssrf.js';
import {
  AuditSession,
  RenderError,
  type RenderPageOptions,
  type RenderResult,
} from './browser.js';
import { fetchRobots, type RobotsPolicy } from './robots.js';
import { selectPages, type PageRole, type SelectedPage } from './page-selector.js';
import { fetchSitemapUrls } from './sitemap.js';
import { mobileChecks } from './checks/mobile.js';
import { seoChecks } from './checks/seo.js';
import { technicalChecks } from './checks/technical.js';
import { siteChecks, type SitePage } from './checks/site.js';
import { performanceChecks } from './checks/performance.js';
import { fetchPsiFieldData } from './psi.js';
import { computeAndStoreScore } from '../scoring/index.js';
import { evaluateCertificate, fetchCertificate } from './tls.js';

export class AuditFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AuditFailure';
  }
}

interface AuditRow {
  id: string;
  company_id: string;
  entry_url: string;
  page_limit: number;
}

export interface AuditOutcome {
  auditId: string;
  findingCodes: string[];
  finalUrl: string;
  pagesFetched: number;
  pages: Array<{ url: string; role: PageRole; ok: boolean }>;
}

function log(level: 'info' | 'warn', msg: string, extra: object = {}): void {
  console.log(JSON.stringify({ level, msg, ts: new Date().toISOString(), ...extra }));
}

/**
 * Bir audit'i uçtan uca yürütür:
 * SSRF kontrolü → robots → ana sayfa → sayfa seçimi → en fazla 5 sayfa →
 * her sayfa için screenshot + check'ler → DB.
 */
export async function runAudit(auditId: string): Promise<AuditOutcome> {
  const audit = await loadAudit(auditId);

  await query(
    `UPDATE pitchtrace.audits
        SET status='running', started_at=now(), pages_fetched=0,
            error_code=NULL, error_message=NULL
      WHERE id=$1`,
    [auditId],
  );

  try {
    return await withTimeout(
      executeAudit(audit),
      config.auditTimeoutMs,
      () => new AuditFailure('TIMEOUT', `audit exceeded ${config.auditTimeoutMs}ms`),
    );
  } catch (err) {
    const failure = toAuditFailure(err);
    await query(
      `UPDATE pitchtrace.audits
          SET status='failed', finished_at=now(), error_code=$2, error_message=$3
        WHERE id=$1`,
      [auditId, failure.code, failure.message.slice(0, 2000)],
    );
    throw failure;
  }
}

async function executeAudit(audit: AuditRow): Promise<AuditOutcome> {
  // 1) Giriş URL'sinin SSRF doğrulaması (redirect'ler tarayıcıda tekrar doğrulanır).
  const verdict = await checkUrl(audit.entry_url, { allowLoopback: config.ssrfAllowLoopback });
  if (!verdict.ok) throw new AuditFailure(verdict.code, verdict.reason);

  const origin = new URL(audit.entry_url).origin;
  const host = verdict.hostname;

  // 2) robots.txt — doğrulanamıyorsa temkinli davranıp audit'i durduruyoruz.
  await acquireDomainSlot(host, config.perDomainMinIntervalMs);
  const robots = await fetchRobots(origin, { allowLoopback: config.ssrfAllowLoopback });
  if (robots.errorCode) {
    throw new AuditFailure(robots.errorCode, `robots.txt could not be verified for ${origin}`);
  }

  const entryPath = new URL(audit.entry_url).pathname || '/';
  const entryAllowed = robots.policy.isAllowed(entryPath);
  await query('UPDATE pitchtrace.audits SET robots_allowed=$2 WHERE id=$1', [
    audit.id,
    entryAllowed,
  ]);
  if (!entryAllowed) {
    // Hiçbir sayfa AÇILMAZ.
    throw new AuditFailure('ROBOTS_DISALLOWED', `robots.txt disallows ${entryPath} on ${origin}`);
  }

  const pinnedAddress = verdict.addresses[0];
  const session = await AuditSession.open({
    allowLoopback: config.ssrfAllowLoopback,
    ...(config.ssrfPinDns && pinnedAddress
      ? { pinnedHost: { hostname: host, address: pinnedAddress } }
      : {}),
  });

  const visited: Array<{ url: string; role: PageRole; ok: boolean }> = [];
  const sitePages: SitePage[] = [];
  const allFindings: string[] = [];
  let pagesFetched = 0;

  try {
    // 3) Ana sayfa — sayfa seçimi buradan çıkan bağlantılara dayanır.
    await acquireDomainSlot(host, config.perDomainMinIntervalMs);
    const home = await renderWithRetry(session, audit.entry_url, host, {
      measurePerformance: true,
    });
    const homeFindings = await persistPage(audit, home, 'home');
    allFindings.push(...homeFindings);
    pagesFetched += 1;
    visited.push({ url: home.finalUrl, role: 'home', ok: true });
    sitePages.push({ url: home.finalUrl, observations: home.observations });

    // 4) Sitemap (opsiyonel) ve sayfa seçimi.
    const sitemapUrls =
      audit.page_limit > 1
        ? await fetchSitemapUrls(origin, {
            allowLoopback: config.ssrfAllowLoopback,
            extraSitemaps: robots.policy.sitemaps,
            beforeRequest: () => acquireDomainSlot(host, config.perDomainMinIntervalMs),
          })
        : [];

    const selection = selectPages({
      homeUrl: home.finalUrl,
      links: home.observations.links,
      sitemapUrls,
      robots: robots.policy,
      pageLimit: audit.page_limit,
    });

    if (selection.clamped) {
      log('warn', 'page_limit clamped to ceiling', {
        audit_id: audit.id,
        requested: audit.page_limit,
        ceiling: PAGE_LIMIT_CEILING,
      });
    }

    await query('UPDATE pitchtrace.audits SET pages_planned=$2 WHERE id=$1', [
      audit.id,
      selection.pages.length,
    ]);

    // 5) Kalan sayfalar. Tek sayfanın başarısızlığı audit'i düşürmez.
    for (const page of selection.pages.slice(1)) {
      if (pagesFetched >= selection.effectiveLimit) break;
      try {
        await acquireDomainSlot(host, config.perDomainMinIntervalMs);
        const rendered = await renderWithRetry(session, page.url, host);
        const findings = await persistPage(audit, rendered, page.role);
        allFindings.push(...findings);
        pagesFetched += 1;
        visited.push({ url: rendered.finalUrl, role: page.role, ok: true });
        sitePages.push({ url: rendered.finalUrl, observations: rendered.observations });
      } catch (err) {
        const failure = toAuditFailure(err);
        visited.push({ url: page.url, role: page.role, ok: false });
        await recordPageError(audit.id, page, failure);
        log('warn', 'page failed, audit continues', {
          audit_id: audit.id,
          url: page.url,
          code: failure.code,
        });
      }
    }

    // 6) Site kapsamlı check'ler — tüm taranan sayfaların toplamı üzerinden.
    const siteFindings = siteChecks({ siteUrl: home.finalUrl, pages: sitePages });
    const tlsFindings = await tlsChecks(home.finalUrl, host);

    // PSI opsiyoneldir: anahtar yoksa çağrı yapılmaz, hata sessizce yutulur ve
    // bir bulgunun oluşup oluşmayacağını asla değiştirmez.
    const psi = await fetchPsiFieldData(home.finalUrl).catch(() => null);
    const perfFindings = performanceChecks({
      url: home.finalUrl,
      metrics: home.metrics,
      psi,
    });

    const aggregate = [...siteFindings, ...tlsFindings, ...perfFindings];
    await persistFindings(audit, aggregate, null);
    allFindings.push(...aggregate.map((f) => f.code));

    await query(
      `UPDATE pitchtrace.audits
          SET status='completed', finished_at=now(), pages_fetched=$2,
              final_url=$3, bytes_transferred=$4
        WHERE id=$1`,
      [audit.id, pagesFetched, home.finalUrl, session.bytesTransferred],
    );

    // 7) Puanlama — audit tamamlandıktan sonra otomatik.
    // Puanlama hatası audit'i düşürmez: bulgular zaten kayıtlıdır ve puan
    // POST /audits/{id}/score ile yeniden hesaplanabilir.
    try {
      await computeAndStoreScore(audit.id);
    } catch (err) {
      log('warn', 'scoring failed', {
        audit_id: audit.id,
        err: (err as Error).message,
      });
    }

    // Redirect sonucu yalnızca resolved_url'e yazılır; submitted_url ezilmez.
    await query(
      'UPDATE pitchtrace.companies SET resolved_url = COALESCE(resolved_url, $2) WHERE id = $1',
      [audit.company_id, home.finalUrl],
    );

    return {
      auditId: audit.id,
      findingCodes: allFindings,
      finalUrl: home.finalUrl,
      pagesFetched,
      pages: visited,
    };
  } finally {
    await session.close();
  }
}

/** Tek sayfa için en fazla bir yeniden deneme (docs/design F3). */
async function renderWithRetry(
  session: AuditSession,
  url: string,
  host: string,
  options: RenderPageOptions = {},
): Promise<RenderResult> {
  try {
    return await session.render(url, options);
  } catch (err) {
    const failure = toAuditFailure(err);
    if (!RETRYABLE_PAGE_ERRORS.has(failure.code)) throw failure;
    await acquireDomainSlot(host, config.perDomainMinIntervalMs);
    return session.render(url, options);
  }
}

/** Yalnızca geçici olması muhtemel hatalar tekrar denenir. */
const RETRYABLE_PAGE_ERRORS = new Set(['TIMEOUT', 'RENDER_CRASH', 'HTTP_ERROR']);

async function persistPage(
  audit: AuditRow,
  rendered: RenderResult,
  role: PageRole,
): Promise<string[]> {
  const artifactId = await storeScreenshot(audit.id, rendered.screenshot);

  await query(
    `INSERT INTO pitchtrace.audit_pages
       (audit_id, url, role, http_status, final_url, load_ms, html_bytes, blocked_resources)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
     ON CONFLICT (audit_id, url) DO NOTHING`,
    [
      audit.id,
      rendered.finalUrl,
      role,
      rendered.httpStatus,
      rendered.finalUrl,
      rendered.loadMs,
      rendered.observations.htmlBytes,
      JSON.stringify(rendered.blockedResources),
    ],
  );

  const raw: RawFinding[] = [
    ...mobileChecks(rendered.finalUrl, rendered.observations),
    ...seoChecks(rendered.finalUrl, rendered.observations),
    ...technicalChecks({
      url: rendered.finalUrl,
      observations: rendered.observations,
      subresourceUrls: rendered.subresourceUrls,
    }),
  ];

  await persistFindings(audit, raw, artifactId);
  return raw.map((f) => f.code);
}

/** Ham bulguları katalogla zenginleştirip kaydeder. */
async function persistFindings(
  audit: AuditRow,
  raw: RawFinding[],
  artifactId: string | null,
): Promise<void> {
  for (const finding of raw) {
    const def = getFindingDefinition(finding.code);
    await query(
      `INSERT INTO pitchtrace.findings
         (audit_id, company_id, code, category, severity, confidence, url,
          evidence, metric_name, metric_value, metric_unit, artifact_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12)
       ON CONFLICT (audit_id, code, url) DO NOTHING`,
      [
        audit.id,
        audit.company_id,
        def.code,
        def.category,
        def.severity,
        def.confidence,
        finding.url,
        JSON.stringify(finding.evidence),
        finding.metricName ?? null,
        finding.metricValue ?? null,
        finding.metricUnit ?? null,
        artifactId,
      ],
    );
  }
}

/**
 * TLS sertifikası kontrolü. Yalnızca https siteler için çalışır; sertifika
 * okunamazsa sessizce atlanır (bağlantı zaten kurulabildiği için bu bir
 * ölçüm eksikliğidir, bir bulgu değildir).
 */
async function tlsChecks(siteUrl: string, hostname: string): Promise<RawFinding[]> {
  if (!siteUrl.startsWith('https://')) return [];
  const port = Number.parseInt(new URL(siteUrl).port || '443', 10);
  const cert = await fetchCertificate(hostname, port);
  if (cert === null) return [];
  return evaluateCertificate(siteUrl, cert);
}

async function recordPageError(
  auditId: string,
  page: SelectedPage,
  failure: AuditFailure,
): Promise<void> {
  await query(
    `INSERT INTO pitchtrace.audit_pages (audit_id, url, role, error)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (audit_id, url) DO NOTHING`,
    [auditId, page.url, page.role, `${failure.code}: ${failure.message}`.slice(0, 1000)],
  ).catch(() => undefined);
}

async function storeScreenshot(auditId: string, png: Buffer): Promise<string> {
  const relPath = path.posix.join('screenshots', auditId, `${crypto.randomUUID()}.png`);
  const absolute = resolveArtifactPath(config.artifactRoot, relPath);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, png);

  const sha256 = crypto.createHash('sha256').update(png).digest('hex');
  const result = await query<{ id: string }>(
    `INSERT INTO pitchtrace.artifacts (audit_id, kind, rel_path, mime, bytes, sha256)
     VALUES ($1,'screenshot',$2,'image/png',$3,$4) RETURNING id`,
    [auditId, relPath, png.byteLength, sha256],
  );
  return result.rows[0]!.id;
}

async function loadAudit(auditId: string): Promise<AuditRow> {
  const result = await query<AuditRow>(
    'SELECT id, company_id, entry_url, page_limit FROM pitchtrace.audits WHERE id = $1',
    [auditId],
  );
  const row = result.rows[0];
  if (!row) throw new AuditFailure('NOT_FOUND', `audit ${auditId} not found`);
  return row;
}

function toAuditFailure(err: unknown): AuditFailure {
  if (err instanceof AuditFailure) return err;
  if (err instanceof RenderError) return new AuditFailure(err.code, err.message);
  return new AuditFailure('RENDER_CRASH', (err as Error)?.message ?? String(err));
}

async function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(onTimeout()), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export type { RobotsPolicy };

import tls from 'node:tls';
import type { RawFinding } from '../findings/catalog.js';

/** Sertifikanın bitişine bu süreden az kaldıysa uyarı üretilir. */
export const TLS_EXPIRY_WARNING_DAYS = 21;

/** Peer sertifika alanları dizi de olabilir; ilk değeri alır. */
function first(value: string | string[] | undefined): string | null {
  if (value === undefined) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

export interface CertificateInfo {
  validFrom: Date;
  validTo: Date;
  issuer: string | null;
  subject: string | null;
}

/**
 * Sunucunun TLS sertifikasını okur. Süresi dolmuş veya kendinden imzalı
 * sertifikaları da inceleyebilmek için doğrulama kapatılır; bağlantı yalnızca
 * sertifikayı okumak için kurulur ve hemen kapatılır, veri gönderilmez.
 *
 * Çağıran, hostname'i SSRF guard'ından geçirmiş olmalıdır.
 */
export function fetchCertificate(
  hostname: string,
  port = 443,
  timeoutMs = 10_000,
): Promise<CertificateInfo | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: CertificateInfo | null): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };

    const socket = tls.connect(
      { host: hostname, port, servername: hostname, rejectUnauthorized: false, timeout: timeoutMs },
      () => {
        const cert = socket.getPeerCertificate();
        if (!cert || Object.keys(cert).length === 0 || !cert.valid_to) {
          finish(null);
          return;
        }
        const validTo = new Date(cert.valid_to);
        const validFrom = new Date(cert.valid_from);
        if (Number.isNaN(validTo.getTime())) {
          finish(null);
          return;
        }
        finish({
          validTo,
          validFrom: Number.isNaN(validFrom.getTime()) ? validTo : validFrom,
          issuer: first(cert.issuer?.O) ?? first(cert.issuer?.CN),
          subject: first(cert.subject?.CN),
        });
      },
    );

    socket.setTimeout(timeoutMs, () => finish(null));
    socket.on('error', () => finish(null));
  });
}

/**
 * Sertifika bilgisinden bulgu üretir. Ağdan bağımsızdır; bu sayede süresi
 * dolmuş / dolmak üzere / geçerli senaryoları doğrudan test edilebilir.
 */
export function evaluateCertificate(
  url: string,
  cert: CertificateInfo,
  now: Date = new Date(),
): RawFinding[] {
  const msRemaining = cert.validTo.getTime() - now.getTime();
  const daysRemaining = Math.floor(msRemaining / 86_400_000);

  const evidence = {
    valid_to: cert.validTo.toISOString(),
    valid_from: cert.validFrom.toISOString(),
    issuer: cert.issuer,
    subject: cert.subject,
  };

  if (msRemaining <= 0) {
    return [
      {
        code: 'TECH_TLS_EXPIRED',
        url,
        evidence: { ...evidence, days_overdue: Math.abs(daysRemaining) },
        metricName: 'tls_days_remaining',
        metricValue: daysRemaining,
        metricUnit: 'days',
      },
    ];
  }

  if (daysRemaining < TLS_EXPIRY_WARNING_DAYS) {
    return [
      {
        code: 'TECH_TLS_EXPIRING_SOON',
        url,
        evidence: { ...evidence, warning_threshold_days: TLS_EXPIRY_WARNING_DAYS },
        metricName: 'tls_days_remaining',
        metricValue: daysRemaining,
        metricUnit: 'days',
      },
    ];
  }

  return [];
}

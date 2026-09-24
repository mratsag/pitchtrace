import crypto from 'node:crypto';
import { config } from '../config.js';

const READ_PURPOSE = 'artifact-preview/read';
const REFRESH_PURPOSE = 'artifact-preview/refresh';
const TOKEN_VERSION = 1;

interface PreviewClaims { v: number; artifact_id: string; purpose: string; exp: number; nonce: string }

function b64url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url');
}

function sign(payload: string, secret = config.previewTokenSecret): Buffer {
  if (!secret) throw new Error('PREVIEW_TOKEN_SECRET is required');
  return crypto.createHmac('sha256', secret).update(payload).digest();
}

export function createPreviewToken(artifactId: string, nowMs = Date.now()): { token: string; expiresAt: string } {
  const exp = Math.floor(nowMs / 1000) + config.previewTokenTtlSeconds;
  const payload = b64url(JSON.stringify({ v: TOKEN_VERSION, artifact_id: artifactId, purpose: READ_PURPOSE, exp, nonce: crypto.randomBytes(12).toString('base64url') } satisfies PreviewClaims));
  return { token: `${payload}.${b64url(sign(payload))}`, expiresAt: new Date(exp * 1000).toISOString() };
}

export function createPreviewRefreshHandle(artifactId: string, nowMs = Date.now()): { handle: string; expiresAt: string } {
  const exp = Math.floor(nowMs / 1000) + config.previewRefreshTtlSeconds;
  const payload = b64url(JSON.stringify({ v: TOKEN_VERSION, artifact_id: artifactId, purpose: REFRESH_PURPOSE, exp, nonce: crypto.randomBytes(12).toString('base64url') } satisfies PreviewClaims));
  return { handle: `${payload}.${b64url(sign(payload))}`, expiresAt: new Date(exp * 1000).toISOString() };
}

function verify(token: string, purpose: string, nowMs: number): { artifactId: string } | null {
  if (token.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) return null;
  const [payload, encodedSignature] = token.split('.');
  try {
    const actual = Buffer.from(encodedSignature!, 'base64url');
    const expected = sign(payload!);
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
    const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8')) as PreviewClaims;
    if (claims.v !== TOKEN_VERSION || claims.purpose !== purpose) return null;
    if (typeof claims.nonce !== 'string' || claims.nonce.length < 12) return null;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(claims.artifact_id)) return null;
    if (!Number.isInteger(claims.exp) || claims.exp <= Math.floor(nowMs / 1000)) return null;
    return { artifactId: claims.artifact_id };
  } catch { return null; }
}

export const verifyPreviewToken = (token: string, nowMs = Date.now()) => verify(token, READ_PURPOSE, nowMs);
export const verifyPreviewRefreshHandle = (token: string, nowMs = Date.now()) => verify(token, REFRESH_PURPOSE, nowMs);

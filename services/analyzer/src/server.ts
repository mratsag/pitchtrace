import Fastify, { type FastifyInstance } from 'fastify';
import { config } from './config.js';
import { query } from './db/pool.js';
import { auditRoutes } from './routes/audits.js';
import { campaignRoutes } from './routes/campaigns.js';
import { artifactRoutes } from './routes/artifacts.js';
import { draftRoutes } from './routes/drafts.js';
import { suppressionRoutes } from './routes/suppression.js';
import { importRoutes } from './routes/imports.js';
import { campaignAuditRoutes } from './routes/campaign-audits.js';

const PUBLIC_PATHS = new Set(['/healthz']);

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    bodyLimit: 1 * 1024 * 1024,
    trustProxy: false,
  });

  app.addHook('onRequest', async (request, reply) => {
    if (PUBLIC_PATHS.has(request.routeOptions.url ?? request.url)) return;
    const provided = request.headers['x-api-key'];
    if (typeof provided !== 'string' || provided !== config.apiKey) {
      return reply.code(401).send();
    }
  });

  app.addContentTypeParser(/^multipart\/form-data(?:;.*)?$/i,{parseAs:'buffer',bodyLimit:256*1024},(_request,body,done)=>done(null,body));

  app.get('/healthz', async () => {
    let db = 'down';
    let queueDepth = -1;
    try {
      const result = await query<{ queued: string }>(
        "SELECT count(*)::text AS queued FROM pitchtrace.audit_jobs WHERE status='queued'",
      );
      db = 'up';
      queueDepth = Number(result.rows[0]?.queued ?? 0);
    } catch {
      db = 'down';
    }
    return { status: db === 'up' ? 'ok' : 'degraded', db, queue_depth: queueDepth, version: config.version };
  });

  await app.register(campaignRoutes);
  await app.register(auditRoutes);
  await app.register(artifactRoutes);
  await app.register(draftRoutes);
  await app.register(suppressionRoutes);
  await app.register(importRoutes);
  await app.register(campaignAuditRoutes);

  return app;
}

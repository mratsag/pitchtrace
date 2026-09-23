import fs from 'node:fs/promises';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { query } from '../db/pool.js';
import { ArtifactPathError, resolveArtifactPathReal } from '../security/artifact-path.js';
import { createPreviewToken, verifyPreviewToken } from '../security/preview-token.js';

interface ArtifactRow {
  id: string;
  rel_path: string;
  mime: string;
  bytes: number;
  deleted_at: string | null;
}

export async function artifactRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { id: string } }>('/artifacts/:id/preview-access', {
    schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } },
  }, async (request, reply) => {
    const result = await query<Pick<ArtifactRow, 'id'|'mime'|'deleted_at'>>(
      'SELECT id, mime, deleted_at FROM pitchtrace.artifacts WHERE id=$1', [request.params.id]);
    const row = result.rows[0];
    if (!row || row.deleted_at !== null) return reply.code(404).send({ error: 'ARTIFACT_NOT_FOUND' });
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(row.mime)) return reply.code(415).send({ error: 'UNSUPPORTED_PREVIEW_TYPE' });
    const access = createPreviewToken(row.id);
    const relative = `/artifact-previews/${access.token}`;
    return reply.send({ artifact_id: row.id, preview_url: config.publicBaseUrl ? new URL(relative, config.publicBaseUrl).toString() : relative, expires_at: access.expiresAt });
  });

  app.get<{ Params: { token: string } }>('/artifact-previews/:token', async (request, reply) => {
    const verified = verifyPreviewToken(request.params.token);
    if (!verified) return reply.code(401).headers(previewHeaders()).send({ error: 'PREVIEW_TOKEN_INVALID_OR_EXPIRED' });
    return sendArtifact(verified.artifactId, request, reply, true);
  });

  app.get<{ Params: { id: string } }>(
    '/artifacts/:id',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
      },
    },
    async (request, reply) => sendArtifact(request.params.id, request, reply, false),
  );
}

function previewHeaders(): Record<string,string> {
  return { 'cache-control':'private, no-store', pragma:'no-cache', 'x-content-type-options':'nosniff',
    'content-security-policy':"default-src 'none'; img-src 'self'", 'referrer-policy':'no-referrer' };
}

async function sendArtifact(id: string, request: FastifyRequest, reply: FastifyReply, preview: boolean): Promise<unknown> {
      const result = await query<ArtifactRow>(
        'SELECT id, rel_path, mime, bytes, deleted_at FROM pitchtrace.artifacts WHERE id=$1',
        [id],
      );
      const row = result.rows[0];
      if (!row) return reply.code(404).send({ error: 'ARTIFACT_NOT_FOUND' });
      if (row.deleted_at !== null) return reply.code(404).send({ error: 'ARTIFACT_GONE' });
      if (preview && !['image/png', 'image/jpeg', 'image/webp'].includes(row.mime)) return reply.code(415).headers(previewHeaders()).send({ error: 'UNSUPPORTED_PREVIEW_TYPE' });

      let absolute: string;
      try {
        // Kök dışına çıkan her yol reddedilir (symlink'ler dahil).
        absolute = await resolveArtifactPathReal(config.artifactRoot, row.rel_path);
      } catch (err) {
        if (err instanceof ArtifactPathError) {
          request.log.error({ artifact_id: row.id, rel_path: row.rel_path }, 'artifact path escape');
          return reply.code(400).send({ error: 'PATH_TRAVERSAL' });
        }
        throw err;
      }

      let body: Buffer;
      try {
        body = await fs.readFile(absolute);
      } catch {
        return reply.code(404).send({ error: 'ARTIFACT_GONE' });
      }

      return reply
        .header('content-type', row.mime)
        .header('content-length', String(body.byteLength))
        .header('content-disposition', `inline; filename="${row.id}.${row.mime === 'image/jpeg' ? 'jpg' : row.mime.split('/')[1]}"`)
        .headers(preview ? previewHeaders() : { 'cache-control': 'private, no-store', pragma: 'no-cache', 'x-content-type-options': 'nosniff' })
        .send(body);
}

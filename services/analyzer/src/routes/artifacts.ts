import fs from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { query } from '../db/pool.js';
import { ArtifactPathError, resolveArtifactPathReal } from '../security/artifact-path.js';

interface ArtifactRow {
  id: string;
  rel_path: string;
  mime: string;
  bytes: number;
  deleted_at: string | null;
}

export async function artifactRoutes(app: FastifyInstance): Promise<void> {
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
    async (request, reply) => {
      const result = await query<ArtifactRow>(
        'SELECT id, rel_path, mime, bytes, deleted_at FROM pitchtrace.artifacts WHERE id=$1',
        [request.params.id],
      );
      const row = result.rows[0];
      if (!row) return reply.code(404).send({ error: 'ARTIFACT_NOT_FOUND' });
      if (row.deleted_at !== null) return reply.code(404).send({ error: 'ARTIFACT_GONE' });

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
        .header('content-disposition', `inline; filename="${row.id}.png"`)
        .header('cache-control', 'private, max-age=300')
        .send(body);
    },
  );
}

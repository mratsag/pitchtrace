import fs from 'node:fs/promises';
import { config } from '../config.js';
import { query } from '../db/pool.js';
import { ArtifactPathError, resolveArtifactPath } from '../security/artifact-path.js';

export interface CleanupResult {
  examined: number;
  deleted: number;
  missing: number;
  failed: number;
}

/**
 * Saklama süresi dolmuş artifact dosyalarını siler ve kayıtları
 * `deleted_at` ile işaretler. Kayıt silinmez: bulgu geçmişi korunur,
 * yalnızca dosya gider ve `GET /artifacts/{id}` 404 ARTIFACT_GONE döner.
 */
export async function cleanupExpiredArtifacts(
  retentionDays = config.artifactRetentionDays,
): Promise<CleanupResult> {
  const expired = await query<{ id: string; rel_path: string }>(
    `SELECT id, rel_path FROM pitchtrace.artifacts
      WHERE deleted_at IS NULL
        AND created_at < now() - make_interval(days => $1)
      ORDER BY created_at
      LIMIT 500`,
    [retentionDays],
  );

  const result: CleanupResult = {
    examined: expired.rowCount ?? 0,
    deleted: 0,
    missing: 0,
    failed: 0,
  };

  for (const row of expired.rows) {
    let absolute: string;
    try {
      absolute = resolveArtifactPath(config.artifactRoot, row.rel_path);
    } catch (err) {
      if (err instanceof ArtifactPathError) {
        // Kök dışını gösteren kayıt silinmeye çalışılmaz, yalnızca işaretlenir.
        await markDeleted(row.id);
        result.failed += 1;
        continue;
      }
      throw err;
    }

    try {
      await fs.unlink(absolute);
      result.deleted += 1;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        result.missing += 1;
      } else {
        result.failed += 1;
        continue;
      }
    }
    await markDeleted(row.id);
  }

  return result;
}

async function markDeleted(id: string): Promise<void> {
  await query('UPDATE pitchtrace.artifacts SET deleted_at = now() WHERE id = $1', [id]);
}

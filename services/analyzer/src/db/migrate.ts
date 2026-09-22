import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPool } from './pool.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** dist/src/db → repo/database/migrations (container ve yerel geliştirmede aynı). */
export function defaultMigrationsDir(): string {
  const fromEnv = process.env.MIGRATIONS_DIR;
  if (fromEnv) return path.resolve(fromEnv);
  return path.resolve(here, '../../../../../database/migrations');
}

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

/** Migration'ları sırayla ve idempotent biçimde uygular. */
export async function migrate(dir = defaultMigrationsDir()): Promise<MigrationResult> {
  const pool = getPool();
  const client = await pool.connect();
  const applied: string[] = [];
  const skipped: string[] = [];

  try {
    await client.query('CREATE SCHEMA IF NOT EXISTS pitchtrace');
    await client.query(`
      CREATE TABLE IF NOT EXISTS pitchtrace.schema_migrations (
        filename    text PRIMARY KEY,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )
    `);

    const entries = (await fs.readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    if (entries.length === 0) throw new Error(`no migrations found in ${dir}`);

    for (const filename of entries) {
      const done = await client.query(
        'SELECT 1 FROM pitchtrace.schema_migrations WHERE filename = $1',
        [filename],
      );
      if ((done.rowCount ?? 0) > 0) {
        skipped.push(filename);
        continue;
      }
      const sql = await fs.readFile(path.join(dir, filename), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO pitchtrace.schema_migrations (filename) VALUES ($1)', [
          filename,
        ]);
        await client.query('COMMIT');
        applied.push(filename);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${filename} failed: ${(err as Error).message}`);
      }
    }
  } finally {
    client.release();
  }

  return { applied, skipped };
}

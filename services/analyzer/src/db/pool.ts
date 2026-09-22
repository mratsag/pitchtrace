import pg from 'pg';
import { config } from '../config.js';

let pool: pg.Pool | undefined;

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: config.databaseUrl,
      max: Number.parseInt(process.env.PGPOOL_MAX ?? '10', 10),
      application_name: 'pitchtrace-analyzer',
    });
    // Boşta kalan bağlantıdaki hata process'i düşürmesin.
    pool.on('error', (err) => {
      console.error(JSON.stringify({ level: 'error', msg: 'pg idle client error', err: err.message }));
    });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    const current = pool;
    pool = undefined;
    await current.end();
  }
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<pg.QueryResult<T>> {
  return getPool().query<T>(text, params as never[]);
}

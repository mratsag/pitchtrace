import { closePool } from './pool.js';
import { migrate } from './migrate.js';

try {
  const result = await migrate();
  console.log(
    JSON.stringify({ level: 'info', msg: 'migrations complete', ...result }, null, 2),
  );
} catch (err) {
  console.error(JSON.stringify({ level: 'error', msg: (err as Error).message }));
  process.exitCode = 1;
} finally {
  await closePool();
}

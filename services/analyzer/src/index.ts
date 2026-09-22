import { assertRuntimeConfig, config } from './config.js';
import { closePool } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { buildServer } from './server.js';
import { WorkerPool } from './worker.js';
import { cleanupExpiredArtifacts } from './audit/artifact-cleanup.js';

assertRuntimeConfig();

if (process.env.RUN_MIGRATIONS_ON_BOOT === 'true') {
  const result = await migrate();
  console.log(JSON.stringify({ level: 'info', msg: 'migrations applied', ...result }));
}

const app = await buildServer();
const workers = new WorkerPool();

await app.listen({ host: config.host, port: config.port });
workers.start();
app.log.info({ concurrency: config.auditConcurrency }, 'pitchtrace analyzer ready');

// Günlük artifact temizliği (docs/design §2.7).
const cleanupTimer = setInterval(
  () => {
    void cleanupExpiredArtifacts()
      .then((result) => {
        if (result.examined > 0) app.log.info(result, 'artifact cleanup');
      })
      .catch((err) => app.log.error({ err }, 'artifact cleanup failed'));
  },
  24 * 60 * 60 * 1000,
);
cleanupTimer.unref();

let shuttingDown = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'graceful shutdown started');
    void (async () => {
      try {
        // 1) Yeni HTTP isteği kabul etme. 2) Worker'lar yeni iş almasın.
        clearInterval(cleanupTimer);
        await app.close();
        await workers.stop();
      } catch (err) {
        app.log.error({ err }, 'shutdown error');
      } finally {
        await closePool().catch(() => undefined);
        process.exit(0);
      }
    })();
  });
}

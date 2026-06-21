import { env } from '@/Utils/Env';
import { buildApp } from '@/app';
import { logger } from '@/logger';

import Encryption from '@/Services/Encryption';
import { createAuditLog } from '@/Services/AuditLog';
import { createDatabase } from '@/db';
import { runMigrations } from '@/db/migrate';
import { createDbPool, getQueryable, testConnection } from '@/db/pool';
import { seedDevAccount } from '@/db/seedDev';

async function main() {
    const pool = createDbPool();
    const dbReady = await testConnection(pool);
    if (!dbReady) {
        logger.fatal('Database connection failed; aborting startup');
        process.exit(1);
    }

    await runMigrations(pool);

    if (process.env.SEED_DEV === 'true') {
        await seedDevAccount(pool);
    }

    const db = createDatabase(getQueryable(pool));
    const crypt = new Encryption(env.CRYPT_KEY_A, env.CRYPT_KEY_B);

    const app = await buildApp({ db, crypt });

    const shutdown = async (signal: string) => {
        logger.info({ signal }, 'Shutting down');
        try {
            await app.close();
            await pool.end();
            process.exit(0);
        } catch (e) {
            logger.error({ err: (e as Error).message }, 'Error during shutdown');
            process.exit(1);
        }
    };
    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));

    // Hourly retention sweep: drop history past each device's retention
    // (NULL → METRICS_RETENTION_DAYS). Runs once at boot, then every hour.
    const prune = async () => {
        try {
            const days = env.METRICS_RETENTION_DAYS;
            const [metrics, presence, processes] = await Promise.all([
                db.metrics.pruneByRetention(days),
                db.presence.pruneByRetention(days),
                db.processSamples.pruneByRetention(env.PROCESS_RETENTION_DAYS)
            ]);
            if (metrics + presence + processes > 0) {
                logger.info({ metrics, presence, processes }, 'Pruned old monitoring history');
            }
        } catch (e) {
            logger.error({ err: (e as Error).message }, 'Retention sweep failed');
        }
    };
    void prune();
    const pruneTimer = setInterval(() => void prune(), 60 * 60 * 1000);
    pruneTimer.unref();

    await app.listen({ port: env.LISTEN_PORT, host: '0.0.0.0' });
    logger.info({ port: env.LISTEN_PORT }, 'DevEye server ready');

    createAuditLog(db).record({
        source: 'system',
        category: 'system',
        action: 'server.start',
        level: 'info',
        uid: 0,
        ip: '',
        description: 'Serveur DevEye démarré',
        metadata: { port: env.LISTEN_PORT }
    });
}

main().catch((e) => {
    logger.fatal({ err: e instanceof Error ? e.message : String(e) }, 'Fatal startup error');
    process.exit(1);
});

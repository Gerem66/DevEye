import { env } from '@/Utils/Env';
import { buildApp } from '@/app';
import { pruneCloudSync } from '@/cloudSync/prune';
import { logger } from '@/logger';
import { agentDistDir, startAgentReconcile } from '@/agent/sync';

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

    const { app, cloudSync, uptime, mailSync, integrations } = await buildApp({ db, crypt });
    const audit = createAuditLog(db);

    const shutdown = async (signal: string) => {
        logger.info({ signal }, 'Shutting down');
        try {
            uptime.stop();
            mailSync.stop();
            integrations.stop();
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
            // Uptime : élagage des pings bruts selon la rétention de chaque
            // service (l'agrégat journalier, lui, n'est jamais purgé).
            const uptimeChecks = await db.uptimeHistory.pruneByRetention(Math.floor(Date.now() / 1000));
            if (uptimeChecks > 0) logger.info({ uptimeChecks }, 'Pruned old uptime checks');
            // CloudSync : purge des versions par budget + sessions abandonnées.
            await pruneCloudSync(db, cloudSync, audit, logger);
        } catch (e) {
            logger.error({ err: (e as Error).message }, 'Retention sweep failed');
        }
    };
    void prune();
    const pruneTimer = setInterval(() => void prune(), 60 * 60 * 1000);
    pruneTimer.unref();

    // Reconcile the agent binaries with the rolling release (the only runtime
    // GitHub touch, and only at boot). Non-blocking: the readiness task is
    // registered synchronously so /api/status reports "not ready" right away.
    startAgentReconcile(agentDistDir());

    // Sonde de disponibilité : boucle indépendante, sans session ni mot de passe.
    uptime.start();
    // Synchro Mail en tâche de fond : même principe, comptes « open » uniquement.
    mailSync.start();
    integrations.start();

    await app.listen({ port: env.LISTEN_PORT, host: '0.0.0.0' });
    logger.info({ port: env.LISTEN_PORT }, 'DevEye server ready');

    audit.record({
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

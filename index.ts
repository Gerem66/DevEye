import { env } from '@/Utils/Env';
import { buildApp } from '@/app';
import { buildPublicApp } from '@/publicApp';
import { logger } from '@/logger';
import { agentDistDir, startAgentReconcile } from '@/agent/sync';

import Encryption from '@/Services/Encryption';
import { createAuditLog } from '@/Services/AuditLog';
import { createDatabase } from '@/db';
import { runMigrations } from '@/db/migrate';
import { createDbPool, getQueryable, testConnection } from '@/db/pool';
import { seedDevAccount } from '@/db/seedDev';
import { moduleMigrationDirs } from '@/features/_sdk/register';
// L'import du registre déclenche l'enregistrement des modules installés :
// leurs migrations et services deviennent visibles ci-dessous.
import '@/features/registry';

async function main() {
    const pool = createDbPool();
    const dbReady = await testConnection(pool);
    if (!dbReady) {
        logger.fatal('Database connection failed; aborting startup');
        process.exit(1);
    }

    await runMigrations(pool, moduleMigrationDirs());

    if (process.env.SEED_DEV === 'true') {
        await seedDevAccount(pool);
    }

    const db = createDatabase(getQueryable(pool));
    const crypt = new Encryption(env.CRYPT_KEY_A, env.CRYPT_KEY_B);

    const { app, moduleServices } = await buildApp({
        db,
        crypt
    });
    const audit = createAuditLog(db);

    /**
     * Le second écouteur, sur son propre port, quand il est réglé : les routes
     * publiques des modules, et rien d'autre.
     *
     * Même processus que le premier, et c'est une contrainte et non un choix :
     * l'ingestion d'audience prévient les écrans par `LiveHub`, dont l'état est
     * local au processus. Un conteneur séparé écrirait les mesures sans que
     * personne ne soit averti, et le rafraîchissement cesserait en silence.
     * Après `buildApp`, qui a créé les services que ces routes prolongent.
     */
    const publicApp = env.PUBLIC_LISTEN_PORT ? await buildPublicApp() : null;

    const shutdown = async (signal: string) => {
        logger.info({ signal }, 'Shutting down');
        try {
            // Attendus, et AVANT la fermeture du pool : un module rend son état
            // par une écriture en base (CloudSync libère son bail d'instance).
            // Lancés en `void`, ces arrêts étaient coupés par `pool.end()` puis
            // `process.exit`, et le processus suivant démarrait passif. Un
            // module qui échoue à s'arrêter ne retient pas les autres.
            const stops = await Promise.allSettled(moduleServices.map((svc) => svc.stop()));
            for (const stop of stops) {
                if (stop.status === 'rejected') {
                    logger.warn({ err: (stop.reason as Error).message }, 'Module service failed to stop');
                }
            }
            if (publicApp) await publicApp.close();
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

    // Reconcile the agent binaries with the rolling release (the only runtime
    // GitHub touch, and only at boot). Non-blocking: the readiness task is
    // registered synchronously so /api/status reports "not ready" right away.
    startAgentReconcile(agentDistDir());

    // (La sonde de disponibilité est un service du module Uptime, le relevé
    // des bases de données un service du module `features/database`, la
    // synchronisation des dépôts git un service du module `features/git`,
    // l'ingestion d'audience un service du module `features/audience` (la
    // seule qui ne sonde rien : elle vide ce que les routes publiques ont
    // déposé, et tient l'agrégat journalier + la rétention par site), les
    // sauvegardes un service du module `features/backup`, la relève des
    // boîtes mail ouvertes un service du module `features/mail` (sans session
    // ni mot de passe, comptes « open » uniquement), le balayage horaire de
    // rétention de l'historique des appareils un service du module
    // `features/devices` : tous démarrés avec les autres dans buildApp.)

    await app.listen({ port: env.LISTEN_PORT, host: '0.0.0.0' });
    logger.info({ port: env.LISTEN_PORT }, 'DevEye server ready');

    if (publicApp && env.PUBLIC_LISTEN_PORT) {
        await publicApp.listen({ port: env.PUBLIC_LISTEN_PORT, host: '0.0.0.0' });
        logger.warn(
            { port: env.PUBLIC_LISTEN_PORT, origin: env.AUDIENCE_ORIGIN || null },
            'Public surface listening: module public routes only, no session route registered'
        );
    }

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

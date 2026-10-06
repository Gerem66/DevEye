import { env } from '@/Utils/Env';
import { buildApp } from '@/app';
import { buildPublicApp } from '@/publicApp';
import { logger } from '@/logger';
import { agentDistDir, startAgentReconcile } from '@/agent/sync';

import Encryption from '@/Services/Encryption';
import { createAuditLog } from '@/Services/AuditLog';
import { describeError, systemAlerts } from '@/Services/systemAlerts';
import { appVersion } from '@/version';
import { createDatabase } from '@/db';
import { runMigrations } from '@/db/migrate';
import { assertSealFormat } from '@/Services/sealFormat';
import { createDbPool, getQueryable, testConnection } from '@/db/pool';
import { seedDevAccount } from '@/db/seedDev';
import {
    installedSealTargets,
    moduleExportDeclarations,
    moduleMigrationDirs,
    sdkQueryable,
    warnUnsetModuleEnv
} from '@/features/_sdk/register';
import { assertExportCoverage } from '@/Services/accountExport/coverage';
import { announceObjectStorage } from '@/Services/objectStorage';
// L'import du registre déclenche l'enregistrement des modules installés :
// leurs migrations et services deviennent visibles ci-dessous.
import '@/features/registry';

/**
 * Au-delà, l'arrêt propre a échoué et on sort quand même : garder le port pris
 * est pire que perdre la dernière écriture. Une base derrière un tunnel coupé
 * ne répond jamais, et le service d'un module non plus. Sous le SIGKILL de
 * `tsx watch` (5 s) et sous la grâce de `docker stop` (10 s), pour qu'on lise
 * cette ligne de journal plutôt qu'un signal muet.
 */
const SHUTDOWN_TIMEOUT_MS = 3000;

/** Le temps laissé à l'alerte d'un plantage ou d'un arrêt forcé avant la sortie. */
const EXIT_ALERT_MS = 2000;

/**
 * Une exception ou un rejet que rien n'attrape : Node sortirait en écrivant une
 * pile brute sur stderr, hors du journal JSON. On la journalise et on prévient,
 * puis on sort comme Node l'aurait fait ; Docker relance le conteneur.
 */
let crashing = false;
function crash(kind: string, e: unknown): void {
    if (crashing) process.exit(1);
    crashing = true;
    logger.fatal({ err: e }, kind);
    systemAlerts.report({ key: 'crash', level: 'critical', title: 'Plantage du serveur', detail: describeError(e) });
    void systemAlerts.flush(EXIT_ALERT_MS).finally(() => process.exit(1));
}
process.on('uncaughtException', (e) => crash('Uncaught exception', e));
process.on('unhandledRejection', (e) => crash('Unhandled rejection', e));

async function main() {
    warnUnsetModuleEnv();
    void announceObjectStorage(logger);

    const pool = createDbPool();
    const dbReady = await testConnection(pool);
    if (!dbReady) {
        logger.fatal('Database connection failed; aborting startup');
        process.exit(1);
    }

    await runMigrations(moduleMigrationDirs());

    try {
        await assertSealFormat(pool, installedSealTargets());
        const uncovered = await assertExportCoverage(sdkQueryable(getQueryable(pool)), moduleExportDeclarations());
        if (uncovered.length > 0) {
            logger.warn({ tables: uncovered }, 'Export des données : tables sans sort, absentes des archives');
        }
    } catch (e) {
        logger.fatal((e as Error).message);
        process.exit(1);
    }

    if (process.env.SEED_DEV === 'true') {
        await seedDevAccount(pool);
    }

    const db = createDatabase(pool);
    const crypt = new Encryption(env.CRYPT_KEY_A, env.CRYPT_KEY_B);
    systemAlerts.init({ db, crypt, logger, live: env.ENVIRONMENT === 'prod' });

    const { app, stopServices } = await buildApp({
        db,
        crypt
    });
    const audit = createAuditLog(db);

    // Le second écouteur (routes publiques des modules seulement), dans le même
    // processus : `LiveHub`, qui prévient les écrans, est local au processus.
    // Après `buildApp`, qui crée les services que ces routes prolongent.
    const publicApp = env.PUBLIC_LISTEN_PORT ? await buildPublicApp() : null;

    let stopping = false;
    const shutdown = async (signal: string) => {
        // Le même Ctrl-C arrive deux fois (délivrance au groupe de premier
        // plan, puis relais de `tsx watch`) : le doublon ne rejoue rien.
        if (stopping) return;
        stopping = true;
        logger.info({ signal }, 'Shutting down');
        // L'étape en cours : une attente qui ne revient pas ne lève rien, le
        // journal ne dirait sinon que « ça n'a pas fini », pas quoi.
        let step = 'module services';
        const deadline = setTimeout(() => {
            logger.error({ signal, step }, 'Graceful shutdown timed out; exiting');
            systemAlerts.report({
                key: 'shutdown',
                level: 'error',
                title: 'Arrêt forcé du serveur',
                detail: `L’arrêt propre n’a pas abouti en ${SHUTDOWN_TIMEOUT_MS / 1000} s (étape : ${step}).`
            });
            void systemAlerts.flush(EXIT_ALERT_MS).finally(() => process.exit(1));
        }, SHUTDOWN_TIMEOUT_MS);
        // Le chien de garde ne doit pas retenir à lui seul la boucle
        // d'événements : sans lui, l'arrêt est déjà fini.
        deadline.unref();
        try {
            // Attendus, et avant la fermeture du pool : un module peut rendre son
            // état par une écriture en base (CloudSync libère son bail d'instance).
            // Un module qui échoue à s'arrêter ne retient pas les autres.
            const stops = await stopServices();
            for (const stop of stops) {
                if (stop.status === 'rejected') {
                    logger.warn({ err: (stop.reason as Error).message }, 'Module service failed to stop');
                }
            }
            step = 'public surface';
            if (publicApp) await publicApp.close();
            step = 'http server';
            await app.close();
            step = 'database pool';
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
    // Un démarrage que personne n'a demandé est la trace d'un plantage.
    systemAlerts.report({ key: 'boot', level: 'info', title: 'Serveur démarré', detail: `Version ${appVersion()}` });
    void systemAlerts.warnIfUnrouted();
}

main().catch((e) => {
    logger.fatal({ err: e }, 'Fatal startup error');
    process.exit(1);
});

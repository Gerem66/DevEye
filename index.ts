import { env } from '@/Utils/Env';
import { buildApp } from '@/app';
import { logger } from '@/logger';

import Encryption from '@/Services/Encryption';
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

    await app.listen({ port: env.HTTP_PORT, host: '0.0.0.0' });
    logger.info({ port: env.HTTP_PORT }, 'DevEye server ready');
}

main().catch((e) => {
    logger.fatal({ err: e instanceof Error ? e.message : String(e) }, 'Fatal startup error');
    process.exit(1);
});

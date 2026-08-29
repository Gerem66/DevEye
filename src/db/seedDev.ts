import { hashPassword } from '@/auth/argon';
import { logger } from '@/logger';

import { createDatabase, type Database } from './index';
import { getQueryable, type DbPool } from './pool';

const DEV_USERNAME = process.env.SEED_DEV_USERNAME ?? 'dev';
const DEV_EMAIL = process.env.SEED_DEV_EMAIL ?? 'dev@deveye.local';
const DEV_PASSWORD = process.env.SEED_DEV_PASSWORD ?? 'devdevdev';
// Only modular, per-workspace features belong here; structural pages (profile,
// security) are never stored in the features list.
const DEV_FEATURES = ['devices', 'weather', 'password'];

/**
 * Idempotently create a development account on an otherwise empty database.
 * Runs only when SEED_DEV=true (set by docker-compose.dev.yml), so it never
 * touches a real database.
 *
 * Passe par les repos plutôt que par du SQL brut, pour ne pas diverger de
 * l'inscription (compte + espace personnel).
 */
export async function seedDevAccount(pool: DbPool): Promise<void> {
    const db: Database = createDatabase(getQueryable(pool));

    if (await db.users.findByUsername(DEV_USERNAME)) {
        logger.info({ username: DEV_USERNAME }, 'Dev seed: account already present');
        return;
    }

    const passwordHash = await hashPassword(DEV_PASSWORD);
    const user = await db.users.create({
        email: DEV_EMAIL,
        username: DEV_USERNAME,
        passwordHash,
        role: 'admin'
    });

    const personal = await db.workspaces.createPersonal(user.id, DEV_USERNAME);
    await db.users.setPersonalWorkspace(user.id, personal.id);
    await db.workspaces.updateFeatures(personal.id, DEV_FEATURES);

    logger.warn(
        { username: DEV_USERNAME, email: DEV_EMAIL },
        'Dev seed: created development account (password from SEED_DEV_PASSWORD or default)'
    );
}

import { hashPassword } from '@/auth/argon';
import { logger } from '@/logger';

import { getQueryable, type DbPool } from './pool';

const DEV_USERNAME = process.env.SEED_DEV_USERNAME ?? 'dev';
const DEV_EMAIL = process.env.SEED_DEV_EMAIL ?? 'dev@deveye.local';
const DEV_PASSWORD = process.env.SEED_DEV_PASSWORD ?? 'devdevdev';
const DEV_FEATURES = ['profile', 'password', 'servicemonitor', 'projects'];

/**
 * Idempotently create a development account on an otherwise empty database.
 * Runs only when SEED_DEV=true (set by docker-compose.dev.yml), so it never
 * touches a real database. `settings` is NOT NULL without a default, so it is
 * inserted explicitly alongside `features`.
 */
export async function seedDevAccount(pool: DbPool): Promise<void> {
    const q = getQueryable(pool);

    const existing = await q.query<{ id: number }>('SELECT id FROM users WHERE username = ? LIMIT 1', [DEV_USERNAME]);
    if (existing.rows.length > 0) {
        logger.info({ username: DEV_USERNAME }, 'Dev seed: account already present');
        return;
    }

    const passwordHash = await hashPassword(DEV_PASSWORD);
    await q.query(
        `INSERT INTO users (email, username, password_hash, settings, features, default_workspace, default_feature)
         VALUES (?, ?, ?, CAST(? AS JSON), CAST(? AS JSON), 0, 'profile')`,
        [DEV_EMAIL, DEV_USERNAME, passwordHash, JSON.stringify([]), JSON.stringify(DEV_FEATURES)]
    );

    logger.warn(
        { username: DEV_USERNAME, email: DEV_EMAIL },
        'Dev seed: created development account (password from SEED_DEV_PASSWORD or default)'
    );
}

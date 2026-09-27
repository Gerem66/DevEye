import type { LiveTopic } from '@deveye/types';
import type { FeatureManifest } from '@deveye/types/sdk';
import type { SdkAccount } from '@deveye/types/sdk/server';

import type { Database } from '@/db';
import type { AccountRow } from '@/db/repos/users';
import { schedulePlanReconcile } from '@/Services/planPauses';
import { sdkLive } from './host';

/**
 * Un compte est prévenu où que ses connexions soient assises : son offre et les
 * ressources du module se relisent. La trame nomme son espace personnel, seul
 * espace qu'un compte a toujours. Son offre a pu changer : ses limites de stock
 * se réappliquent.
 */
export function accountChanged(db: Pick<Database, 'users'>, manifest: FeatureManifest, userId: number): void {
    schedulePlanReconcile(userId);
    void db.users
        .findById(userId)
        .then((row) => {
            if (row)
                sdkLive().userChanged(userId, row.personal_workspace_id, ['account', manifest.id] as LiveTopic[], null);
        })
        .catch(() => undefined);
}

/** `users.created` est en secondes. */
export function toSdkAccount(row: AccountRow): SdkAccount {
    return {
        id: row.id,
        email: row.email,
        username: row.username,
        isAdmin: row.role === 'admin',
        e2e: row.e2e_run !== null,
        suspended: row.status === 'suspended',
        created: Number(row.created) * 1000
    };
}

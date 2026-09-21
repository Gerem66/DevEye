import type { SdkQuota } from '@deveye/types/sdk/server';

import type { AudienceEventsQuota } from '../contracts/domain';
import { dayBounds, dayKey } from './normalize';
import type { AudienceRepo } from './repo';

/**
 * Les vues et événements du mois en cours, face à ce que permet l'offre du
 * propriétaire de l'espace. `null` : rien ne les borne. L'ingestion et l'écran
 * lisent le même compte, pour que ce que l'un refuse soit ce que l'autre dit.
 */
export async function eventsUsage(
    quota: SdkQuota,
    repo: Pick<AudienceRepo, 'eventsSince'>,
    nowSeconds: number
): Promise<AudienceEventsQuota | null> {
    const limit = await quota.limit('events');
    if (limit === null) return null;
    const month = new Date(nowSeconds * 1000);
    const fromDay = month.getUTCFullYear() * 10000 + (month.getUTCMonth() + 1) * 100 + 1;
    let used = 0;
    // `assert` est la seule voie vers les espaces du propriétaire : on y lit le
    // compte, et le `0` rendu ne lui fait rien refuser.
    await quota.assert('events', async (owned) => {
        used = await repo.eventsSince(owned, fromDay, dayKey(nowSeconds), dayBounds(nowSeconds).from);
        return 0;
    });
    return { limit, used };
}

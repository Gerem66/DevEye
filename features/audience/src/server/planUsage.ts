import type { SdkQuota } from '@deveye/types/sdk/server';

import type { AudienceEventsQuota } from '../contracts/domain';
import { monthKey } from './normalize';
import type { AudienceRepo } from './repo';

/**
 * Les vues et événements du mois en cours, face à ce que permet l'offre du
 * propriétaire de l'espace. `null` : rien ne les borne. L'ingestion et l'écran
 * lisent le même compte, pour que ce que l'un refuse soit ce que l'autre dit.
 */
export async function eventsUsage(
    quota: SdkQuota,
    repo: Pick<AudienceRepo, 'monthlyEvents'>,
    nowSeconds: number
): Promise<AudienceEventsQuota | null> {
    const limit = await quota.limit('events');
    if (limit === null) return null;
    let used = 0;
    // `assert` est la seule voie vers les espaces du propriétaire : on y lit le
    // compte, et le `0` rendu ne lui fait rien refuser.
    await quota.assert('events', async (owned) => {
        used = await repo.monthlyEvents(owned, monthKey(nowSeconds));
        return 0;
    });
    return { limit, used };
}

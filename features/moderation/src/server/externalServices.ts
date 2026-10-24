import type { SdkExternalService, SdkExternalServicesContext } from '@deveye/types/sdk/server';

import { env } from './env';
import type { ModerationRepo } from './repo';
import { moderation } from './service';

/** La liste externe d'empreintes, telle que la page Services externes la montre. */
export async function moderationExternalServices({
    refresh
}: SdkExternalServicesContext<ModerationRepo>): Promise<readonly SdkExternalService[]> {
    const base = { id: 'feed', name: 'Liste d’empreintes externe' };
    if (env.MODERATION_FEED_URL.length === 0) {
        return [
            {
                ...base,
                state: 'inactive',
                summary:
                    'Sans MODERATION_FEED_URL : les empreintes interdites viennent de la saisie, des retraits et des imports.'
            }
        ];
    }
    const service = moderation();
    if (service === null) return [{ ...base, state: 'down', summary: 'Le service de modération ne tourne pas.' }];
    if (refresh) await service.importFeed();
    const status = await service.feedStatus();
    const host = (() => {
        try {
            return new URL(env.MODERATION_FEED_URL).host;
        } catch {
            return env.MODERATION_FEED_URL;
        }
    })();
    const facts = [
        { label: 'Source', value: host },
        { label: 'Empreintes importées', value: status.count.toLocaleString('fr-FR') },
        {
            label: 'Dernière relecture',
            value: status.lastImport === null ? 'jamais' : new Date(status.lastImport * 1000).toLocaleString('fr-FR')
        }
    ];
    if (status.lastError !== null) {
        return [
            {
                ...base,
                state: status.lastImport === null ? 'down' : 'degraded',
                summary: `La dernière relecture a échoué : ${status.lastError}`,
                facts
            }
        ];
    }
    return [
        {
            ...base,
            state: status.lastImport === null ? 'degraded' : 'ok',
            summary:
                status.lastImport === null
                    ? 'La liste n’a pas encore été relue : la première lecture part dans la minute.'
                    : 'La liste se relit toutes les heures.',
            facts
        }
    ];
}

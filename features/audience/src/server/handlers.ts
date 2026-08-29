import {
    audienceCountFeature,
    audienceGetFeature,
    audienceListFeature,
    audienceReorderFeature,
    audienceSiteAddFeature,
    audienceSiteRemoveFeature,
    audienceSiteRotateKeyFeature,
    audienceSiteUpdateFeature
} from './crud';
import {
    audienceFunnelAddFeature,
    audienceFunnelListFeature,
    audienceFunnelRemoveFeature,
    audienceFunnelUpdateFeature
} from './funnels';
import {
    audienceActivityFeature,
    audienceBreakdownFeature,
    audienceLiveFeature,
    audienceOverviewFeature
} from './stats';

/**
 * L'audience de l'espace : `crud.ts` déclare des sites, `stats.ts` lit des
 * nombres, `funnels.ts` compose des parcours. L'ingestion n'est pas ici : elle
 * entre par HTTP sans session (`routes.ts`), depuis des machines qui ne
 * connaissent pas DevEye.
 */
export const audienceHandlers = [
    audienceCountFeature,
    audienceListFeature,
    audienceGetFeature,
    audienceSiteAddFeature,
    audienceSiteUpdateFeature,
    audienceSiteRotateKeyFeature,
    audienceSiteRemoveFeature,
    audienceReorderFeature,
    audienceOverviewFeature,
    audienceBreakdownFeature,
    audienceActivityFeature,
    audienceLiveFeature,
    audienceFunnelListFeature,
    audienceFunnelAddFeature,
    audienceFunnelUpdateFeature,
    audienceFunnelRemoveFeature
];

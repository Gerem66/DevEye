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
    audienceFormAddFeature,
    audienceFormClearFeature,
    audienceFormListFeature,
    audienceFormRemoveFeature,
    audienceFormUpdateFeature,
    audienceResultsFeature,
    audienceSubmissionListFeature,
    audienceSubmissionRemoveFeature
} from './forms';
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
    audienceOverviewFeature,
    audienceSummaryFeature
} from './stats';

/**
 * L'audience de l'espace : `crud.ts` déclare des sites, `stats.ts` lit des
 * nombres, `funnels.ts` compose des parcours, `forms.ts` règle les canaux de
 * retours et relit ce qu'ils ont reçu. Ni la mesure ni les retours n'entrent
 * ici : ils passent par HTTP sans session (`routes.ts`), depuis des machines
 * qui ne connaissent pas DevEye.
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
    audienceFunnelRemoveFeature,
    audienceSummaryFeature,
    audienceFormAddFeature,
    audienceFormListFeature,
    audienceFormUpdateFeature,
    audienceFormClearFeature,
    audienceFormRemoveFeature,
    audienceSubmissionListFeature,
    audienceSubmissionRemoveFeature,
    audienceResultsFeature
];

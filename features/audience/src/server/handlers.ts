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
 * L'audience de l'espace : les sites suivis et ce qu'ils ont mesuré.
 *
 * Trois fichiers, trois natures : `crud.ts` déclare des sites, `stats.ts` lit
 * des nombres, `funnels.ts` compose des parcours à partir de ce qui a déjà été
 * observé. L'**ingestion**, elle, n'est pas ici du tout — elle entre par HTTP
 * sans session (`routes.ts`, les routes publiques du module), parce qu'elle
 * vient de machines qui ne connaissent pas DevEye.
 *
 * ⚠️ Préfixe unique `audience.` et verbes en camelCase : le filet
 * `MUTATION_VERB` de `_topics.ts` ne verra **aucune** de ces commandes. Les
 * `mutates` se relisent donc à la main. Huit écritures le déclarent — `siteAdd`,
 * `siteUpdate`, `siteRotateKey`, `siteRemove`, `reorder`, `funnelAdd`,
 * `funnelUpdate`, `funnelRemove` — et les cinq lectures (les quatre
 * statistiques plus `funnelList`) n'en déclarent aucune, ce qui est juste.
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

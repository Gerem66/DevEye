import { featureDescriptor } from '@deveye/types';

import { uptimeCommands } from './contracts/commands';
import type { FeatureManifest } from '@deveye/types/sdk';

/**
 * Le descriptif (intitulé, icône, `notifies`, `hasItems`, `shareTier`) vient du
 * registre publié ; le manifest n'ajoute que ce que le registre ne porte pas.
 *
 * `shareTier: 'open'` engage : l'entrée `items` du serveur, `ctx.sharing.scope()`
 * dans les listages et `ctx.items.restrictions()` sur ce qu'ils rendent. Le boot
 * refuse un module qui déclare sans tenir.
 */
const descriptor = featureDescriptor('uptime');

export const manifest = {
    ...descriptor,
    category: 'supervision',
    /**
     * Ravivées par le sujet `uptime` : après une écriture, et à chaque transition
     * d'état signalée par le service de fond (jamais à chaque sonde).
     */
    resources: ['uptime.count', 'uptime.list'],
    /** La seule native appelée : les canaux d'alerte de l'espace, par service. */
    nativeCapabilities: ['notify'],
    topbarWidget: { description: 'Services en ligne sur les services surveillés' },
    links: [{ to: 'mail', what: 'envoie ses alertes par un compte Mail' }],
    /**
     * Un panneau Général à l'échelle d'un service : son identité, ses réglages
     * fins (cadence, délai, seuil, rétention) et sa suppression. Notifications,
     * Partage et Permissions s'ajoutent tout seuls : `notifies` et le
     * branchement au partage suffisent.
     */
    settings: { item: ['general'] },
    commands: uptimeCommands
} satisfies FeatureManifest;

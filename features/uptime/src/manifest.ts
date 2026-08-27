import { featureDescriptor } from '@deveye/types';

import { uptimeCommands } from './contracts/commands';
import type { FeatureManifest } from '@deveye/types/sdk';

/**
 * Uptime, au format manifest : la sixième native rapatriée sur le SDK, et la
 * première à éléments partagés (projections inter-espaces, restrictions par
 * élément, routes de notification par service), avec un service de fond.
 *
 * Le descriptif (intitulé, icône, phrase des rôles, `notifies`, `hasItems`,
 * `itemNoun`, `shareTier: 'open'`) reste celui du registre publié, étalé
 * plutôt que recopié : une native garde son identité dans @deveye/types, le
 * manifest n'ajoute que ce que le registre ne porte pas (catégorie,
 * ressources, capacités, widget de topbar, onglets de réglages, commandes).
 *
 * `shareTier: 'open'` est un engagement, tenu : l'entrée `items` du serveur
 * (domicile et intitulé d'un service), `ctx.sharing.scope()` dans les
 * listages (le codec choisi ligne par ligne) et `ctx.items.restrictions()`
 * sur ce qu'ils rendent. Le boot refuse un module qui déclare sans tenir.
 */
const descriptor = featureDescriptor('uptime');

export const manifest = {
    ...descriptor,
    category: 'supervision',
    /**
     * Deux clés de cache : le compte de la carte d'accueil et du widget de
     * topbar (`uptime.count`, un magasin partagé les nourrit d'une seule
     * requête) et la liste de l'écran (`uptime.list`). Le sujet `uptime` les
     * ravive toutes les deux : après une écriture d'un membre, et à chaque
     * transition d'état signalée par le service de fond (jamais à chaque
     * sonde).
     */
    resources: ['uptime.count', 'uptime.list'],
    /** La seule native appelée : les canaux d'alerte de l'espace, par service. */
    nativeCapabilities: ['notify'],
    /** Le mini-widget de topbar : services en ligne sur services surveillés. */
    topbarWidget: { description: 'Services en ligne sur les services surveillés' },
    /** Ce que la fiche « À propos » relie : les alertes partent par un compte Mail. */
    links: [{ to: 'mail', what: 'envoie ses alertes par un compte Mail' }],
    /**
     * Un panneau Général à l'échelle d'un SERVICE : cadence de relève, délai,
     * seuil de défaillance et rétention, qui vivaient dans le dialogue
     * d'édition (dette de la coquille, réglée au rapatriement). Notifications
     * s'ajoute tout seul, à l'échelle de la feature et d'un service, parce que
     * le descripteur dit `notifies` ; Partage et Permissions s'ajoutent tout
     * seuls parce que le module est branché au partage.
     */
    settings: { item: ['general'] },
    commands: uptimeCommands
} satisfies FeatureManifest;

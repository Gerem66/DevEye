import { featureDescriptor } from '@deveye/types';

import { deployCommands } from './contracts/commands';
import type { FeatureManifest } from '@deveye/types/sdk';

/**
 * Déploiements, au format manifest : la dixième native rapatriée sur le SDK,
 * à éléments partagés (projections inter-espaces, restrictions par cible,
 * routes de notification par cible), avec un service de fond (le
 * rapprochement des cibles chez Dokploy, et le message Discord qui suit un
 * déploiement du début à la fin), et dont l'onglet d'un projet compose les
 * composants par un provider client.
 *
 * Le descriptif (intitulé, icône, phrase des rôles, `notifies`, `hasItems`,
 * `itemNoun`, `sources`, `shareTier: 'open'`) reste celui du registre publié,
 * étalé plutôt que recopié : une native garde son identité dans
 * @deveye/types, le manifest n'ajoute que ce que le registre ne porte pas
 * (catégorie, ressources, capacités, onglets de réglages, liens, commandes).
 *
 * `shareTier: 'open'` est un engagement, tenu : l'entrée `items` du serveur
 * (domicile et intitulé d'une cible), `ctx.sharing.scope()` dans les
 * listages (le codec choisi ligne par ligne) et `ctx.items.restrictions()`
 * sur ce qu'ils rendent. Le boot refuse un module qui déclare sans tenir.
 */
const descriptor = featureDescriptor('deploy');

export const manifest = {
    ...descriptor,
    category: 'dev',
    /**
     * Trois clés de cache, telles que les écrans les invalident : le compte de
     * la carte d'accueil (`deploy.count`), la liste (`deploy.list`) et la
     * fiche d'une cible (`deploy.detail`, que l'onglet d'un projet suit
     * aussi). Le sujet `deploy` les ravive toutes : après une écriture d'un
     * membre, et à chaque changement d'état constaté par le rapprochement de
     * fond (jamais à chaque tour sans changement).
     */
    resources: ['deploy.count', 'deploy.list', 'deploy.detail'],
    /**
     * La seule native appelée : les canaux d'avis de l'espace, par cible, y
     * compris le message vivant d'un déploiement (`notify.liveChannels` et
     * `notify.postLive`, la façade élargie pour ce module).
     */
    nativeCapabilities: ['notify'],
    /** Ce que la fiche « À propos » relie : les avis partent par un compte Mail. */
    links: [{ to: 'mail', what: 'envoie ses alertes par un compte Mail' }],
    /**
     * Les accès Dokploy (les sources de la feature) se gèrent à l'échelle de
     * la fonctionnalité, dans l'onglet Sources ; le dialogue d'une cible n'en
     * fait que choisir un, et son « + » ouvre cet onglet. Notifications,
     * Partage et Permissions viennent du descripteur.
     */
    settings: { feature: ['sources'] },
    commands: deployCommands
} satisfies FeatureManifest;

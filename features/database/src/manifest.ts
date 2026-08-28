import { featureDescriptor } from '@deveye/types';

import { databaseCommands } from './contracts/commands';
import type { FeatureManifest } from '@deveye/types/sdk';

/**
 * Bases de données, au format manifest : la neuvième native rapatriée sur le
 * SDK, à éléments partagés (projections inter-espaces, restrictions par
 * base, routes de notification par base), avec un service de fond (le relevé
 * périodique et l'évaluation des alertes), et la première dont un autre
 * écran de l'app (l'onglet d'un projet) compose les composants par un
 * provider client.
 *
 * Le descriptif (intitulé, icône, phrase des rôles, `notifies`, `hasItems`,
 * `itemNoun`, `shareTier: 'open'`) reste celui du registre publié, étalé
 * plutôt que recopié : une native garde son identité dans @deveye/types, le
 * manifest n'ajoute que ce que le registre ne porte pas (catégorie,
 * ressources, capacités, onglets de réglages, liens, commandes).
 *
 * `shareTier: 'open'` est un engagement, tenu : l'entrée `items` du serveur
 * (domicile et intitulé d'une base), `ctx.sharing.scope()` dans les listages
 * (le codec choisi ligne par ligne) et `ctx.items.restrictions()` sur ce
 * qu'ils rendent. Le boot refuse un module qui déclare sans tenir.
 */
const descriptor = featureDescriptor('database');

export const manifest = {
    ...descriptor,
    category: 'dev',
    /**
     * Trois clés de cache, telles que les écrans les invalident : le compte de
     * la carte d'accueil (`database.count`), la liste (`database.list`) et la
     * fiche d'une base (`database.detail`, que l'onglet d'un projet suit
     * aussi). Le sujet `database` les ravive toutes : après une écriture d'un
     * membre, et à chaque relevé du service de fond (jamais à chaque tour de
     * boucle sans relevé).
     */
    resources: ['database.count', 'database.list', 'database.detail'],
    /** La seule native appelée : les canaux d'alerte de l'espace, par base. */
    nativeCapabilities: ['notify'],
    /**
     * Ce que la fiche « À propos » relie : les alertes partent par un compte
     * Mail, et les Sauvegardes vident une base par le contrat que ce module
     * offre.
     */
    links: [
        { to: 'mail', what: 'envoie ses alertes par un compte Mail' },
        { to: 'backup', what: 'offre ses bases aux sauvegardes' }
    ],
    /**
     * Deux panneaux à l'échelle d'une BASE, la dette de la coquille réglée au
     * rapatriement : Général (le relevé périodique et sa cadence, le
     * chargement des tables à l'ouverture) qui vivait dans l'onglet
     * « Options » du dialogue d'édition, et l'onglet personnalisé Alertes
     * (les conditions SQL, leur opérateur, leur message) qui vivait dans le
     * corps de la fiche derrière son propre dialogue. La fiche garde l'ÉTAT
     * des alertes (franchie, dernières mesures), pas leur écriture.
     * Notifications s'ajoute tout seul, à l'échelle de la feature et d'une
     * base, parce que le descripteur dit `notifies` ; Partage et Permissions
     * s'ajoutent tout seuls parce que le module est branché au partage.
     */
    settings: { item: ['general', { id: 'alerts', label: 'Alertes', icon: 'activity' }] },
    commands: databaseCommands
} satisfies FeatureManifest;

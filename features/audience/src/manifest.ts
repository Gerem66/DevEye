import { featureDescriptor } from '@deveye/types';

import { audienceCommands } from './contracts/commands';
import type { FeatureManifest } from '@deveye/types/sdk';

/**
 * Audience au format manifest : éléments partagés (projections inter-espaces,
 * restrictions par site), un service de fond (l'ingestion des visites) et des
 * routes HTTP publiques, ce que la capacité `routes.public` déclare.
 *
 * Le descriptif (intitulé, icône, phrase des rôles, `hasItems`, `itemNoun`,
 * `shareTier`) vient du registre publié ; le manifest n'ajoute que ce que le
 * registre ne porte pas.
 *
 * `shareTier: 'open'` est un engagement : l'entrée `items` du serveur,
 * `ctx.sharing.scope()` dans les listages et `ctx.items.restrictions()` sur ce
 * qu'ils rendent. Le boot refuse un module qui déclare sans tenir.
 */
const descriptor = featureDescriptor('audience');

export const manifest = {
    ...descriptor,
    category: 'analysis',
    /**
     * Cinq clés de cache, telles que les écrans les invalident : le compte de
     * la carte d'accueil, la liste, la fiche d'un site (que l'onglet d'un projet
     * suit aussi), les statistiques, ravivées à part par le battement de
     * l'ingestion, et les retours, que le tableau et les résultats suivent. Le
     * sujet `audience` les ravive toutes.
     */
    resources: ['audience.count', 'audience.list', 'audience.detail', 'audience.stats', 'audience.forms'],
    /**
     * L'ingestion est appelée par des navigateurs qui ne savent rien de DevEye,
     * depuis des sites qui ne lui appartiennent pas : le module déclare ces
     * routes, l'hôte les monte sur chacun de ses écouteurs exposés.
     */
    nativeCapabilities: ['routes.public'],
    quotas: [
        { key: 'sites', label: 'sites suivis' },
        { key: 'events', label: 'vues et événements par mois' }
    ],
    /**
     * Les retours sont la seule donnée nominative du module : ce que les
     * visiteurs d'un site écrivent, noms et adresses compris. Les statistiques
     * n'en portent aucune, et beaucoup de rôles n'ont à voir qu'elles.
     *
     * Ce sont des ressources de la fonctionnalité et non des verbes, ce que
     * `Docs/PERMISSIONS.md` §2 distingue : « lire les retours » ouvre une
     * section, il n'autorise pas un geste de plus sur ce qu'on voyait déjà.
     *
     * Une restriction par élément porte l'espace depuis lequel elle s'applique :
     * un site partagé à trois équipes n'ouvre donc ses retours qu'à celles à qui
     * on les accorde, chacune réglant ses propres rôles.
     */
    extraPermissions: [
        {
            key: 'submissions',
            label: 'Retours des formulaires',
            description:
                'Lire les messages reçus par les formulaires des sites de cet espace, et les supprimer : ' +
                'noms, adresses et textes libres que les visiteurs ont écrits. Sans ce droit, le rôle voit ' +
                'toutes les statistiques, et la section Retours reste fermée.',
            type: 'toggle'
        },
        {
            key: 'submissionsExport',
            label: 'Exporter les retours',
            description:
                'Télécharger les retours en tableur. Demande le droit ci-dessus. C’est un garde-fou ' +
                'd’interface et non une frontière : qui lit les retours à l’écran peut toujours les recopier.',
            type: 'toggle'
        }
    ],
    /**
     * Trois panneaux à l'échelle d'un site, un par section de sa fiche : ce qui
     * vaut pour le site entier (identité, origines, état, suppression), ce qui
     * ne règle que la mesure, et ce qui ne règle que les retours.
     *
     * Pas d'onglet pour les entonnoirs : ils n'ont rien à régler, ils se
     * composent depuis leur vue à partir des signaux déjà observés, et un
     * quatrième onglet vide ferait chercher un réglage qui n'existe pas.
     *
     * Un seul bouton les ouvre, celui de la coquille commune, à toutes les
     * profondeurs. Partage et Permissions viennent du descripteur.
     */
    settings: {
        item: [
            'general',
            { id: 'traffic', label: 'Fréquentation', icon: 'activity' },
            { id: 'forms', label: 'Retours', icon: 'chat' }
        ]
    },
    commands: audienceCommands
} satisfies FeatureManifest;

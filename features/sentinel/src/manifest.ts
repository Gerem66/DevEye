import { featureDescriptor } from '@deveye/types';

import { sentinelCommands } from './contracts/commands';
import type { FeatureManifest } from '@deveye/types/sdk';

/**
 * Sentinelle, au format manifest : la septième native rapatriée sur le SDK,
 * et la plus entremêlée à l'infrastructure : elle reçoit la télémétrie des
 * agents par les hooks du service (`agentHooks`), relit les instants par la
 * façade `telemetry`, commande un relevé et pousse la config d'un agent par
 * la façade `agents`, et contribue à cette config par un provider publié.
 *
 * Le descriptif (intitulé, icône, phrase des rôles, `notifies`, `hasItems:
 * false`, `shareTier: 'never'`) reste celui du registre publié, étalé plutôt
 * que recopié : une native garde son identité dans @deveye/types, le manifest
 * n'ajoute que ce que le registre ne porte pas (catégorie, ressources,
 * capacités, liaison, onglet de réglages, commandes).
 */
const descriptor = featureDescriptor('sentinel');

export const manifest = {
    ...descriptor,
    category: 'security',
    /**
     * Quatre clés de cache, ravivées ensemble par le sujet `sentinel` : le
     * décompte de la carte d'accueil (`sentinel.count`, en tête : c'est la clé
     * qui doit bouger le plus vite), la vue de flotte, les constats et la
     * ligne de base. Le sujet bat après une écriture d'un membre et à chaque
     * constat ouvert par le moteur (jamais à chaque tour).
     */
    resources: ['sentinel.count', 'sentinel.overview', 'sentinel.findings', 'sentinel.baseline'],
    /**
     * Les quatre natives appelées : les appareils de l'espace (autoriser,
     * lister, la flotte pour le moteur), la télémétrie (l'instant qu'une règle
     * juge, l'épinglage de la preuve), la flotte d'agents (relevé immédiat,
     * config poussée, hooks entrants) et les canaux d'alerte de l'espace.
     */
    nativeCapabilities: ['devices.read', 'telemetry.read', 'agents', 'notify'],
    /** Ce que la fiche « À propos » relie : les alertes partent par un compte Mail. */
    links: [{ to: 'mail', what: 'envoie ses alertes par un compte Mail' }],
    /**
     * Un onglet Appareils à l'échelle de la FEATURE : surveillé ou non,
     * fenêtre d'apprentissage, cadence du manifeste, journal
     * d'authentification, appareil par appareil. Sentinelle n'a pas
     * d'éléments (ses « éléments » sont des appareils, la feature Appareils
     * les possède) : l'échelle élément de la coquille ne s'applique pas, et
     * le dialogue par appareil derrière un second engrenage (la dette de la
     * coquille) devient ce panneau. Notifications s'ajoute tout seul parce
     * que le descripteur dit `notifies`.
     */
    settings: { feature: [{ id: 'devices', label: 'Appareils', icon: 'server' }] },
    commands: sentinelCommands
} satisfies FeatureManifest;

import { featureDescriptor } from '@deveye/types';

import { databaseCommands } from './contracts/commands';
import type { FeatureManifest } from '@deveye/types/sdk';

/**
 * Le descripteur du registre porte l'identité de la feature ; le manifest
 * n'ajoute que ce qu'il ne porte pas. Son `shareTier: 'open'` engage l'entrée
 * `items` du serveur, `ctx.sharing.scope()` et `ctx.items.restrictions()`.
 */
const descriptor = featureDescriptor('database');

export const manifest = {
    ...descriptor,
    category: 'dev',
    /**
     * Le sujet `database` les ravive toutes : après une écriture, et à chaque
     * relevé du service de fond (jamais à un tour sans relevé).
     */
    resources: ['database.count', 'database.list', 'database.detail'],
    /** Les canaux d'alerte de l'espace, par base. */
    nativeCapabilities: ['notify'],
    links: [
        { to: 'mail', what: 'envoie ses alertes par un compte Mail' },
        { to: 'backup', what: 'offre ses bases aux sauvegardes' }
    ],
    /**
     * Panneaux d'une base : Général (la base elle-même : connexion, accès,
     * relevé, cadence, chargement des tables, suppression) et Alertes (les
     * règles ; la fiche n'en montre que l'état). Notifications, Partage et
     * Permissions viennent du descripteur.
     */
    settings: { item: ['general', { id: 'alerts', label: 'Alertes', icon: 'activity' }] },
    commands: databaseCommands
} satisfies FeatureManifest;

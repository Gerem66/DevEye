import type { FeatureManifest } from '@deveye/types/sdk';

import { moderationCommands } from './contracts/commands';

/**
 * Un module de service : ni carte, ni entrée de compte, ni ligne dans l'écran
 * des rôles. Il n'existe que dans la popup « Modération », et par le provider
 * `MODERATION_PROVIDER` que les fonctionnalités qui gardent des fichiers
 * consultent à chaque arrivée.
 */
export const manifest = {
    id: 'x-moderation',
    label: 'Modération automatique',
    description:
        'Les empreintes et les noms de fichiers interdits sur ce serveur, consultés à chaque envoi par Hébergement et CloudSync, et le journal de ce qu’ils ont arrêté.',
    icon: 'shield',
    category: 'work',

    notifies: false,
    hasItems: false,
    shareTier: 'never',
    accountOnly: true,

    resources: ['x-moderation.rules', 'x-moderation.hits'],

    adminTabs: [
        { id: 'rules', label: 'Règles', moderation: true },
        { id: 'hits', label: 'Détections', moderation: true }
    ],

    commands: moderationCommands
} satisfies FeatureManifest;

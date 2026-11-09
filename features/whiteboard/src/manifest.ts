import { featureDescriptor } from '@deveye/types';
import type { FeatureManifest } from '@deveye/types/sdk';

import { whiteboardCommands } from './contracts/commands';

/**
 * `shareTier: 'open'` : la séance fusionne et écrit la scène sans session, donc
 * à l'étage ouvert, et un tableau se projette dans un autre espace.
 */
const descriptor = featureDescriptor('whiteboard');

export const manifest = {
    ...descriptor,
    category: 'work',
    resources: ['whiteboard.count', 'whiteboard.list'],
    /**
     * `objects` : les images collées, hors de la base. `live.publish` : les traits
     * et les pointeurs des participants. `members.read` : le nom et la couleur de
     * qui entre dans la séance, lus chez le serveur et non annoncés par le client.
     */
    nativeCapabilities: ['objects', 'live.publish', 'members.read'],
    /**
     * Le dessin pèse presque rien, les images collées pèsent : une borne contre
     * l'usage du tableau comme stockage, pas un argument d'offre.
     */
    quotas: [{ key: 'storage', label: 'de tableaux blancs', unit: 'bytes' }],
    /** Général en tête des réglages d'un tableau : titre, thème, fond, copie, suppression. */
    settings: { item: ['general'] },
    commands: whiteboardCommands
} satisfies FeatureManifest;

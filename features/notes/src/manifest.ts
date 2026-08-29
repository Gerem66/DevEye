import { featureDescriptor } from '@deveye/types';

import { notesCommands } from './contracts/commands';
import type { FeatureManifest } from '@deveye/types/sdk';

/**
 * Le descriptif (intitulé, icône, nom de l'élément, palier de partage) est
 * celui du registre publié ; le manifest n'ajoute que ce que le registre ne
 * porte pas (catégorie, ressources, commandes). Pas d'onglet de réglages
 * propre, pas de `nativeCapabilities`.
 *
 * `shareTier: 'perItem'` engage le module : l'entrée `items` de son serveur
 * (le boot refuse un module qui déclare sans l'offrir), `ctx.sharing.scope()`
 * dans ses listages et `ctx.items.restrictions()` sur ce qu'ils rendent.
 */
const descriptor = featureDescriptor('notes');

export const manifest = {
    ...descriptor,
    category: 'daily',
    /**
     * Le compte (métadonnées claires, jamais verrouillé) et la liste (notes
     * privées masquées session scellée), ravivés tous deux par le sujet `notes`.
     */
    resources: ['notes.count', 'notes.list'],
    commands: notesCommands
} satisfies FeatureManifest;

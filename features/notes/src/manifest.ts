import { featureDescriptor } from '@deveye/types';

import { notesCommands } from './contracts/commands';
import type { FeatureManifest } from '@deveye/types/sdk';

/**
 * Les Notes, au format manifest : la cinquième native rapatriée sur le SDK,
 * et la première à cheval sur les deux étages du chiffrement (le corps d'une
 * note privée à l'étage gardé, tout le reste à l'étage ouvert).
 *
 * Le descriptif (intitulé, icône, nom de l'élément, palier de partage) reste
 * celui du registre publié, étalé plutôt que recopié : une native garde son
 * identité dans @deveye/types, le manifest n'ajoute que ce que le registre ne
 * porte pas (catégorie, ressources, commandes). Pas d'onglet de réglages
 * propre : ce qu'une note règle (où elle est visible, ce qu'en voit chaque
 * rôle) vient de la coquille commune. Pas de `nativeCapabilities` : rien
 * n'est appelé.
 *
 * `shareTier: 'perItem'`, étalé du descripteur, engage le module : l'entrée
 * `items` de son serveur (domicile, intitulé, et `shareable`, qui refuse une
 * note privée), `ctx.sharing.scope()` dans ses listages (le codec choisi
 * ligne par ligne) et `ctx.items.restrictions()` sur ce qu'ils rendent. Le
 * boot refuse un module qui déclare sans offrir `items`.
 */
const descriptor = featureDescriptor('notes');

export const manifest = {
    ...descriptor,
    category: 'daily',
    /**
     * Deux clés de cache : le compte de la carte d'accueil (métadonnées
     * claires, jamais verrouillé) et la liste de l'écran (les notes privées y
     * sont masquées tant que la session est scellée). Le sujet `notes` les
     * ravive toutes les deux après une écriture, chez tous les membres de
     * l'espace, et dans les espaces reliés par une projection.
     */
    resources: ['notes.count', 'notes.list'],
    commands: notesCommands
} satisfies FeatureManifest;

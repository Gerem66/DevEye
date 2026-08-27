import { featureDescriptor } from '@deveye/types';

import { notesCommands } from './contracts/commands';
import type { FeatureManifest } from '@deveye/types/sdk';

/**
 * Les Notes, au format manifest : la cinquième native rapatriée sur le SDK,
 * et la première à cheval sur les deux étages du chiffrement (le corps d'une
 * note privée à l'étage gardé, tout le reste à l'étage ouvert).
 *
 * Le descriptif (intitulé, icône, nom de l'élément) reste celui du registre
 * publié, étalé plutôt que recopié : une native garde son identité dans
 * @deveye/types, le manifest n'ajoute que ce que le registre ne porte pas
 * (catégorie, ressources, commandes). Pas d'onglet de
 * réglages : les notes n'ont rien à régler. Pas de `nativeCapabilities` :
 * rien n'est appelé.
 */
const descriptor = featureDescriptor('notes');

export const manifest = {
    ...descriptor,
    /**
     * Déclaré PAR-DESSUS le descripteur, qui dit `'perItem'`.
     *
     * Le descripteur dit ce que le chiffrement AUTORISE : le corps d'une note
     * ordinaire vit à l'étage ouvert, le serveur saurait donc le servir dans
     * un autre espace. Mais le listage n'est pas branché sur le partage
     * (`Docs/SHARING.md` §9 : un graphe dossiers/notes, pas des lignes), et un
     * module qui déclare autre chose que `'never'` s'engage à l'être (entrée
     * `items` côté serveur, `ctx.sharing.scope()` dans ses listages) : le
     * boot le refuse sinon. Le registre publié garde sa promesse ; le
     * manifest dit l'état du code. Brancher les Notes, c'est retirer cette
     * ligne et tenir l'engagement.
     */
    shareTier: 'never',
    category: 'daily',
    /**
     * Deux clés de cache : le compte de la carte d'accueil (métadonnées
     * claires, jamais verrouillé) et la liste de l'écran (les notes privées y
     * sont masquées tant que la session est scellée). Le sujet `notes` les
     * ravive toutes les deux après une écriture, chez tous les membres de
     * l'espace.
     */
    resources: ['notes.count', 'notes.list'],
    commands: notesCommands
} satisfies FeatureManifest;

import { featureDescriptor } from '@deveye/types';

import { passwordCommands } from './contracts/commands';
import type { FeatureManifest } from '@deveye/types/sdk';

/**
 * Le Coffre, au format manifest : la quatrième native rapatriée sur le SDK,
 * et la première à vivre tout entière à l'étage gardé.
 *
 * Le descriptif (intitulé, icône, nom de l'élément, `shareTier: 'never'`)
 * reste celui du registre publié, étalé plutôt que recopié : une native garde
 * son identité dans @deveye/types, le manifest n'ajoute que ce que le registre
 * ne porte pas (catégorie, ressources, segment de présence, commandes). Pas
 * d'onglet de réglages : le coffre n'a rien à régler.
 */
const descriptor = featureDescriptor('password');

export const manifest = {
    ...descriptor,
    category: 'security',
    /**
     * Deux clés de cache : le compte de la carte d'accueil (métadonnées
     * claires, jamais verrouillé) et la liste masquée de l'écran. Le sujet
     * `password` les ravive toutes les deux après une écriture, chez tous les
     * membres de l'espace.
     */
    resources: ['password.count', 'password.list'],
    /**
     * Le rendez-vous de présence : l'entrée ouverte dans le formulaire, par
     * son identifiant nu. Octet pour octet ce que la vue déclare via
     * `useLiveSegment('l1', String(id))` ; le descripteur dit `hasItems`,
     * donc le manifest le porte.
     */
    itemSegment: (id) => String(id),
    commands: passwordCommands
} satisfies FeatureManifest;

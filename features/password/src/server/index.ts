import type { FeatureServer } from '@deveye/types/sdk/server';

import { passwordHandlers } from './handlers';
import { createRepo, type PasswordRepo } from './repo';

/**
 * L'entrée serveur du module. Pas de `migrationsDir` : la table du Coffre
 * date du socle (001, rattachée à l'espace par la 048) et n'en bougera
 * jamais ; une nouvelle table du module inaugurerait `src/server/migrations/`
 * avec le préfixe `ft_password_`.
 *
 * Pas de `createService` : rien ne tourne en fond. Pas d'entrée `items` non
 * plus : `shareTier: 'never'` (voir le registre publié : un partage dont la
 * survie dépend du chiffrement par mot de passe n'est pas un partage).
 */
export const serverEntry: FeatureServer<PasswordRepo> = {
    createRepo,
    features: passwordHandlers
};

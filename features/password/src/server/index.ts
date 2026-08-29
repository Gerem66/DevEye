import type { FeatureServer } from '@deveye/types/sdk/server';

import { passwordHandlers } from './handlers';
import { createRepo, type PasswordRepo } from './repo';

/**
 * Pas de `migrationsDir` : la table du Coffre est dans le socle. Pas de
 * `createService` ni d'entrée `items` : `shareTier: 'never'`, un partage dont
 * la survie dépend du chiffrement par mot de passe n'est pas un partage.
 */
export const serverEntry: FeatureServer<PasswordRepo> = {
    createRepo,
    features: passwordHandlers
};

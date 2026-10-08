import type { UserSettingFlag } from '@deveye/types';

import { useAuth } from '@/auth/AuthProvider';

/**
 * Le réglage « ne pas afficher la carte d'ajout au bout des sections ». Posé
 * en négatif : la carte est là par défaut, c'est le chemin d'un compte neuf
 * vers le marché. Il vit sur le compte et suit la personne d'un appareil à
 * l'autre.
 */
export const HIDE_HOME_ADD_TILE: UserSettingFlag = 'hideHomeAddTile';

/** `true` tant que le compte courant n'a pas retiré la carte. */
export function useShowHomeAddTile(): boolean {
    const { user } = useAuth();
    return !(user?.settings.includes(HIDE_HOME_ADD_TILE) ?? false);
}

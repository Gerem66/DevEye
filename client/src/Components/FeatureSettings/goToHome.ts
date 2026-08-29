import type { FeatureId } from '@deveye/types';

import { startTeleport } from '@/stores/live';
import { requestItemSettings } from '@/stores/settingsRequest';
import { requestSelectWorkspace } from '@/stores/viewRequest';
import { getWorkspaceState } from '@/stores/workspace';

/**
 * « Aller régler ça là où ça se règle » : un élément projeté montre des
 * réglages inertes (canaux, partage) qui appartiennent à son espace d'origine.
 * Bascule vers cet espace, ouverture de la fiche par téléportation, puis
 * réouverture des réglages sur l'onglet demandé (`stores/settingsRequest`,
 * consommé par le bouton commun). Le segment de présence d'un élément est son
 * id nu, `l1:<id>`, pour toutes les features.
 */

/** Le nom de l'espace si l'appelant en est membre, sinon `null` : sans accès,
 *  aucun saut à proposer. */
export function accessibleWorkspaceName(workspaceId: number | null): string | null {
    if (workspaceId === null) return null;
    return getWorkspaceState().workspaces.find((w) => w.id === workspaceId)?.name ?? null;
}

export function goToItemSettings(workspaceId: number, feature: FeatureId, itemId: number, section: string): void {
    requestItemSettings({ workspaceId, feature, itemId, section });
    startTeleport(workspaceId, [`view:${feature}`, `l1:${itemId}`]);
    requestSelectWorkspace(workspaceId);
}

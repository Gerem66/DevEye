import type { FeatureId } from '@deveye/types';

import { startTeleport } from '@/stores/live';
import { requestItemSettings } from '@/stores/settingsRequest';
import { requestSelectWorkspace } from '@/stores/viewRequest';
import { getWorkspaceState } from '@/stores/workspace';

/**
 * « Aller régler ça là où ça se règle. »
 *
 * Un élément projeté montre des réglages inertes (canaux, partage) parce
 * qu'ils appartiennent à son espace d'origine. Plutôt que d'expliquer le
 * refus, l'écran propose d'y aller : bascule vers l'espace d'origine,
 * ouverture de la fiche de l'élément (la téléportation, la même mécanique que
 * « rejoindre quelqu'un »), puis réouverture de ses réglages sur l'onglet
 * demandé (l'intention de `stores/settingsRequest`, consommée par le bouton
 * commun une fois la fiche montée).
 *
 * Le segment de présence d'un élément est son identifiant nu, `l1:<id>`,
 * pour toutes les features : c'est ce que chaque vue déclare via
 * `useLiveSegment('l1', String(id))`, et le préfixe `view:<feature>` du chemin
 * dit déjà de quelle sorte d'élément il s'agit. Il y a eu une table de
 * formats par feature (`repo:12`, `db:12`...) et un `itemSegment` au manifest
 * des modules pour la remplacer ; les deux ont disparu le jour où les six
 * natives préfixées sont passées à l'id nu.
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

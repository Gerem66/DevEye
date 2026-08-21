import { isExternalFeatureId, type FeatureId, type WorkspaceFeatureId } from 'deveye-types';

import { startTeleport } from '@/stores/live';
import { requestItemSettings } from '@/stores/settingsRequest';
import { requestSelectWorkspace } from '@/stores/viewRequest';
import { getWorkspaceState } from '@/stores/workspace';
import { moduleManifest } from '@/sdk/modules';

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
 */

/**
 * Le segment de présence (`l1`) d'un élément, par fonctionnalité.
 *
 * ⚠️ La MÊME valeur que le `useLiveSegment('l1', …)` déclaré par la feature
 * dans son index : c'est un rendez-vous, pas une convention centrale. Une
 * feature qui change son format de segment doit corriger ici, sinon la
 * téléportation la laissera sur sa liste au lieu d'ouvrir la fiche.
 */
const ITEM_SEGMENT: Partial<Record<WorkspaceFeatureId, (itemId: number) => string>> = {
    uptime: (id) => String(id),
    database: (id) => `db:${id}`,
    deploy: (id) => `target:${id}`,
    git: (id) => `repo:${id}`,
    audience: (id) => `site:${id}`,
    backup: (id) => `job:${id}`
};

/** Le nom de l'espace si l'appelant en est membre, sinon `null` : sans accès,
 *  aucun saut à proposer. */
export function accessibleWorkspaceName(workspaceId: number | null): string | null {
    if (workspaceId === null) return null;
    return getWorkspaceState().workspaces.find((w) => w.id === workspaceId)?.name ?? null;
}

export function goToItemSettings(workspaceId: number, feature: FeatureId, itemId: number, section: string): void {
    requestItemSettings({ workspaceId, feature, itemId, section });
    // La table ne connaît que les natives ; un module apporte le sien par son
    // manifest (`itemSegment`), même contrat de rendez-vous octet pour octet.
    const segment = isExternalFeatureId(feature) ? moduleManifest(feature)?.itemSegment : ITEM_SEGMENT[feature];
    startTeleport(workspaceId, segment ? [`view:${feature}`, `l1:${segment(itemId)}`] : [`view:${feature}`]);
    requestSelectWorkspace(workspaceId);
}

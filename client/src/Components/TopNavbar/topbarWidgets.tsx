import { type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import type { FeatureId, HomeTopbarWidgetId, WorkspaceKind } from '@deveye/types';

import { useHomeLayout } from '@/stores/homeLayout';
import { useActiveWorkspace, useWorkspacePermissions } from '@/stores/workspace';
import { clientModules, moduleClient } from '@/sdk/registry';
import { SecrecyTimer } from './SecrecyTimer';
import { LivePresence } from './LivePresence';
import styles from './TopNavbar.module.css';

/**
 * Catalog of the compact widgets that can be pinned to the top-right of the
 * navbar: the source of truth for their label/icon/description in the in-place
 * "add" picker (see {@link EditableTopbarWidgets}). The live rendering of each is
 * {@link renderTopbarWidget}.
 */
export interface TopbarWidgetMeta {
    id: HomeTopbarWidgetId;
    title: string;
    icon: string;
    description: string;
    /** Widget d'un module : n'existe que si le rôle accorde cette feature. */
    feature?: FeatureId;
}

const NATIVE_TOPBAR_WIDGETS: TopbarWidgetMeta[] = [
    { id: 'secrecy', title: 'Chiffrement', icon: 'lock', description: 'Minuteur du chiffrement par mot de passe' },
    { id: 'live', title: 'Présence', icon: 'user', description: 'Qui est dans cet espace, et où' }
];

/**
 * Le catalogue complet : les natifs, puis les widgets des modules. PARESSEUX,
 * même régime que le catalogue des tuiles : figé au premier appel, jamais à
 * l'import.
 */
let MERGED_TOPBAR: TopbarWidgetMeta[] | null = null;

function topbarCatalog(): TopbarWidgetMeta[] {
    MERGED_TOPBAR ??= [
        ...NATIVE_TOPBAR_WIDGETS,
        ...clientModules().flatMap(({ manifest, client }): TopbarWidgetMeta[] => {
            if (!manifest.topbarWidget || !client.TopbarWidget) return [];
            return [
                {
                    id: manifest.id,
                    title: manifest.label,
                    icon: manifest.icon,
                    description: manifest.topbarWidget.description,
                    feature: manifest.id
                }
            ];
        })
    ];
    return MERGED_TOPBAR;
}

/**
 * Les widgets proposables dans cet espace. « Présence » n'a aucun sens dans un
 * espace personnel : il n'y est pas proposé, et une disposition qui l'y
 * porterait ne l'afficherait pas. Une seule fonction pour la liste vivante,
 * l'éditeur et le dialogue d'ajout.
 */
export function availableTopbarWidgets(
    kind: WorkspaceKind | undefined,
    canFeature: (f: FeatureId) => boolean
): TopbarWidgetMeta[] {
    return topbarCatalog().filter((w) => {
        if (w.id === 'live' && kind !== 'shared') return false;
        // Le widget d'un module suit le droit de sa feature, comme sa carte de
        // grille. Le composant ne reçoit aucune prop : tout repasse par ses
        // propres commandes, autorisées côté serveur.
        if (w.feature && !canFeature(w.feature)) return false;
        return true;
    });
}

/** Le même filtre, appliqué à une liste d'identifiants déjà épinglés. */
export function usableTopbarWidgetIds(
    ids: readonly HomeTopbarWidgetId[],
    kind: WorkspaceKind | undefined,
    canFeature: (f: FeatureId) => boolean
): HomeTopbarWidgetId[] {
    const allowed = new Set(availableTopbarWidgets(kind, canFeature).map((w) => w.id));
    return ids.filter((id) => allowed.has(id));
}

/** Render a single topbar widget by id (shared by the live navbar and the editor). */
export function renderTopbarWidget(id: HomeTopbarWidgetId, onOpenSecurity?: (e: ReactMouseEvent) => void): ReactNode {
    switch (id) {
        case 'secrecy':
            return <SecrecyTimer onOpenSecurity={onOpenSecurity} />;
        case 'live':
            return <LivePresence />;
        default: {
            // Widget d'un module : l'hôte fournit le cadre et le titre, le
            // module le contenu, sans props.
            const meta = topbarCatalog().find((w) => w.id === id);
            const Widget = moduleClient(id)?.TopbarWidget;
            if (!meta || !Widget) return null;
            return (
                <span className={styles.statusItem} title={meta.title}>
                    <Widget />
                </span>
            );
        }
    }
}

/**
 * Live mini-widgets pinned to the top-right of the navbar, in the user's order.
 * The set comes from the home layout's `topbar` category, edited in place via
 * {@link EditableTopbarWidgets}; empty by default so nothing shows until opted in.
 */
export function TopbarWidgets({ onOpenSecurity }: { onOpenSecurity?: (e: ReactMouseEvent) => void }) {
    const layout = useHomeLayout();
    const workspace = useActiveWorkspace();
    const { canFeature } = useWorkspacePermissions();
    const items = usableTopbarWidgetIds(layout.topbar, workspace?.kind, canFeature);
    if (items.length === 0) return null;
    return (
        <div className={styles.status}>
            {items.map((id) => (
                <span key={id}>{renderTopbarWidget(id, onOpenSecurity)}</span>
            ))}
        </div>
    );
}

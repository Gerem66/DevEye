import { type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import type { FeatureId, HomeTopbarWidgetId, WorkspaceKind } from '@deveye/types';

import { useHomeLayout } from '@/stores/homeLayout';
import { useActiveWorkspace, useWorkspacePermissions } from '@/stores/workspace';
import { openFeature } from '@/sdk';
import { cardModules, moduleClient } from '@/sdk/registry';
import { SecrecyTimer } from './SecrecyTimer';
import { LivePresence } from './LivePresence';
import { PublicIp } from './PublicIp';
import { SearchButton } from './SearchButton';
import styles from './TopNavbar.module.css';
import pill from './TopbarPill.module.css';

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
    { id: 'live', title: 'Présence', icon: 'user', description: 'Qui est dans cet espace, et où' },
    {
        id: 'publicIp',
        title: 'Mon IP',
        icon: 'globe',
        description: 'L’adresse publique par laquelle ce navigateur sort'
    },
    { id: 'search', title: 'Recherche', icon: 'search', description: 'Retrouver une fonctionnalité par son nom' }
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
        ...cardModules().flatMap(({ manifest, client }): TopbarWidgetMeta[] => {
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

/**
 * Render a single topbar widget by id (shared by the live navbar and the editor).
 * `editing` : l'éditeur monte le widget vivant en aperçu, et certains y offrent
 * leur réglage plutôt que leur geste courant.
 */
export function renderTopbarWidget(
    id: HomeTopbarWidgetId,
    opts: { onOpenSecurity?: (e: ReactMouseEvent) => void; editing?: boolean } = {}
): ReactNode {
    switch (id) {
        case 'secrecy':
            return <SecrecyTimer onOpenSecurity={opts.onOpenSecurity} />;
        case 'live':
            return <LivePresence />;
        case 'publicIp':
            return <PublicIp editing={opts.editing} />;
        case 'search':
            return <SearchButton editing={opts.editing} />;
        default: {
            // Widget d'un module : l'hôte fournit la pastille, le titre et le
            // geste (ouvrir la feature), le module le contenu, sans props.
            const meta = topbarCatalog().find((w) => w.id === id);
            const Widget = moduleClient(id)?.TopbarWidget;
            if (!meta?.feature || !Widget) return null;
            const feature = meta.feature;
            if (opts.editing) {
                return (
                    <span className={`${pill.pill} ${pill.module}`} title={meta.title}>
                        <Widget />
                    </span>
                );
            }
            return (
                <button
                    type='button'
                    className={`${pill.pill} ${pill.module}`}
                    title={`Ouvrir ${meta.title}`}
                    onClick={() => openFeature(feature)}
                >
                    <Widget />
                </button>
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
                <span key={id}>{renderTopbarWidget(id, { onOpenSecurity })}</span>
            ))}
        </div>
    );
}

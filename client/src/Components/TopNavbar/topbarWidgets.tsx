import { type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import type { FeatureId, HomeTopbarWidgetId, WorkspaceKind } from '@deveye/types';

import { useDevices } from '@/stores/devices';
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
    { id: 'devices', title: 'Appareils connectés', icon: 'server', description: "Nombre d'appareils en ligne" },
    { id: 'secrecy', title: 'Chiffrement', icon: 'lock', description: 'Minuteur du chiffrement par mot de passe' },
    { id: 'live', title: 'Présence', icon: 'user', description: 'Qui est dans cet espace, et où' }
];

/**
 * Le catalogue complet : les natifs, puis les widgets déclarés par les modules
 * (manifest `topbarWidget` + composant de l'entrée client). PARESSEUX, même
 * régime que le catalogue des tuiles : figé au premier appel, toujours au
 * rendu, jamais à l'import.
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
 * Les widgets proposables dans cet espace.
 *
 * « Présence » n'a aucun sens dans un espace personnel : c'est une salle d'une
 * seule personne, le widget y afficherait à vie « vous, tout seul ». Il n'est
 * donc pas seulement masqué, il n'est **pas proposé** au choix, et un espace
 * personnel qui en hériterait par une disposition venue d'ailleurs ne
 * l'afficherait pas davantage.
 *
 * Une seule fonction pour les trois usages (liste vivante, éditeur, dialogue
 * d'ajout) : la règle ne peut pas diverger entre eux.
 */
export function availableTopbarWidgets(
    kind: WorkspaceKind | undefined,
    canFeature: (f: FeatureId) => boolean
): TopbarWidgetMeta[] {
    return topbarCatalog().filter((w) => {
        if (w.id === 'live' && kind !== 'shared') return false;
        // Le widget d'un module suit le droit de SA feature : même règle que
        // sa carte de grille, l'absence du droit vaut absence du widget. Le
        // composant ne reçoit d'ailleurs AUCUNE prop : tout ce qu'il montre
        // repasse par ses propres commandes, autorisées côté serveur.
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

/** Devices mini-widget: online / total connected devices (archived excluded). */
export function DevicesStatus() {
    const { devices: allDevices } = useDevices();
    const devices = allDevices.filter((d) => d.status !== 'archived');
    const onlineCount = devices.filter((d) => d.online).length;
    return (
        <span className={styles.statusItem} title='Appareils en ligne'>
            <span className={`icon icon-server ${onlineCount > 0 ? styles.statusOk : ''}`} />
            {onlineCount}/{devices.length}
        </span>
    );
}

/** Render a single topbar widget by id (shared by the live navbar and the editor). */
export function renderTopbarWidget(id: HomeTopbarWidgetId, onOpenSecurity?: (e: ReactMouseEvent) => void): ReactNode {
    switch (id) {
        case 'devices':
            return <DevicesStatus />;
        case 'secrecy':
            return <SecrecyTimer onOpenSecurity={onOpenSecurity} />;
        case 'live':
            return <LivePresence />;
        default: {
            // Widget d'un module (Météo et Uptime compris) : l'hôte fournit le cadre
            // stylé et le titre, le module fournit le contenu, sans props.
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

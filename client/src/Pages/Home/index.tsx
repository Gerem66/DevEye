import { useState, useCallback, useMemo, useEffect, useRef, type ComponentType, type ReactNode } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';

import { useAuth } from '@/auth/AuthProvider';
import {
    getWorkspaceState,
    setActiveWorkspace,
    upsertWorkspace,
    useActiveWorkspace,
    useWorkspaceState
} from '@/stores/workspace';
import { ws } from '@/api/ws';
import { OpenPopup } from '@/Components/Popup';
import { isHomeReady, markHomeReady, onHomeReady } from '@/stores/homeReady';
import { devicesProvider, useDevices } from '@/devicesProvider';
import { setPermissions, useWorkspacePermissions } from '@/stores/workspace';
import { useResourceVersion } from '@/stores/invalidation';
import { syncThemeFromServer } from '@/stores/theme';
import { syncHomeLayoutFromServer } from '@/stores/homeLayout';
import {
    useHomeLayout,
    findFolder,
    getHomeLayout,
    placedDeviceIds,
    placedFeatureIds,
    pruneMissingDevices
} from '@/stores/homeLayout';
import { onOpenViewRequest, onSelectWorkspaceRequest } from '@/stores/viewRequest';
import { LiveProvider } from '@/live/LiveProvider';
import { LiveCursors } from '@/live/LiveCursors';
import { useLiveSegment } from '@/live/useLiveSegment';
import { TopNavbar } from '@/Components/TopNavbar';
import { Widget } from '@/Components/Widget';
import { WidgetGrid } from '@/Components/WidgetGrid';
import { WidgetPopup, FeatureKeepAlive } from '@/Components/WidgetPopup';
import { Wallpaper } from '@/Components/Wallpaper';
import { SettingsPanel } from '@/Components/SettingsPanel';
import { InfoPopup, openInfo } from '@/Components/InfoPopup';
import CreateWorkspacePopup, { CREATE_WORKSPACE_POPUP } from './popup-create-workspace';

// Structural feature views (no grid card)
import Security from '@/Features/Security';
import FeatureProfile from '@/Features/Profile';
import FeatureLogs from '@/Features/Logs';
import FeatureWorkspace from '@/Features/Workspace';
import FeatureUsers from '@/Features/Users';

import { featureCatalog, folderFeatures } from './catalog';
import { isForceReload } from './forceReload';
import {
    DEVICE_VIEW_PREFIX,
    deviceTileVisual,
    deviceViewId,
    featureTileVisual,
    shortcutTileVisual
} from './tiles/tileVisual';
import { AboutContent } from './about';
import { EditableHome } from './organize/EditableHome';
import { FolderOverlay, folderTitle } from './folders';

import type { HomeFeatureId, HomeLayout, HomeSection, WorkspaceFeatureId, WorkspacePermissions } from '@deveye/types';
import { isFeatureTile, isHomeFolder, isShortcutTile, WORKSPACE_FEATURE_IDS } from '@deveye/types';
import type { FeatureProps } from '@/Features/types';
import styles from './Dashboard.module.css';
import type { Workspace } from '@deveye/types';

/** A view openable full-screen in the popup (feature, structural page or device). */
interface ViewConfig {
    id: string;
    title: string;
    icon: string;
    /** Minutes the view stays mounted after its popup closes (see handleExitComplete). */
    cacheDurationMinutes?: number;
    /** Warm eagerly at idle after load (only honoured for grid features). */
    preload?: boolean;
    /** Has a grid card to morph from (feature/device) vs. fades in (page). */
    hasCard: boolean;
    /** Hold the encrypted DEK alive while open (see WidgetPopup's `holdSecrecy`). */
    holdSecrecy?: boolean;
    /** Static feature/page view component (typed to accept FeatureProps). */
    FullComponent?: ComponentType<FeatureProps>;
    /** Custom render for a device view, bound to its deviceId (the module's panel). */
    renderDevice?: () => ReactNode;
}

// Static views: the feature catalog (grid cards) + structural pages (reached
// from the navbar menu, no card). LAZY, comme le catalogue : figé au premier
// rendu, jamais à l'import, sinon les modules enregistrés après coup manquent.
let STATIC_VIEWS_MEMO: ViewConfig[] | null = null;
function staticViews(): ViewConfig[] {
    STATIC_VIEWS_MEMO ??= buildStaticViews();
    return STATIC_VIEWS_MEMO;
}
const buildStaticViews = (): ViewConfig[] => [
    ...featureCatalog().map((f) => ({
        id: f.id,
        title: f.title,
        icon: f.icon,
        cacheDurationMinutes: f.cacheDurationMinutes,
        preload: f.preload,
        hasCard: true,
        holdSecrecy: f.holdSecrecy,
        FullComponent: f.FullComponent
    })),
    {
        id: 'profile',
        title: 'Profil',
        icon: 'user',
        cacheDurationMinutes: 0,
        hasCard: false,
        FullComponent: FeatureProfile
    },
    {
        id: 'security',
        title: 'Sécurité',
        icon: 'shield',
        cacheDurationMinutes: 0,
        hasCard: false,
        FullComponent: Security
    },
    {
        id: 'logs',
        title: 'Logs',
        icon: 'activity',
        cacheDurationMinutes: 5,
        hasCard: false,
        FullComponent: FeatureLogs
    },
    {
        id: 'users',
        title: 'Utilisateurs',
        icon: 'users',
        cacheDurationMinutes: 0,
        hasCard: false,
        FullComponent: FeatureUsers
    },
    {
        id: 'workspace',
        title: 'Espace de travail',
        icon: 'users',
        cacheDurationMinutes: 0,
        hasCard: false,
        FullComponent: FeatureWorkspace
    }
];

/**
 * La feature dont une vue dépend, ou `null` : les vues de compte et
 * d'administration ont leurs propres gardes, un rôle d'espace n'en décide pas.
 */
function featureBehind(viewId: string): WorkspaceFeatureId | null {
    if (WORKSPACE_FEATURE_IDS.includes(viewId as WorkspaceFeatureId)) return viewId as WorkspaceFeatureId;
    // Chaque vue d'appareil relève du droit de la feature Appareils.
    if (viewId.startsWith(DEVICE_VIEW_PREFIX)) return 'devices';
    return null;
}

/**
 * Cette vue a-t-elle encore un sens dans l'espace où l'on arrive ? Le rôle doit
 * ouvrir la feature et la tuile doit figurer sur l'accueil de la cible. Les vues
 * sans tuile (profil, sécurité, journaux, utilisateurs, espace) échappent à la
 * règle : elles ne sont pas composées dans l'accueil.
 */
function survivesWorkspaceSwitch(
    viewId: string,
    layout: HomeLayout,
    permissions: WorkspacePermissions,
    views: readonly ViewConfig[]
): boolean {
    const feature = featureBehind(viewId);
    if (feature !== null && !permissions.features.some((g) => g.feature === feature)) return false;

    const config = views.find((v) => v.id === viewId);
    if (config && !config.hasCard) return true;

    if (viewId.startsWith(DEVICE_VIEW_PREFIX)) {
        // Un appareil appartient à un espace : son id n'existe pas ailleurs, la
        // vue ne survit donc jamais.
        return placedDeviceIds(layout).includes(viewId.slice(DEVICE_VIEW_PREFIX.length));
    }
    return placedFeatureIds(layout).includes(viewId as HomeFeatureId);
}

function getGreeting(): string {
    const hour = new Date().getHours();
    if (hour < 12) return 'Bonjour';
    if (hour < 18) return 'Bon après-midi';
    return 'Bonsoir';
}

/**
 * Courbe du repli d'une section : départ franc, arrivée longue, la section se
 * pose au lieu de s'arrêter net. Un ressort se lirait comme un rebond.
 */
const FOLD_EASE = [0.32, 0.72, 0, 1] as const;

/**
 * Section de l'accueil. Le repli est local et éphémère : `section.collapsed`
 * dit comment la section s'ouvre, pas comment on l'a laissée ; replier pour
 * dégager la vue ne doit ni modifier la disposition partagée ni écrire réseau.
 */
function CollapsibleSection({ section, children }: { section: HomeSection; children: ReactNode }) {
    const foldable = section.collapsible === true;
    const [folded, setFolded] = useState(foldable && section.collapsed === true);
    /** Le dépliage est terminé : la boîte peut cesser de découper son contenu. */
    const [settled, setSettled] = useState(true);
    const reduced = useReducedMotion() === true;

    // L'organiseur peut changer les deux réglages sous nos pieds : on repart de
    // l'état déclaré plutôt que de garder un repli devenu impossible.
    useEffect(() => {
        setFolded(section.collapsible === true && section.collapsed === true);
    }, [section.collapsible, section.collapsed]);

    const toggle = () => setFolded((v) => !v);

    if (!foldable) {
        return (
            <div className={styles.sectionGroup}>
                {section.title && <h2 className={styles.sectionHeading}>{section.title}</h2>}
                {children}
            </div>
        );
    }

    return (
        <div className={styles.sectionGroup}>
            {/* Le bouton est l'intitulé : une cible séparée serait minuscule.
                Sans titre, le chevron seul reste cliquable. */}
            <button type='button' className={styles.sectionToggle} aria-expanded={!folded} onClick={toggle}>
                <span
                    className={`icon icon-chevron-down ${folded ? styles.chevronFolded : styles.chevron}`}
                    aria-hidden='true'
                />
                <span className={styles.sectionHeading}>{section.title ?? 'Section'}</span>
            </button>

            {/* `height: auto` est mesuré et animé par framer, la grille garde sa
                hauteur naturelle. `overflow: hidden` seulement pendant le
                mouvement : gardé ensuite, il rognerait le soulèvement des cartes
                au survol. */}
            <AnimatePresence initial={false}>
                {!folded && (
                    <motion.div
                        key='body'
                        className={styles.sectionBody}
                        style={{ overflow: settled ? 'visible' : 'hidden' }}
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={
                            reduced
                                ? { duration: 0 }
                                : { height: { duration: 0.3, ease: FOLD_EASE }, opacity: { duration: 0.18 } }
                        }
                        onAnimationStart={() => setSettled(false)}
                        onAnimationComplete={() => setSettled(true)}
                    >
                        {children}
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
}

/** Espace personnel : la salutation en titre ; espace partagé : son nom, pour
 *  savoir d'un coup d'œil où l'on est, la salutation passe en sous-titre. */
function homeHeading(workspace: Workspace, username: string): { title: string; subtitle: string } {
    if (workspace.kind === 'personal') {
        return { title: `${getGreeting()}, ${username}`, subtitle: upperFirst(formatDate()) };
    }
    const members = workspace.users.length;
    return {
        title: workspace.name,
        subtitle: upperFirst(
            `${getGreeting()} ${username} · ${members} membre${members > 1 ? 's' : ''} · ${formatDate()}`
        )
    };
}

function formatDate(): string {
    return new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
}

/**
 * Majuscule initiale seule : `toLocaleDateString` rend « mercredi » et le
 * sous-titre ouvre une phrase. Pas de `text-transform: capitalize`, qui
 * capitaliserait chaque mot (« 1 Membre », « 12 Juin »).
 */
function upperFirst(text: string): string {
    return text.charAt(0).toUpperCase() + text.slice(1);
}

export default function HomePage() {
    const { user, refresh } = useAuth();
    /** Le retrait de l'accueil derrière un dossier déployé est un mouvement : il
     *  se coupe, le flou reste (voir `.recessed`). */
    const reducedMotion = useReducedMotion() === true;
    const { epoch: workspaceEpoch } = useWorkspaceState();
    const currentWorkspace = useActiveWorkspace();
    const layout = useHomeLayout();
    const { devices, loading: devicesLoading, error: devicesError } = useDevices();
    // Lu au rendu, jamais à l'import : le registre est rempli par
    // l'initialiseur avant le premier rendu. `undefined` sans le module.
    const devicesModule = devicesProvider();
    const { canFeature, can } = useWorkspacePermissions();
    // Deux réglages de l'espace, deux capacités. Lues en booléens (et non via
    // `can`, recréé à chaque rendu) pour servir de dépendances stables.
    const canAppearance = can('workspace.appearance');
    const canLayout = can('workspace.layout');

    const [expandedWidget, setExpandedWidget] = useState<string | null>(null);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [editing, setEditing] = useState(false);
    const [autoAddSection, setAutoAddSection] = useState(false);
    /**
     * Bascule d'espace en cours : la disposition affichée est encore celle de
     * l'espace quitté, les droits sont déjà vides. La grille reste montée sans
     * grisage (des droits vides ne sont ceux de personne), et c'est ce qui permet
     * aux tuiles communes de glisser vers leur nouvelle identité `époque:feature`.
     */
    const [switching, setSwitching] = useState(false);
    /**
     * Le dossier déployé : son id (relu dans la disposition à chaque rendu, donc
     * vivant) et la tuile d'où il sort, mesurée au clic avant que le fond ne
     * recule. `offset` est la hauteur de l'en-tête, pour poser les cartes au
     * niveau de la grille.
     */
    const [openFolder, setOpenFolder] = useState<{ id: string; source: DOMRect; offset: number } | null>(null);
    /** L'en-tête (« Bonjour… »), mesuré à l'ouverture d'un dossier. */
    const greetingRef = useRef<HTMLElement>(null);

    // Set of view ids whose components are currently mounted (cached).
    const [mountedFeatures, setMountedFeatures] = useState<Set<string>>(new Set());
    // Per-view "generation" counter — bumping it remounts the view (Ctrl+click reset).
    const [featureGen, setFeatureGen] = useState<Map<string, number>>(new Map());
    // The open popup's body element — feature content is portaled into it.
    const [popupBodyEl, setPopupBodyEl] = useState<HTMLDivElement | null>(null);
    // Repère des curseurs : le corps de la popup quand une feature est ouverte,
    // la colonne `content` sinon (bornée et centrée, et non `main` pleine
    // largeur : deux écrans doivent placer le curseur au même point de la même
    // tuile). Jamais un nœud d'une feature : `FeatureKeepAlive` les déplace.
    const [contentEl, setContentEl] = useState<HTMLDivElement | null>(null);
    // Timers for TTL-based auto-unmount, keyed by view id.
    const ttlTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
    // The view whose popup is currently animating out (policy applied on exit).
    const closingFeatureRef = useRef<string | null>(null);
    // Views that must unmount on close regardless of their cache TTL (a feature
    // asked to close itself with nothing to show — see requestCloseFeature).
    const forceUnmountRef = useRef<Set<string>>(new Set());
    // Expand requested while another popup is still open / animating out.
    const pendingExpandRef = useRef<{ widgetId: string; forceReset: boolean } | null>(null);
    /**
     * L'époque d'espace à l'ouverture de la popup, qui identifie sa paire de
     * morphe. Sans elle, une bascule remonte les tuiles avec le même `layoutId`
     * que la popup ouverte, et framer-motion (un seul élément par identité)
     * projette la popup dans la tuile, à la taille d'une carte.
     */
    const morphEpochRef = useRef(0);

    const unmountFeature = useCallback((featureId: string) => {
        clearTimeout(ttlTimers.current.get(featureId));
        ttlTimers.current.delete(featureId);
        setMountedFeatures((prev) => {
            if (!prev.has(featureId)) return prev;
            const next = new Set(prev);
            next.delete(featureId);
            return next;
        });
    }, []);

    /**
     * Remonte une vue à neuf sans la refermer : c'est ce qui permet à une feature
     * de traverser une bascule d'espace en restant à l'écran.
     */
    const remountFeature = useCallback((featureId: string) => {
        clearTimeout(ttlTimers.current.get(featureId));
        ttlTimers.current.delete(featureId);
        setFeatureGen((prev) => {
            const next = new Map(prev);
            next.set(featureId, (prev.get(featureId) ?? 0) + 1);
            return next;
        });
        setMountedFeatures((prev) => new Set(prev).add(featureId));
    }, []);

    const doExpand = useCallback((widgetId: string, forceReset: boolean) => {
        clearTimeout(ttlTimers.current.get(widgetId));
        ttlTimers.current.delete(widgetId);
        if (closingFeatureRef.current === widgetId) closingFeatureRef.current = null;
        // Une ouverture, et elle seule, fixe l'identité de morphe : la relecture
        // d'une vue déjà ouverte passe par `remountFeature`, qui n'y touche pas.
        morphEpochRef.current = getWorkspaceState().epoch;

        if (forceReset) {
            setFeatureGen((prev) => {
                const next = new Map(prev);
                next.set(widgetId, (prev.get(widgetId) ?? 0) + 1);
                return next;
            });
        }

        setMountedFeatures((prev) => new Set(prev).add(widgetId));
        setExpandedWidget(widgetId);
    }, []);

    /** Le rôle courant ouvre-t-il cette vue ? La lecture suffit. */
    const allowedToOpen = useCallback(
        (viewId: string): boolean => {
            const feature = featureBehind(viewId);
            return feature === null || canFeature(feature);
        },
        [canFeature]
    );

    const viewTitleOf = useCallback(
        (viewId: string): string =>
            staticViews().find((v) => v.id === viewId)?.title ??
            (viewId.startsWith(DEVICE_VIEW_PREFIX) ? 'Appareils' : viewId),
        []
    );

    const handleExpand = useCallback(
        (widgetId: string, forceReset = false) => {
            // Pendant une bascule, les droits affichés sont vides : ni ouvrir ni
            // refuser, le clic ne fait rien.
            if (switching) return;
            // Garde unique : tuile, navigation inter-features et menu de la
            // topbar aboutissent tous ici.
            if (!allowedToOpen(widgetId)) {
                void openInfo({
                    title: 'Accès refusé',
                    body: (
                        <p>
                            Votre rôle ne donne pas accès à « {viewTitleOf(widgetId)} » dans cet espace. Demandez-le au
                            propriétaire ou à un membre habilité à gérer les rôles.
                        </p>
                    ),
                    width: 400
                });
                return;
            }
            if (expandedWidget && expandedWidget !== widgetId) {
                pendingExpandRef.current = { widgetId, forceReset };
                closingFeatureRef.current = expandedWidget;
                setExpandedWidget(null);
                return;
            }
            doExpand(widgetId, forceReset);
        },
        [switching, expandedWidget, doExpand, allowedToOpen, viewTitleOf]
    );

    const handleClose = useCallback(() => {
        closingFeatureRef.current = expandedWidget;
        setExpandedWidget(null);
    }, [expandedWidget]);

    // Mirror of expandedWidget for stable callbacks that must read it at call time.
    const expandedWidgetRef = useRef(expandedWidget);
    expandedWidgetRef.current = expandedWidget;

    /** Referme la vue ouverte si les droits relus ne la couvrent plus. */
    const reconcileOpenView = useCallback(
        (permissions: WorkspacePermissions) => {
            const open = expandedWidgetRef.current;
            if (open && !survivesWorkspaceSwitch(open, getHomeLayout(), permissions, viewsRef.current)) {
                handleClose();
            }
        },
        [handleClose]
    );

    /**
     * L'accueil de l'espace a changé ailleurs (sujet `home`) : `workspace.activate`
     * rend thème, disposition et droits d'un coup, et `reconcile` referme une vue
     * ouverte sur une feature devenue interdite. L'auteur est exclu de sa propre
     * diffusion. La sûreté ne dépend pas de cette relecture : le serveur
     * re-résout les droits à chaque commande (`invalidateAccess`).
     */
    const stateVersion = useResourceVersion('workspace.activate');
    useEffect(() => {
        // Rien à relire au premier rendu : la session vient de tout livrer.
        if (stateVersion === 0) return;
        void (async () => {
            try {
                const res = await ws.send('workspace.activate', {});
                setPermissions(res.permissions);
                syncThemeFromServer(res.theme);
                syncHomeLayoutFromServer(res.homeLayout);
                reconcileOpenView(res.permissions);
            } catch {
                // Plus d'accès du tout à cet espace : la session sait où nous
                // remettre, et referme ce qui était ouvert en chemin.
                if (expandedWidgetRef.current) handleClose();
                void refresh();
            }
        })();
    }, [stateVersion, handleClose, refresh, reconcileOpenView]);

    /**
     * Nom, logo et membres de l'espace n'existent que dans le bundle de `/me` :
     * seule une relecture de session les rafraîchit. Chemin lourd (avatars de
     * tous les membres), d'où un sujet dédié qui ne part que sur un changement
     * d'espace, pas sur un glisser-déposer de tuile.
     */
    const sessionVersion = useResourceVersion('workspace.session');
    useEffect(() => {
        if (sessionVersion === 0) return;
        void (async () => {
            await refresh();
            reconcileOpenView(getWorkspaceState().permissions);
        })();
    }, [sessionVersion, refresh, reconcileOpenView]);

    // Le droit tombe, ce qu'il ouvrait se referme. Sans dépendance sur
    // `editing`/`settingsOpen` : c'est la perte du droit qu'on surveille, pas
    // l'ouverture.
    useEffect(() => {
        if (!canLayout) setEditing(false);
    }, [canLayout]);
    useEffect(() => {
        if (!canAppearance) setSettingsOpen(false);
    }, [canAppearance]);

    // Cross-view navigation: a view can ask to open another one (e.g. the
    // profile's link to the security page).
    useEffect(() => onOpenViewRequest((viewId) => handleExpand(viewId)), [handleExpand]);

    // Racine de l'arborescence de présence. Les niveaux plus profonds sont
    // déclarés par les features elles-mêmes, chacune ne connaissant que le sien.
    const liveViewTarget = useLiveSegment('view', expandedWidget);

    // Rejoindre quelqu'un. Tout passe par `handleExpand`, la garde unique de la
    // navigation : la téléportation ne peut pas ouvrir ce qu'un rôle interdit.
    // Une cible nulle veut dire « il est à l'accueil » — on referme.
    useEffect(() => {
        if (!liveViewTarget) return;
        if (liveViewTarget.value === null) handleClose();
        else handleExpand(liveViewTarget.value);
    }, [liveViewTarget, handleExpand, handleClose]);

    /**
     * Close the popup on the shown feature's own request, and mark the view for a
     * fresh remount (a cancelled unlock prompt must re-appear, not the cached
     * empty view). Stable identity: features read current state via refs.
     */
    const requestCloseFeature = useCallback((featureId: string) => {
        if (expandedWidgetRef.current !== featureId) return;
        forceUnmountRef.current.add(featureId);
        closingFeatureRef.current = featureId;
        setExpandedWidget(null);
    }, []);

    // Device views: one per device tile whose device still exists. The panel is
    // the module's; without the module there is none.
    const deviceViews = useMemo<ViewConfig[]>(() => {
        const out: ViewConfig[] = [];
        const DevicePanel = devicesModule?.DevicePanel;
        if (!DevicePanel) return out;
        const seen = new Set<string>();
        for (const id of placedDeviceIds(layout)) {
            if (seen.has(id)) continue;
            const device = devices.find((d) => d.id === id);
            if (!device) continue;
            seen.add(id);
            out.push({
                id: deviceViewId(device.id),
                title: device.name,
                icon: 'server',
                cacheDurationMinutes: 5,
                hasCard: true,
                renderDevice: () => <DevicePanel deviceId={device.id} />
            });
        }
        return out;
    }, [layout, devices, devicesModule]);

    const views = useMemo(() => [...staticViews(), ...deviceViews], [deviceViews]);
    const viewsRef = useRef(views);
    viewsRef.current = views;

    /**
     * Le dossier déployé, relu dans la disposition à chaque rendu : les
     * modifications d'un autre membre se voient, et un dossier vidé ou supprimé
     * referme l'écran.
     */
    const folderView = useMemo(
        () => (openFolder ? (findFolder(layout, openFolder.id)?.folder ?? null) : null),
        [openFolder, layout]
    );
    const folderEntries = useMemo(() => (folderView ? folderFeatures(folderView.items) : []), [folderView]);
    useEffect(() => {
        if (openFolder !== null && folderEntries.length === 0) setOpenFolder(null);
    }, [openFolder, folderEntries.length]);

    const closeFolder = useCallback(() => setOpenFolder(null), []);

    const handleExitComplete = useCallback(() => {
        const featureId = closingFeatureRef.current;
        closingFeatureRef.current = null;
        if (!featureId) return;

        const config = viewsRef.current.find((v) => v.id === featureId);
        const duration = config?.cacheDurationMinutes;
        const forceUnmount = forceUnmountRef.current.delete(featureId);

        if (forceUnmount || duration === 0 || !config) {
            unmountFeature(featureId);
        } else if (duration !== undefined) {
            clearTimeout(ttlTimers.current.get(featureId));
            const timer = setTimeout(() => unmountFeature(featureId), duration * 60 * 1000);
            ttlTimers.current.set(featureId, timer);
        }

        const pending = pendingExpandRef.current;
        if (pending) {
            pendingExpandRef.current = null;
            doExpand(pending.widgetId, pending.forceReset);
        }
    }, [unmountFeature, doExpand]);

    /**
     * Drop device tiles whose device no longer exists. Seulement une fois la
     * liste chargée ET sans erreur : une liste vide par échec effacerait toutes
     * les tuiles d'appareils de la disposition partagée. Sans `workspace.layout`,
     * pas d'élagage ; sans le module, la liste est vide par construction.
     */
    useEffect(() => {
        if (!devicesModule || devicesLoading || devicesError !== null || !canLayout) return;
        pruneMissingDevices(new Set(devices.map((d) => d.id)));
    }, [devices, devicesLoading, devicesError, canLayout, devicesModule]);

    /**
     * La liste d'appareils est le contenu principal : une fois répondu (chargée
     * ou en erreur), l'accueil est prêt pour le fondu de l'écran de connexion.
     * Sans le module, rien à attendre.
     */
    useEffect(() => {
        if (!devicesModule || !devicesLoading || devicesError !== null) markHomeReady();
    }, [devicesLoading, devicesError, devicesModule]);

    // Warm preload feature views that are on the grid, at idle, once the home is
    // ready: the first open is instant without stealing the opening moment.
    const preloadedRef = useRef(false);
    useEffect(() => {
        const mountPreloads = () => {
            if (preloadedRef.current || ws.state !== 'open') return;
            preloadedRef.current = true;
            // Seules les cartes posées sur la grille se préchauffent : une vue
            // qu'aucune tuile n'ouvre n'a pas à envoyer ses requêtes.
            const gridFeatureIds = new Set<string>(placedFeatureIds(getHomeLayout()));
            for (const config of viewsRef.current) {
                const duration = config.cacheDurationMinutes;
                if (!config.preload || duration === 0 || !gridFeatureIds.has(config.id)) continue;
                setMountedFeatures((prev) => new Set(prev).add(config.id));
                if (duration !== undefined) {
                    const timer = setTimeout(() => unmountFeature(config.id), duration * 60 * 1000);
                    ttlTimers.current.set(config.id, timer);
                }
            }
        };

        const ric = window.requestIdleCallback;
        const scheduleIdle = ric
            ? () => ric(() => mountPreloads(), { timeout: 2000 })
            : () => window.setTimeout(mountPreloads, 200);

        let offReady: (() => void) | undefined;
        let fallback: ReturnType<typeof setTimeout> | undefined;
        const arm = () => {
            offReady?.();
            offReady = undefined;
            clearTimeout(fallback);
            scheduleIdle();
        };

        if (isHomeReady()) {
            arm();
        } else {
            offReady = onHomeReady(arm);
            fallback = setTimeout(arm, 3000);
        }

        return () => {
            offReady?.();
            clearTimeout(fallback);
        };
    }, [unmountFeature]);

    // Clean up all timers on unmount.
    useEffect(() => {
        return () => {
            ttlTimers.current.forEach((t) => clearTimeout(t));
        };
    }, []);

    const expandedConfig = expandedWidget ? (views.find((v) => v.id === expandedWidget) ?? null) : null;

    // Keep the last opened config around so the panel still has content (and the
    // correct layoutId) during its close animation.
    const [lastConfig, setLastConfig] = useState<ViewConfig | null>(null);
    useEffect(() => {
        if (expandedConfig) setLastConfig(expandedConfig);
    }, [expandedConfig]);

    const popupConfig = expandedConfig ?? lastConfig;

    if (!user || !currentWorkspace) return null;

    const heading = homeHeading(currentWorkspace, user.username);

    /**
     * Bascule d'espace : publier l'id (les commandes suivantes le portent), puis
     * recharger l'état de la cible. La vue ouverte survit si la cible la propose
     * aussi, mais son contenu repart de zéro (l'époque entre dans la clé de
     * remontage). La composition de la cible n'est connue qu'après
     * `workspace.activate` : d'ici là le contenu est démonté, sinon il
     * interrogerait le nouvel espace avec les droits de l'ancien.
     */
    const handleSelectWorkspace = (workspaceId: number) => {
        // Re-choisir l'espace courant n'est pas une bascule.
        if (workspaceId === getWorkspaceState().activeId) return;
        const openView = expandedWidget;
        if (openView) unmountFeature(openView);
        // Ce qui appartient à l'espace quitté sort avec lui : un dossier déployé
        // montrerait ses anciennes cartes, et l'organiseur écrirait la vieille
        // grille dans le nouvel espace.
        setOpenFolder(null);
        setEditing(false);
        setSwitching(true);
        // Vider la liste d'appareils AVANT de basculer : sinon l'effet d'élagage
        // tourne contre ceux de l'espace précédent une fois la nouvelle
        // disposition en place, et supprime définitivement ses tuiles.
        devicesModule?.resetDevices();
        // L'id est publié d'abord : `workspace.activate` part alors avec la
        // bonne enveloppe, et le dispatcheur en vérifie l'appartenance.
        setActiveWorkspace(workspaceId);
        void (async () => {
            try {
                const res = await ws.send('workspace.activate', {});
                setPermissions(res.permissions);
                syncThemeFromServer(res.theme);
                syncHomeLayoutFromServer(res.homeLayout);
                // `resetDevices` a vidé la liste et rien ne la re-sollicite tant
                // que rien ne change : les tuiles resteraient vides.
                devicesModule?.refreshDevices();

                if (!openView) return;
                if (survivesWorkspaceSwitch(openView, getHomeLayout(), res.permissions, viewsRef.current)) {
                    remountFeature(openView);
                } else handleClose();
            } catch {
                // Accès perdu entre-temps : recharger la session remet le client
                // sur un espace valide, avant de lever l'écran de bascule.
                if (openView) handleClose();
                await refresh().catch(() => {});
            } finally {
                setSwitching(false);
            }
        })();
    };

    // Bascule demandée depuis ailleurs (téléportation), enregistrée ici pour
    // emprunter la séquence complète ci-dessus.
    useEffect(() => onSelectWorkspaceRequest(handleSelectWorkspace));

    const handleCreateWorkspace = () => {
        void (async () => {
            const name = await OpenPopup<string>(CREATE_WORKSPACE_POPUP);
            if (!name) return;
            const res = await ws.send('workspace.add', { name });
            upsertWorkspace(res.workspace);
            handleSelectWorkspace(res.workspace.id);
        })();
    };

    /** `autoAdd` pose une première section et ouvre le marché dessus — utilisé
     *  par l'invite d'accueil vide, où organiser n'est qu'un moyen d'y arriver. */
    const startOrganizing = (autoAdd = false) => {
        if (expandedWidget) handleClose();
        // Un dossier déployé n'a pas de place en mode organisation : la grille
        // qu'on va manipuler est justement celle qu'il recouvre.
        setOpenFolder(null);
        setAutoAddSection(autoAdd);
        setEditing(true);
    };

    /**
     * Rendu d'une section hors organisation. Une seule boucle pour tous les
     * genres de tuiles ; `null` pour une section vide, qui ne laisse donc pas de
     * trou.
     */
    const renderSection = (section: HomeSection): ReactNode => {
        const tiles: ReactNode[] = [];
        for (const tile of section.items) {
            if (isHomeFolder(tile)) {
                const v = featureTileVisual(tile);
                if (!v) continue;
                // Un dossier rempli dont plus rien n'est connu (modules retirés)
                // s'efface ; un dossier vraiment vide reste, inerte : on vient
                // de le créer.
                const visible = folderFeatures(tile.items);
                if (visible.length === 0 && tile.items.length > 0) continue;
                const folderId = tile.id;
                tiles.push(
                    <Widget
                        key={folderId}
                        widgetId={v.widgetId}
                        title={v.title}
                        icon={v.icon}
                        interactive={visible.length > 0}
                        // La tuile reste visible pendant le déploiement : elle
                        // part avec le fond qui recule et dit d'où viennent les cartes.
                        onExpand={(e) => {
                            setOpenFolder({
                                id: folderId,
                                source: e.currentTarget.getBoundingClientRect(),
                                offset: greetingRef.current?.offsetHeight ?? 0
                            });
                        }}
                    >
                        {v.body}
                    </Widget>
                );
                continue;
            }

            if (isShortcutTile(tile)) {
                const v = shortcutTileVisual(tile);
                tiles.push(
                    <Widget key={tile.id} widgetId={v.widgetId} compact={v.compact} href={v.href}>
                        {v.body}
                    </Widget>
                );
                continue;
            }

            if (isFeatureTile(tile)) {
                const v = featureTileVisual(tile);
                if (!v) continue;
                // La tuile reste posée, en retrait : la retirer déplacerait les
                // voisines. Pendant une bascule, les droits vides ne sont ceux
                // de personne : pas de grisage.
                const locked = !switching && !allowedToOpen(v.widgetId);
                tiles.push(
                    <Widget
                        key={tile}
                        widgetId={v.widgetId}
                        title={v.title}
                        icon={v.icon}
                        className={locked ? styles.lockedTile : undefined}
                        // Hidden while its popup is open so frequent re-renders can't
                        // make the source card flash behind the morphed popup.
                        style={expandedWidget === v.widgetId ? { opacity: 0 } : undefined}
                        onExpand={(e) => handleExpand(v.widgetId, isForceReload(e))}
                    >
                        {/* Le contenu vivant est remplacé, pas seulement grisé : il
                            interrogerait un serveur qui refuse, et afficherait des
                            zéros qui se lisent comme des données réelles. */}
                        {locked ? <span className={styles.lockedBody}>Accès restreint</span> : v.body}
                    </Widget>
                );
                continue;
            }

            // Un appareil. Escamoté quand il n'existe plus (l'effet d'élagage
            // s'en charge), plutôt que de poser une carte creuse.
            const device = devices.find((d) => d.id === tile);
            if (!device) continue;
            const v = deviceTileVisual(device);
            if (!v) continue;
            tiles.push(
                <Widget
                    key={tile}
                    widgetId={v.widgetId}
                    title={v.title}
                    icon={v.icon}
                    compact={v.compact}
                    // Hidden while its popup is open (the device tile re-renders
                    // on usage/device polls, which would otherwise flash it back
                    // behind the morphed popup).
                    style={expandedWidget === v.widgetId ? { opacity: 0 } : undefined}
                    onExpand={(e) => handleExpand(v.widgetId, isForceReload(e))}
                >
                    {v.body}
                </Widget>
            );
        }
        if (tiles.length === 0) return null;
        return (
            <CollapsibleSection key={section.id} section={section}>
                <WidgetGrid>{tiles}</WidgetGrid>
            </CollapsibleSection>
        );
    };

    return (
        <LiveProvider surface={popupBodyEl ?? contentEl}>
            <div className={styles.dashboard}>
                <Wallpaper />

                <TopNavbar
                    aboutBody={<AboutContent />}
                    // Un dossier déployé prend la barre comme une vue ; une vue
                    // ouverte par-dessus passe devant, et son retour ramène au
                    // dossier.
                    viewTitle={expandedConfig?.title ?? (folderView ? folderTitle(folderView.title) : undefined)}
                    onBack={expandedWidget ? handleClose : folderView ? closeFolder : undefined}
                    onOpenProfile={(e) => handleExpand('profile', isForceReload(e))}
                    onOpenSecurity={(e) => handleExpand('security', isForceReload(e))}
                    // Le segment « Flotte » du module n'existe que dans l'espace
                    // personnel : ailleurs, l'entrée n'offre rien de plus que la tuile.
                    onOpenDevices={
                        user.role === 'admin' && devicesModule && currentWorkspace.kind === 'personal'
                            ? (e) => handleExpand('devices', isForceReload(e))
                            : undefined
                    }
                    onOpenLogs={user.role === 'admin' ? (e) => handleExpand('logs', isForceReload(e)) : undefined}
                    onOpenUsers={user.role === 'admin' ? (e) => handleExpand('users', isForceReload(e)) : undefined}
                    onOpenSettings={canAppearance ? () => setSettingsOpen(true) : undefined}
                    onOrganize={canLayout ? () => startOrganizing() : undefined}
                    organizing={editing}
                    onDoneOrganizing={() => setEditing(false)}
                    onManageWorkspace={(e) => handleExpand('workspace', isForceReload(e))}
                    onSelectWorkspace={handleSelectWorkspace}
                    onCreateWorkspace={handleCreateWorkspace}
                />

                {/* The grid stays mounted under the popup so the shared-element morph
                back into a card is smooth. Un dossier déployé le fait reculer
                (voir `.recessed`). */}
                <motion.main
                    className={`${styles.main} ${folderView ? styles.recessed : ''}`}
                    /*
                     * C'est ici que l'accueil défile : sans `layoutScroll`, framer
                     * ne retranche pas le défilement des mesures de tuiles, et
                     * toute remesure après un déroulement les envoie se
                     * « replacer » à des centaines de pixels.
                     */
                    layoutScroll
                    /*
                     * Retrait animé par framer, pas en CSS : framer ne compense que
                     * les transformations qu'il a écrites, un `scale()` CSS sur
                     * l'ancêtre décalerait chaque tuile.
                     */
                    animate={{ scale: folderView && !reducedMotion ? 0.965 : 1 }}
                    transition={{ duration: 0.4, ease: [0.25, 0.1, 0.25, 1] }}
                >
                    <div className={styles.content} ref={setContentEl}>
                        <header className={styles.greeting} ref={greetingRef}>
                            <h1 className={styles.greetingText}>{heading.title}</h1>
                            <p className={styles.dateText}>{heading.subtitle}</p>
                        </header>

                        {editing ? (
                            <EditableHome autoOpenAdd={autoAddSection} />
                        ) : layout.sections.length > 0 ? (
                            // Pendant une bascule, ce sont encore les sections de
                            // l'espace quitté, à dessein : les tuiles communes
                            // glissent vers leur nouvelle position (voir `switching`).
                            <div className={styles.sections}>{layout.sections.map(renderSection)}</div>
                        ) : switching ? (
                            // Bascule en cours et rien à garder : un battement, plutôt
                            // que l'invite « accueil vide » sous le nom du nouveau.
                            <div className={styles.switching} role='status' aria-label='Chargement de l’espace'>
                                <span className={`icon icon-spinner ${styles.switchingSpinner}`} aria-hidden='true' />
                            </div>
                        ) : // A fresh home has no section: point the way in. Sans le
                        // droit de composer, dire seulement pourquoi c'est vide.
                        canLayout ? (
                            <button type='button' className={styles.emptyHome} onClick={() => startOrganizing(true)}>
                                <span className={`icon icon-plus ${styles.emptyHomeIcon}`} />
                                <span className={styles.emptyHomeTitle}>Votre accueil est vide</span>
                                <span className={styles.emptyHomeHint}>
                                    Composez une section : appareils, fonctionnalités et raccourcis y cohabitent.
                                </span>
                            </button>
                        ) : (
                            <div className={styles.emptyHome}>
                                <span className={`icon icon-plus ${styles.emptyHomeIcon}`} />
                                <span className={styles.emptyHomeTitle}>L’accueil de cet espace est vide</span>
                                <span className={styles.emptyHomeHint}>
                                    Votre rôle ne permet pas d’en modifier la disposition.
                                </span>
                            </div>
                        )}
                    </div>
                </motion.main>

                {/* Posé avant la popup : à z-index égal, l'ordre de l'arbre décide,
                    et une fonctionnalité ouverte depuis une carte doit voiler le
                    dossier. */}
                <FolderOverlay
                    folder={folderView}
                    entries={folderEntries}
                    source={openFolder?.source ?? null}
                    topOffset={openFolder?.offset ?? 0}
                    expandedWidget={expandedWidget}
                    isLocked={(id) => !allowedToOpen(id)}
                    onOpenFeature={(id, e) => handleExpand(id, isForceReload(e))}
                    onClose={closeFolder}
                />

                {/* The animated popup shell. Feature content is portaled into its body
                by the keep-alive layer below, so closing never unmounts the view. */}
                {popupConfig && (
                    <WidgetPopup
                        key={popupConfig.hasCard ? popupConfig.id : 'page'}
                        // Le morphe n'a de partenaire que dans l'espace où la vue a
                        // été ouverte ; après une bascule, la popup se referme par
                        // un simple fondu.
                        layoutId={
                            popupConfig.hasCard && morphEpochRef.current === workspaceEpoch
                                ? `${morphEpochRef.current}:${popupConfig.id}`
                                : undefined
                        }
                        open={!!expandedWidget}
                        onClose={handleClose}
                        bodyRef={setPopupBodyEl}
                        onExitComplete={handleExitComplete}
                        holdSecrecy={popupConfig.holdSecrecy}
                    />
                )}

                {/* Keep-alive layer: every cached view stays mounted here and is
                portaled into the open popup body when active, or parked hidden
                otherwise — preserving its state across close/reopen. */}
                {[...mountedFeatures].map((id) => {
                    const config = views.find((v) => v.id === id);
                    if (!config) return null;

                    const featureProps: FeatureProps = {
                        user,
                        workspace: currentWorkspace,
                        feature: { id: config.id, name: config.title, icon: config.icon, component: () => null },
                        setWorkspace: upsertWorkspace,
                        setFeature: () => {},
                        closeFeature: () => requestCloseFeature(id)
                    };

                    const gen = featureGen.get(id) ?? 0;
                    const target = popupConfig?.id === id ? popupBodyEl : null;
                    const body = config.FullComponent ? (
                        <config.FullComponent {...featureProps} />
                    ) : (
                        (config.renderDevice?.() ?? null)
                    );

                    return (
                        <FeatureKeepAlive key={`${workspaceEpoch}-${id}-${gen}`} target={target}>
                            {body}
                        </FeatureKeepAlive>
                    );
                })}

                <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} />

                {/* Création d'espace, pilotée depuis le menu de la topbar. */}
                <CreateWorkspacePopup />

                {/* Shared info dialog, registered once here so any feature's "i" button
                opens it via openInfo(). */}
                <InfoPopup />

                {/* Curseurs des pairs situés exactement là où nous sommes. */}
                <LiveCursors />
            </div>
        </LiveProvider>
    );
}

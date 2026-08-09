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
import { isHomeReady, onHomeReady } from '@/stores/homeReady';
import { refreshDevices, resetDevices, useDevices } from '@/stores/devices';
import { setPermissions, useWorkspacePermissions } from '@/stores/workspace';
import { syncThemeFromServer } from '@/stores/theme';
import { syncHomeLayoutFromServer } from '@/stores/homeLayout';
import {
    useHomeLayout,
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
import PopupUnlock from './popup-unlock';
import CreateWorkspacePopup, { CREATE_WORKSPACE_POPUP } from './popup-create-workspace';

// Structural feature views (no grid card)
import Clients from '@/Features/Clients';
import Security from '@/Features/Security';
import FeatureProfile from '@/Features/Profile';
import FeatureLogs from '@/Features/Logs';
import FeatureWorkspace from '@/Features/Workspace';
import FeatureUsers from '@/Features/Users';
// Device popup content (Monitoring panel without the sidebar)
import MonitoringPanel from '@/Features/Monitoring/MonitoringPanel';

import { FEATURE_CATALOG } from './catalog';
import { isForceReload } from './forceReload';
import {
    DEVICE_VIEW_PREFIX,
    deviceTileVisual,
    deviceViewId,
    featureTileVisual,
    shortcutTileVisual
} from './tiles/tileVisual';
import { EditableHome } from './organize/EditableHome';

import type { HomeFeatureId, HomeLayout, HomeSection, WorkspaceFeatureId, WorkspacePermissions } from 'deveye-types';
import { WORKSPACE_FEATURE_IDS } from 'deveye-types';
import type { FeatureProps } from '@/Features/types';
import styles from './Dashboard.module.css';
import type { Workspace } from 'deveye-types';

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
    /** Custom render for a device view, bound to its deviceId. */
    renderDevice?: () => ReactNode;
}

// Static views: the built-in feature catalog (grid cards) + structural pages
// (reached from the navbar menu, no card).
const STATIC_VIEWS: ViewConfig[] = [
    ...FEATURE_CATALOG.map((f) => ({
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
        id: 'clients',
        title: 'Appareils',
        icon: 'server',
        cacheDurationMinutes: 5,
        hasCard: false,
        FullComponent: Clients
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
 * La feature dont une vue dépend, ou `null` si elle n'en dépend d'aucune.
 *
 * Les vues de compte et d'administration (profil, sécurité, logs, utilisateurs,
 * gestion de l'espace) n'en dépendent pas : elles ont leurs propres gardes, et
 * un rôle d'espace n'a pas à décider si l'on peut voir son propre profil.
 */
function featureBehind(viewId: string): WorkspaceFeatureId | null {
    if (WORKSPACE_FEATURE_IDS.includes(viewId as WorkspaceFeatureId)) return viewId as WorkspaceFeatureId;
    // La page Appareils et chaque vue d'appareil relèvent du même droit.
    if (viewId === 'clients' || viewId.startsWith(DEVICE_VIEW_PREFIX)) return 'devices';
    return null;
}

/**
 * Cette vue a-t-elle encore un sens dans l'espace où l'on arrive ?
 *
 * Trois conditions, et la troisième est la règle demandée : le rôle doit ouvrir
 * la feature, et la tuile doit **figurer sur l'accueil de la cible**. Une feature
 * qu'on n'y a pas posée n'a pas à s'ouvrir toute seule parce qu'on venait
 * d'ailleurs.
 *
 * Les vues **sans tuile** — profil, sécurité, journaux, utilisateurs, gestion de
 * l'espace — échappent à la règle : elles ne sont pas composées dans l'accueil,
 * donc l'y chercher n'aurait aucun sens, et leur contenu ne dépend pas de
 * l'espace (ou le suit, pour la gestion de l'espace). Les refermer serait gratuit.
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
        // Un appareil appartient à un espace : le même identifiant n'existe pas
        // ailleurs, cette vue ne survit donc jamais — et c'est bien ainsi.
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
 * En-tête de l'accueil.
 *
 * L'espace personnel salue son propriétaire — il est à lui seul, son nom serait
 * une redite. Un espace partagé garde son nom en titre : une fois qu'on jongle
 * entre plusieurs, savoir d'un coup d'œil où l'on se trouve prime sur tout le
 * reste. La salutation ne disparaît pas pour autant, elle passe en sous-titre :
 * l'accueil appartient au lieu, mais on continue d'y être reçu.
 */
/**
 * La courbe du repli d'une section.
 *
 * Départ franc, arrivée longue : c'est ce qui donne l'impression que la section
 * *se pose* au lieu de s'arrêter net. Un ressort aurait dépassé sa hauteur puis
 * serait revenu, ce qui sur une boîte qui se referme se lit comme un rebond
 * accidentel plutôt que comme une intention.
 */
const FOLD_EASE = [0.32, 0.72, 0, 1] as const;

/**
 * À quelle distance du bas on considère qu'on **est** en bas.
 *
 * Quelques pixels de jeu : un défilement fluide s'arrête rarement à zéro exact,
 * et exiger l'égalité stricte ferait rater le cas courant d'une page qu'on vient
 * de dérouler jusqu'au bout.
 */
const BOTTOM_SLACK = 8;

/**
 * Une section de l'accueil, repliable ou non.
 *
 * Le repli est **local et éphémère** : l'état enregistré (`section.collapsed`)
 * dit seulement comment la section *s'ouvre*, pas comment on l'a laissée. C'est
 * délibéré — replier une section pour dégager la vue une minute ne devrait pas
 * modifier la disposition partagée de l'espace, ni partir en écriture sur le
 * réseau. Recharger la page revient donc à l'état choisi dans l'organiseur.
 *
 * Sans `collapsible`, il n'y a **rien à cliquer** : un chevron sur une section
 * que personne ne veut replier est une chose de plus à ignorer. Le titre reste
 * alors un simple intitulé.
 */
function CollapsibleSection({ section, children }: { section: HomeSection; children: ReactNode }) {
    const foldable = section.collapsible === true;
    const [folded, setFolded] = useState(foldable && section.collapsed === true);
    /** Le dépliage est terminé : la boîte peut cesser de découper son contenu. */
    const [settled, setSettled] = useState(true);
    const reduced = useReducedMotion() === true;
    const groupRef = useRef<HTMLDivElement>(null);
    /** On était au bas de la page en dépliant : il faut y rester. */
    const pinBottom = useRef(false);

    // L'organiseur peut changer les deux réglages sous nos pieds : on repart de
    // l'état déclaré plutôt que de garder un repli devenu impossible.
    useEffect(() => {
        setFolded(section.collapsible === true && section.collapsed === true);
    }, [section.collapsible, section.collapsed]);

    /**
     * Déplier une section du bas de page ne doit pas laisser son contenu dessous.
     *
     * La section grandit *sous* le point où l'on regarde : ce qu'elle révèle
     * naît donc hors de l'écran, et il faudrait défiler pour le voir — alors
     * qu'on vient précisément de demander à le voir. Si l'on était déjà au bas
     * de la page, le défilement suit la croissance, image par image, et l'on
     * arrive à la fin de l'animation avec les tuiles sous les yeux.
     *
     * Seulement dans ce cas : accrocher le bas depuis le milieu de la page
     * arracherait la lecture d'un contenu qu'on n'a pas quitté.
     */
    const toggle = () => {
        const scroller = groupRef.current?.closest('main');
        pinBottom.current =
            folded && !!scroller && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < BOTTOM_SLACK;
        setFolded((v) => !v);
    };

    const keepBottom = () => {
        if (!pinBottom.current) return;
        const scroller = groupRef.current?.closest('main');
        if (scroller) scroller.scrollTop = scroller.scrollHeight;
    };

    if (!foldable) {
        return (
            <div className={styles.sectionGroup}>
                {section.title && <h2 className={styles.sectionHeading}>{section.title}</h2>}
                {children}
            </div>
        );
    }

    return (
        <div className={styles.sectionGroup} ref={groupRef}>
            {/* Le bouton **est** l'intitulé : une cible séparée du titre serait
                minuscule, et le titre resterait un texte mort à côté. Une
                section repliable sans titre reste cliquable — elle affiche
                simplement le chevron seul. */}
            <button type='button' className={styles.sectionToggle} aria-expanded={!folded} onClick={toggle}>
                <span
                    className={`icon icon-chevron-down ${folded ? styles.chevronFolded : styles.chevron}`}
                    aria-hidden='true'
                />
                <span className={styles.sectionHeading}>{section.title ?? 'Section'}</span>
            </button>

            {/*
             * Le repli se **déroule**, il ne clignote pas.
             *
             * `height: auto` est une valeur que framer sait mesurer et animer ;
             * c'est ce qui permet de garder la grille telle quelle, sans lui
             * imposer une hauteur en dur qu'il faudrait tenir à jour. L'opacité
             * va plus vite que la hauteur : le contenu s'efface pendant que la
             * boîte se referme, plutôt que de rester net jusqu'au dernier pixel.
             *
             * `overflow: hidden` **seulement pendant le mouvement** : c'est lui
             * qui découpe les tuiles au fil du repli, mais le garder ensuite
             * rognerait le petit soulèvement des cartes au survol.
             */}
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
                        onUpdate={keepBottom}
                        onAnimationComplete={() => {
                            setSettled(true);
                            keepBottom();
                            pinBottom.current = false;
                        }}
                    >
                        {children}
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
}

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
 * Majuscule initiale, et elle seule : `toLocaleDateString` rend « mercredi », or
 * le sous-titre ouvre une phrase.
 *
 * Remplace un `text-transform: capitalize` qui capitalisait chaque mot — correct
 * tant que le sous-titre n'était qu'une date, faux dès qu'il en dit plus (« 1
 * Membre », « Bonsoir Gerem »), et fautif même sur la date : en français les
 * noms de mois ne prennent pas de majuscule.
 */
function upperFirst(text: string): string {
    return text.charAt(0).toUpperCase() + text.slice(1);
}

export default function HomePage() {
    const { user, refresh } = useAuth();
    const { epoch: workspaceEpoch } = useWorkspaceState();
    const currentWorkspace = useActiveWorkspace();
    const layout = useHomeLayout();
    const { devices, loading: devicesLoading } = useDevices();
    const { canFeature } = useWorkspacePermissions();

    const [expandedWidget, setExpandedWidget] = useState<string | null>(null);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [editing, setEditing] = useState(false);
    const [autoAddSection, setAutoAddSection] = useState(false);

    // Set of view ids whose components are currently mounted (cached).
    const [mountedFeatures, setMountedFeatures] = useState<Set<string>>(new Set());
    // Per-view "generation" counter — bumping it remounts the view (Ctrl+click reset).
    const [featureGen, setFeatureGen] = useState<Map<string, number>>(new Map());
    // The open popup's body element — feature content is portaled into it.
    const [popupBodyEl, setPopupBodyEl] = useState<HTMLDivElement | null>(null);
    // Repère des curseurs : le corps de la popup quand une feature est ouverte,
    // la colonne de contenu de l'accueil sinon. Jamais un nœud appartenant à une
    // feature — `FeatureKeepAlive` les déplace.
    //
    // C'est bien `content` — bornée à 1280 px et centrée — et non `main`, qui
    // occupe toute la largeur : le repère doit être la boîte que le contenu
    // remplit vraiment, sinon deux écrans de tailles différentes ne placent pas
    // le curseur au même endroit de la même tuile. La popup, elle, est déjà
    // bornée à 1240 px, donc son propre corps fait un repère juste.
    //
    // Rien n'y est pour autant rogné : le repère sert à convertir, le cadre de
    // la fenêtre seul décide de ce qui s'affiche (voir `LiveCursors`).
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
     * L'époque d'espace **au moment où la popup s'est ouverte**, qui identifie sa
     * paire de morphe avec la tuile d'origine.
     *
     * Sans elle, garder une vue ouverte en changeant d'espace la faisait
     * disparaître : la disposition remplacée démonte puis remonte toutes les
     * tuiles, la nouvelle tuile reparaît avec le même `layoutId` que la popup
     * ouverte, et framer-motion — qui n'admet qu'un élément par identité —
     * projette alors la popup **dans** cette tuile. Mesuré : la popup passait de
     * 1143×743 à 290×206, la taille d'une carte, sans jamais se refermer côté
     * React (d'où le fond assombri qui restait).
     *
     * Figer l'époque suffit : la tuile d'après-bascule porte une autre identité,
     * la paire ne peut plus se former, et la popup reste où elle est.
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
     * Remonte une vue à neuf sans toucher à son ouverture : le contenu repart de
     * zéro, la popup ne bouge pas. C'est ce qui permet à une feature de traverser
     * une bascule d'espace en restant à l'écran.
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

    /** Le rôle courant ouvre-t-il cette vue ? La lecture suffit à l'ouvrir. */
    const allowedToOpen = useCallback(
        (viewId: string): boolean => {
            const feature = featureBehind(viewId);
            return feature === null || canFeature(feature);
        },
        [canFeature]
    );

    const viewTitleOf = useCallback(
        (viewId: string): string =>
            STATIC_VIEWS.find((v) => v.id === viewId)?.title ??
            (viewId.startsWith(DEVICE_VIEW_PREFIX) ? 'Appareils' : viewId),
        []
    );

    const handleExpand = useCallback(
        (widgetId: string, forceReset = false) => {
            // Une seule garde, ici : la tuile de l'accueil, la navigation entre
            // features et le menu de la topbar y aboutissent tous. La poser dans
            // le rendu des tuiles n'aurait fermé qu'une porte sur trois.
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
        [expandedWidget, doExpand, allowedToOpen, viewTitleOf]
    );

    const handleClose = useCallback(() => {
        closingFeatureRef.current = expandedWidget;
        setExpandedWidget(null);
    }, [expandedWidget]);

    // Mirror of expandedWidget for stable callbacks that must read it at call time.
    const expandedWidgetRef = useRef(expandedWidget);
    expandedWidgetRef.current = expandedWidget;

    // Cross-feature navigation: a feature can ask to open another view (e.g.
    // Monitoring's "Gérer les appareils" → the Appareils page).
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
     * Close the popup on a feature's own request. Guarded so only the feature
     * currently shown can dismiss it, and marks the view for a fresh remount on
     * reopen (so e.g. a cancelled unlock prompt re-appears instead of leaving the
     * cached, empty view behind). Stable identity: features read current state
     * via refs, so this never re-triggers their load effects.
     */
    const requestCloseFeature = useCallback((featureId: string) => {
        if (expandedWidgetRef.current !== featureId) return;
        forceUnmountRef.current.add(featureId);
        closingFeatureRef.current = featureId;
        setExpandedWidget(null);
    }, []);

    // Device views: one per device tile whose device still exists. Built here
    // because they depend on the live device list.
    const deviceViews = useMemo<ViewConfig[]>(() => {
        const out: ViewConfig[] = [];
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
                renderDevice: () => <MonitoringPanel deviceId={device.id} />
            });
        }
        return out;
    }, [layout, devices]);

    const views = useMemo(() => [...STATIC_VIEWS, ...deviceViews], [deviceViews]);
    const viewsRef = useRef(views);
    viewsRef.current = views;

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

    // Drop device tiles whose device no longer exists (deleted). Only once devices
    // have actually loaded, so a transient empty list can't wipe the layout.
    useEffect(() => {
        if (devicesLoading) return;
        pruneMissingDevices(new Set(devices.map((d) => d.id)));
    }, [devices, devicesLoading]);

    // Eagerly warm preload feature views that are on the grid, at idle, once the
    // home is ready — so the first open is instant without stealing the opening
    // moment. (See the original rationale; unchanged beyond gating on the layout.)
    const preloadedRef = useRef(false);
    useEffect(() => {
        const mountPreloads = () => {
            if (preloadedRef.current || ws.state !== 'open') return;
            preloadedRef.current = true;
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
     * Bascule d'espace : on publie le nouvel id (les commandes suivantes le
     * portent aussitôt), puis on recharge la session — ce qui rapatrie le thème
     * et la disposition de la cible et corrige l'id si l'accès n'existe plus.
     * L'incrément d'époque du store remonte au passage toutes les features.
     *
     * **La vue ouverte survit à la bascule quand la cible la propose aussi.**
     * Changer d'espace en gardant Mail sous les yeux, pour y retrouver les mêmes
     * boîtes ailleurs, est le geste courant ; refermer à chaque fois obligeait à
     * rouvrir. Son contenu, lui, repart de zéro — l'époque du store d'espaces
     * entre dans la clé de remontage, donc rien de l'espace précédent ne traîne.
     *
     * La composition de l'accueil d'un autre espace n'est **pas** connue d'avance
     * (la session n'embarque que celle de l'espace actif) : la décision ne peut
     * donc tomber qu'après `workspace.activate`. D'ici là le contenu est démonté
     * plutôt que laissé vivant — il interrogerait le nouvel espace avec les
     * droits de l'ancien, et l'on verrait passer une erreur avant même de savoir
     * si la vue reste.
     */
    const handleSelectWorkspace = (workspaceId: number) => {
        const openView = expandedWidget;
        if (openView) unmountFeature(openView);
        // Vider la liste d'appareils AVANT de basculer : sinon l'effet d'élagage
        // ci-dessus tourne encore contre ceux de l'espace précédent alors que la
        // nouvelle disposition est déjà en place, et supprime définitivement ses
        // tuiles d'appareils.
        resetDevices();
        // L'id est publié d'abord : `workspace.activate` part alors avec la
        // bonne enveloppe, et le dispatcheur en vérifie l'appartenance.
        setActiveWorkspace(workspaceId);
        void (async () => {
            try {
                const res = await ws.send('workspace.activate', {});
                setPermissions(res.permissions);
                syncThemeFromServer(res.theme);
                syncHomeLayoutFromServer(res.homeLayout);
                // Relancer tout de suite : `resetDevices` a vidé la liste, et
                // plus rien ne la re-sollicite tant que rien ne change — les
                // tuiles d'appareils resteraient vides indéfiniment.
                void refreshDevices();

                if (!openView) return;
                // `doExpand` avec remontage forcé : la vue reparaît vierge, sur
                // les données de l'espace d'arrivée.
                if (survivesWorkspaceSwitch(openView, getHomeLayout(), res.permissions, viewsRef.current)) {
                    remountFeature(openView);
                } else handleClose();
            } catch {
                // Accès perdu entre-temps : recharger la session remet le client
                // sur un espace valide.
                if (openView) handleClose();
                void refresh();
            }
        })();
    };

    // Bascule d'espace demandée depuis ailleurs — aujourd'hui la téléportation,
    // qui peut avoir à changer d'espace avant d'ouvrir une vue. Enregistré ici
    // plutôt qu'appelé directement : c'est la seule façon d'emprunter la séquence
    // complète ci-dessus, dont la réécrire une moitié serait le vrai risque.
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

    /** `autoAdd` chains straight into the "add a section" dialog — used by the
     *  empty-home prompt, where organizing is only a means to that end. */
    const startOrganizing = (autoAdd = false) => {
        if (expandedWidget) handleClose();
        setAutoAddSection(autoAdd);
        setEditing(true);
    };

    /** Normal-mode rendering of one section as its own grid block. Returns null
     *  for an empty section, so it never leaves a hole. Untitled sections read as
     *  lightly-spaced groups; a title renders as a discreet heading above the
     *  grid. Missing devices are skipped (pruned by the effect above). */
    const renderSection = (section: HomeSection): ReactNode => {
        const tiles: ReactNode[] = [];
        if (section.kind === 'feature') {
            for (const fid of section.items) {
                const v = featureTileVisual(fid);
                if (!v) continue;
                // La tuile reste posée, en retrait : la retirer déplacerait les
                // voisines et laisserait croire à une disposition abîmée. Elle dit
                // qu'il y a là quelque chose auquel on n'a pas droit, ce qui est
                // vrai et se demande.
                const locked = !allowedToOpen(v.widgetId);
                tiles.push(
                    <Widget
                        key={fid}
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
            }
        } else if (section.kind === 'device') {
            for (const id of section.items) {
                const device = devices.find((d) => d.id === id);
                if (!device) continue;
                const v = deviceTileVisual(device);
                tiles.push(
                    <Widget
                        key={id}
                        widgetId={v.widgetId}
                        title={v.title}
                        icon={v.icon}
                        compact
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
        } else {
            for (const item of section.items) {
                const v = shortcutTileVisual(item);
                tiles.push(
                    <Widget key={item.id} widgetId={v.widgetId} slim={v.slim} href={v.href}>
                        {v.body}
                    </Widget>
                );
            }
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
                    viewTitle={expandedConfig?.title}
                    onBack={expandedWidget ? handleClose : undefined}
                    onOpenProfile={(e) => handleExpand('profile', isForceReload(e))}
                    onOpenSecurity={(e) => handleExpand('security', isForceReload(e))}
                    onOpenDevices={user.role === 'admin' ? (e) => handleExpand('clients', isForceReload(e)) : undefined}
                    onOpenLogs={user.role === 'admin' ? (e) => handleExpand('logs', isForceReload(e)) : undefined}
                    onOpenUsers={user.role === 'admin' ? (e) => handleExpand('users', isForceReload(e)) : undefined}
                    onOpenSettings={() => setSettingsOpen(true)}
                    onOrganize={() => startOrganizing()}
                    organizing={editing}
                    onDoneOrganizing={() => setEditing(false)}
                    onManageWorkspace={(e) => handleExpand('workspace', isForceReload(e))}
                    onSelectWorkspace={handleSelectWorkspace}
                    onCreateWorkspace={handleCreateWorkspace}
                />

                {/* The grid stays mounted under the popup so the shared-element morph
                back into a card is smooth and never dips behind sibling cards. */}
                <main className={styles.main}>
                    <div className={styles.content} ref={setContentEl}>
                        <header className={styles.greeting}>
                            <h1 className={styles.greetingText}>{heading.title}</h1>
                            <p className={styles.dateText}>{heading.subtitle}</p>
                        </header>

                        {editing ? (
                            <EditableHome autoOpenAdd={autoAddSection} />
                        ) : layout.sections.length === 0 ? (
                            // A fresh home has no section at all: point the way in
                            // rather than showing a bare greeting.
                            <button type='button' className={styles.emptyHome} onClick={() => startOrganizing(true)}>
                                <span className={`icon icon-plus ${styles.emptyHomeIcon}`} />
                                <span className={styles.emptyHomeTitle}>Votre accueil est vide</span>
                                <span className={styles.emptyHomeHint}>
                                    Ajoutez une section d’appareils, de fonctionnalités ou de raccourcis.
                                </span>
                            </button>
                        ) : (
                            <div className={styles.sections}>{layout.sections.map(renderSection)}</div>
                        )}
                    </div>
                </main>

                {/* The animated popup shell. Feature content is portaled into its body
                by the keep-alive layer below, so closing never unmounts the view. */}
                {popupConfig && (
                    <WidgetPopup
                        key={popupConfig.hasCard ? popupConfig.id : 'page'}
                        // Le morphe n'a de partenaire que tant qu'on est dans
                        // l'espace où la vue a été ouverte. Après une bascule, la
                        // tuile porte une autre identité : la popup renonce au
                        // morphe et se referme par un simple fondu, ce qui est de
                        // toute façon plus juste — sa carte d'origine n'est plus là.
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

                {/* Password unlock dialog — registered globally so the Password feature
                can request it on demand. */}
                <PopupUnlock workspace={currentWorkspace} />

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

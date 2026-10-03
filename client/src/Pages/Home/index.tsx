import {
    useState,
    useCallback,
    useMemo,
    useEffect,
    useRef,
    type ComponentType,
    type MouseEvent,
    type ReactNode
} from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';

import { useAuth } from '@/auth/AuthProvider';
import {
    getWorkspaceState,
    readLastRemoteWorkspace,
    setActiveWorkspace,
    upsertWorkspace,
    useActiveWorkspace,
    useWorkspaceState
} from '@/stores/workspace';
import { getLocalUser, useLocalUser } from '@/stores/currentUser';
import { ws } from '@/api/ws';
import { OpenPopup } from '@/Components/Popup';
import { isHomeReady, markHomeReady, onHomeReady } from '@/stores/homeReady';
import { devicesProvider, useDevices } from '@/devicesProvider';
import { setPermissions, useWorkspacePermissions } from '@/stores/workspace';
import { useResourceVersion } from '@/stores/invalidation';
import { syncThemeFromServer } from '@/stores/theme';
import { syncHomeLayoutFromServer } from '@/stores/homeLayout';
import { useHomeLayout, findFolder, getHomeLayout, placedFeatureIds, pruneMissingDevices } from '@/stores/homeLayout';
import { onOpenViewRequest, onSelectWorkspaceRequest, requestOpenView } from '@/stores/viewRequest';
import { closeSpotlight, isSpotlightOpen, openSpotlight } from '@/stores/spotlight';
import {
    ensureRemoteReady,
    getRemoteInstances,
    logoutRemote,
    refreshRemoteSession,
    restoreRemoteSessions,
    useRemoteInstances
} from '@/stores/remoteInstances';
import { setUnlocked } from '@/stores/secrecy';
import { accountViewFeature, accountViewId, openAccountView, takeAccountViewHint } from '@/stores/accountView';
import { adminViewFeature, adminViewId } from '@/stores/adminView';
import { takeSignupPlan } from '@/stores/signupPlan';
import { accountEntries, adminEntries } from '@/sdk/registry';
import type { AccountViewProps, AdminViewProps } from '@deveye/types/sdk/client';
import { useFeedbackEnabled } from '@/stores/feedbackEnabled';
import {
    featureMaintenance,
    setMaintenanceEnvNotice,
    useHiddenFeatures,
    useMaintenance,
    useMaintenanceEnvNotice,
    useSiteMaintenance
} from '@/stores/maintenance';
import { usePriorityHold } from '@/stores/accountPlan';
import { armFrameProbe } from '@/perf/frameBudget';
import { useRootView } from '@/telemetry/useView';
import { ViewScope } from '@/telemetry/ViewScope';
import { LiveProvider } from '@/live/LiveProvider';
import { LiveCursors } from '@/live/LiveCursors';
import { CursorChatInput } from '@/live/CursorChatInput';
import { useLiveSegment } from '@/live/useLiveSegment';
import { startTeleport } from '@/stores/live';
import { TopNavbar, type SiteBanner } from '@/Components/TopNavbar';
import { QuotaPrompt } from '@/Components/QuotaPrompt';
import { WidgetGrid } from '@/Components/WidgetGrid';
import { WidgetPopup, FeatureKeepAlive } from '@/Components/WidgetPopup';
import { Wallpaper } from '@/Components/Wallpaper';
import { SettingsPanel } from '@/Components/SettingsPanel';
import { InfoPopup, openInfo } from '@/Components/InfoPopup';
import { hasDismissLayer } from '@/Components/Dialog';
import StatusPageLink from '@/Components/StatusPageLink';
import { ConfirmDialog, type ConfirmRequest } from '@/Components/ConfirmDialog';
import { RemoteLogin } from '@/Components/RemoteLogin';
import { useHint } from '@/Components/Hint';
import CreateWorkspacePopup, { CREATE_WORKSPACE_POPUP, type CreateWorkspaceChoice } from './popup-create-workspace';
import { Spotlight } from './spotlight/Spotlight';

// Structural feature views (no grid card)
import Security from '@/Features/Security';
import FeatureProfile from '@/Features/Profile';
import FeatureFeedback from '@/Features/Feedback';
import FeatureLogs from '@/Features/Logs';
import FeatureWorkspace from '@/Features/Workspace';
import FeatureUsers from '@/Features/Users';
import FeatureMaintenance from '@/Features/Maintenance';
import FeatureDebug from '@/Features/Debug';

import { catalogEntries, featureCatalog, featureCatalogEntry } from './catalog';
import { EmptyHome } from './EmptyHome';
import { OrganizeButton } from './organize/OrganizeButton';
import { isForceReload } from './forceReload';
import { deviceKey } from './tiles/tileVisual';
import { DeviceTileCard, FeatureTileCard, FolderTileCard, ShortcutTileCard } from './tiles/HomeTileCard';
import type { AdminBadge, TileLock } from './tiles/tileLock';
import { AboutContent } from './about';
import { EditableHome } from './organize/EditableHome';
import { FolderOverlay, folderTitle } from './folders';

import type {
    FeatureId,
    HomeFeatureId,
    HomeLayout,
    HomeSection,
    WorkspaceFeatureId,
    WorkspacePermissions
} from '@deveye/types';
import { isExternalFeatureId, isFeatureTile, isHomeFolder, isShortcutTile, WORKSPACE_FEATURE_IDS } from '@deveye/types';
import type { FeatureProps } from '@/Features/types';
import styles from './Dashboard.module.css';
import type { Workspace } from '@deveye/types';

/** A view openable full-screen in the popup (feature or structural page). */
interface ViewConfig {
    id: string;
    title: string;
    icon: string;
    /** Minutes the view stays mounted after its popup closes (see handleExitComplete). */
    cacheDurationMinutes?: number;
    /** Warm eagerly at idle after load (only honoured for grid features). */
    preload?: boolean;
    /** Has a grid card to morph from (feature) vs. fades in (page). */
    hasCard: boolean;
    /** Hold the encrypted DEK alive while open (see WidgetPopup's `holdSecrecy`). */
    holdSecrecy?: boolean;
    /** Static feature/page view component (typed to accept FeatureProps). */
    FullComponent: ComponentType<FeatureProps>;
}

// Static views: the feature catalog (grid cards) + structural pages (reached
// from the navbar menu, no card). LAZY, comme le catalogue : figé au premier
// rendu, jamais à l'import, sinon les modules enregistrés après coup manquent.
let STATIC_VIEWS_MEMO: ViewConfig[] | null = null;
/** La vue de compte d'un module, reçue comme une page de l'app. L'indice éventuel se lit une fois. */
function accountViewHost(featureId: string, View: ComponentType<AccountViewProps>): ComponentType<FeatureProps> {
    return function AccountViewHost({ user, closeFeature }) {
        const [hint] = useState(() => takeAccountViewHint(featureId));
        return <View close={closeFeature} isAdmin={user.role === 'admin'} hint={hint} />;
    };
}

/**
 * La page système d'un module. Le menu ne la montre qu'aux administrateurs ;
 * ce garde couvre le reste des chemins qui ouvrent une vue.
 */
function adminViewHost(View: ComponentType<AdminViewProps>): ComponentType<FeatureProps> {
    return function AdminViewHost({ user, closeFeature }) {
        return user.role === 'admin' ? <View close={closeFeature} /> : null;
    };
}

/** Les pages système du menu du compte, dans cet ordre ; leur titre et leur icône sont ceux de leur vue. */
const ADMIN_VIEW_IDS = ['logs', 'feedback', 'users', 'maintenance', 'debug'] as const;

function adminMenu(): { id: string; label: string; icon: string }[] {
    const ids = [...ADMIN_VIEW_IDS, ...adminEntries().map(({ manifest }) => adminViewId(manifest.id))];
    return ids.map((id) => {
        const view = staticViews().find((v) => v.id === id)!;
        return { id, label: view.title, icon: view.icon };
    });
}

/** Lues une fois : les modules installés ne changent pas en cours de session. */
let ACCOUNT_MENU_MEMO: { id: string; label: string; icon: string }[] | null = null;
function accountMenu(): { id: string; label: string; icon: string }[] {
    ACCOUNT_MENU_MEMO ??= accountEntries().map(({ manifest }) => ({
        id: manifest.id,
        label: manifest.accountEntry!.label,
        icon: manifest.icon
    }));
    return ACCOUNT_MENU_MEMO;
}

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
    ...accountEntries().map(({ manifest, client }) => ({
        id: accountViewId(manifest.id),
        title: manifest.accountEntry!.label,
        icon: manifest.icon,
        cacheDurationMinutes: 0,
        hasCard: false,
        FullComponent: accountViewHost(manifest.id, client.AccountView!)
    })),
    ...adminEntries().map(({ manifest, client }) => ({
        id: adminViewId(manifest.id),
        title: manifest.adminEntry!.label,
        icon: manifest.adminEntry!.icon ?? manifest.icon,
        cacheDurationMinutes: 0,
        hasCard: false,
        FullComponent: adminViewHost(client.AdminView!)
    })),
    {
        id: 'logs',
        title: 'Logs',
        icon: 'activity',
        cacheDurationMinutes: 5,
        hasCard: false,
        FullComponent: FeatureLogs
    },
    {
        id: 'feedback',
        title: 'Retours',
        icon: 'bug',
        cacheDurationMinutes: 0,
        hasCard: false,
        FullComponent: FeatureFeedback
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
        id: 'maintenance',
        title: 'Accès et maintenance',
        icon: 'wrench',
        cacheDurationMinutes: 0,
        hasCard: false,
        FullComponent: FeatureMaintenance
    },
    {
        id: 'debug',
        title: 'Tests et débogage',
        icon: 'sandbox',
        cacheDurationMinutes: 0,
        hasCard: false,
        FullComponent: FeatureDebug
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
function featureBehind(viewId: string): FeatureId | null {
    if (WORKSPACE_FEATURE_IDS.includes(viewId as WorkspaceFeatureId)) return viewId as WorkspaceFeatureId;
    // Un module externe : son id EST son identifiant de vue, comme pour une
    // native. Sans ce cas, aucune tuile de module ne se verrouillait : elle
    // montait son contenu, qui interrogeait un serveur qui refuse, et l'écran
    // affichait l'erreur d'une commande là où l'accueil dit « Accès restreint ».
    if (isExternalFeatureId(viewId)) return viewId;
    return null;
}

/** Le module derrière une vue, fonctionnalité, entrée de compte ou page système : ce que ferme sa maintenance. */
function moduleBehind(viewId: string): string | null {
    return featureBehind(viewId) ?? accountViewFeature(viewId) ?? adminViewFeature(viewId);
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

/** L'espace personnel du compte d'ICI : là où l'on rentre en quittant une instance distante. */
function homeWorkspaceId(): number {
    const me = getLocalUser();
    if (!me) throw new Error('Aucune session');
    return me.personalWorkspaceId;
}

/** L'instance distante tout juste ajoutée, dont la connexion s'ouvre au retour du rechargement. */
const PENDING_REMOTE_KEY = 'deveye.pendingRemote';

export default function HomePage() {
    const { user, refresh } = useAuth();
    /** Le retrait de l'accueil derrière un dossier déployé est un mouvement : il
     *  se coupe, le flou reste (voir `.recessed`). */
    const reducedMotion = useReducedMotion() === true;
    const { epoch: workspaceEpoch, activeInstanceId } = useWorkspaceState();
    // La page d'état suit ce serveur : les modules d'une instance distante n'y figurent pas.
    const statusFeatureOf = useCallback(
        (viewId: string): string | null => (activeInstanceId === null ? moduleBehind(viewId) : null),
        [activeInstanceId]
    );
    const currentWorkspace = useActiveWorkspace();
    const layout = useHomeLayout();
    const { devices, loading: devicesLoading, error: devicesError } = useDevices();
    // Lu au rendu, jamais à l'import : le registre est rempli par
    // l'initialiseur avant le premier rendu. `undefined` sans le module.
    const devicesModule = devicesProvider();
    const { canFeature, can } = useWorkspacePermissions();
    const feedbackEnabled = useFeedbackEnabled();
    // Deux réglages de l'espace, deux capacités. Lues en booléens (et non via
    // `can`, recréé à chaque rendu) pour servir de dépendances stables.
    const canAppearance = can('workspace.appearance');
    const canLayout = can('workspace.layout');
    // Éligible dès que l'espace se laisse organiser, bouton visible ou non : la
    // bulle de la version, qui passe après, ne vient pas s'intercaler le temps
    // d'une fonctionnalité ouverte.
    const layoutHint = useHint('homeLayoutHintDismissed', canLayout);

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
    // Per-view "generation" counter: bumping it remounts the view (Ctrl+click or Shift+click reset).
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
    const pendingExpandRef = useRef<{ widgetId: string; forceReset: boolean; morphFrom?: string } | null>(null);
    /**
     * L'époque d'espace à l'ouverture de la popup, qui identifie sa paire de
     * morphe. Sans elle, une bascule remonte les tuiles avec le même `layoutId`
     * que la popup ouverte, et framer-motion (un seul élément par identité)
     * projette la popup dans la tuile, à la taille d'une carte.
     */
    const morphEpochRef = useRef(0);
    /**
     * La tuile d'où la popup sort et où elle retourne. C'est la carte cliquée et
     * non la vue ouverte : plusieurs tuiles d'appareil mènent à la même vue
     * Appareils, et chacune doit rendre la sienne au retour.
     */
    const morphSourceRef = useRef<string | null>(null);

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

    const doExpand = useCallback((widgetId: string, forceReset: boolean, morphFrom?: string) => {
        clearTimeout(ttlTimers.current.get(widgetId));
        ttlTimers.current.delete(widgetId);
        if (closingFeatureRef.current === widgetId) closingFeatureRef.current = null;
        // Une ouverture, et elle seule, fixe l'identité de morphe : la relecture
        // d'une vue déjà ouverte passe par `remountFeature`, qui n'y touche pas.
        morphEpochRef.current = getWorkspaceState().epoch;
        morphSourceRef.current = morphFrom ?? widgetId;

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
        (viewId: string): string => staticViews().find((v) => v.id === viewId)?.title ?? viewId,
        []
    );

    // Le rôle global de l'instance de l'espace actif : c'est son serveur qui
    // laisse passer, ou non, un administrateur.
    const isAdmin = user?.role === 'admin';
    const maintenance = useMaintenance();
    const hiddenFeatures = useHiddenFeatures();
    const maintenanceLevelOf = useCallback(
        (viewId: string) => {
            const id = moduleBehind(viewId);
            return id === null ? null : featureMaintenance(maintenance, id);
        },
        [maintenance]
    );
    /** Une vue d'une feature en préversion, que ce compte ne voit pas. */
    const isHiddenView = useCallback(
        (viewId: string): boolean => {
            const id = moduleBehind(viewId);
            return id !== null && hiddenFeatures.has(id);
        },
        [hiddenFeatures]
    );
    /** La maintenance ferme-t-elle cette vue à ce compte ? L'arrêt complet la ferme à tous. */
    const maintenanceLockOf = useCallback(
        (viewId: string): TileLock | undefined => {
            const level = maintenanceLevelOf(viewId);
            if (level === 'full') return isAdmin ? 'stopped' : 'maintenance';
            return level === 'requests' && !isAdmin ? 'maintenance' : undefined;
        },
        [maintenanceLevelOf, isAdmin]
    );
    const lockOf = useCallback(
        (viewId: string): TileLock | undefined => (allowedToOpen(viewId) ? maintenanceLockOf(viewId) : 'rights'),
        [allowedToOpen, maintenanceLockOf]
    );
    // À l'administrateur, le bandeau ne parle que de cette instance-ci ; à un
    // compte que la priorité tient, de l'instance où il se trouve.
    const siteMaintenance = useSiteMaintenance();
    const envNotice = useMaintenanceEnvNotice();
    const localAdmin = useLocalUser()?.role === 'admin';
    const priorityHold = usePriorityHold();
    const siteBanner: SiteBanner | undefined = localAdmin
        ? siteMaintenance.site
            ? 'site'
            : siteMaintenance.priority
              ? 'priority'
              : envNotice
                ? 'env'
                : undefined
        : priorityHold
          ? 'held'
          : undefined;
    const dismissEnvNotice = useCallback(() => {
        setMaintenanceEnvNotice(false);
        void ws.local.send('admin.maintenanceDismissNotice', {}).catch(() => {});
    }, []);

    /** Ouverte à l'administrateur seul, en maintenance ou en préversion : il le voit sur la carte. */
    const adminBadgeOf = useCallback(
        (viewId: string): AdminBadge | undefined => {
            if (!isAdmin) return undefined;
            const level = maintenanceLevelOf(viewId);
            return level === 'requests' ? 'maintenance' : level === 'preview' ? 'preview' : undefined;
        },
        [isAdmin, maintenanceLevelOf]
    );

    /** Ouvre la vue et dit si elle s'ouvre : une bascule ou un droit manquant refuse. */
    const handleExpand = useCallback(
        (widgetId: string, forceReset = false, morphFrom?: string): boolean => {
            // Pendant une bascule, les droits affichés sont vides : ni ouvrir ni
            // refuser, le clic ne fait rien.
            if (switching) return false;
            // Garde unique : tuile, navigation inter-features et menu de la
            // topbar aboutissent tous ici.
            if (isHiddenView(widgetId)) {
                void openInfo({
                    title: 'Indisponible',
                    body: <p>Cette fonctionnalité n’est pas disponible.</p>,
                    width: 400
                });
                return false;
            }
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
                return false;
            }
            if (maintenanceLockOf(widgetId)) {
                void openInfo({
                    title: 'En maintenance',
                    body: (
                        <>
                            <p>
                                « {viewTitleOf(widgetId)} » est en maintenance pour le moment. Elle rouvrira dès que
                                possible, réessayez un peu plus tard.
                            </p>
                            <StatusPageLink featureId={statusFeatureOf(widgetId)}>Suivre son état</StatusPageLink>
                        </>
                    ),
                    width: 400
                });
                return false;
            }
            if (expandedWidget && expandedWidget !== widgetId) {
                pendingExpandRef.current = { widgetId, forceReset, morphFrom };
                closingFeatureRef.current = expandedWidget;
                setExpandedWidget(null);
                return true;
            }
            doExpand(widgetId, forceReset, morphFrom);
            return true;
        },
        [
            switching,
            expandedWidget,
            doExpand,
            isHiddenView,
            allowedToOpen,
            maintenanceLockOf,
            viewTitleOf,
            statusFeatureOf
        ]
    );

    /**
     * La tuile d'un appareil ouvre la feature Appareils, posée sur lui : de là on
     * passe à ses voisins sans repasser par l'accueil. La téléportation est le
     * chemin déjà emprunté pour rejoindre quelqu'un, que la vue sait consommer
     * (segment `l1`) dès que sa liste a chargé. Le morphe part de la tuile
     * cliquée, la carte Appareils n'étant pas forcément sur l'accueil.
     */
    const openDevice = useCallback(
        (deviceId: string, tileKey: string, forceReset: boolean) => {
            if (!handleExpand('devices', forceReset, tileKey)) return;
            const workspaceId = getWorkspaceState().activeId;
            if (workspaceId === null) return;
            startTeleport(workspaceId, ['view:devices', `l1:${deviceId}`]);
        },
        [handleExpand]
    );

    /**
     * Les cartes de la grille sont mémoïsées : leurs gestionnaires doivent l'être
     * aussi, or `handleExpand` change dès qu'une vue s'ouvre. Ils passent donc
     * par une référence, sur le modèle de `expandedWidgetRef`, et toute la grille
     * cesse de se rendre à l'ouverture d'une vue.
     */
    const expandRef = useRef(handleExpand);
    expandRef.current = handleExpand;
    const expandTile = useCallback((widgetId: string, e: MouseEvent<HTMLDivElement>) => {
        expandRef.current(widgetId, isForceReload(e));
    }, []);

    const openDeviceRef = useRef(openDevice);
    openDeviceRef.current = openDevice;
    const openDeviceTile = useCallback((deviceId: string, tileKey: string, forceReset: boolean) => {
        openDeviceRef.current(deviceId, tileKey, forceReset);
    }, []);

    const openFolderTile = useCallback((folderId: string, e: MouseEvent<HTMLDivElement>) => {
        setOpenFolder({
            id: folderId,
            source: e.currentTarget.getBoundingClientRect(),
            offset: greetingRef.current?.offsetHeight ?? 0
        });
    }, []);

    const handleClose = useCallback(() => {
        closingFeatureRef.current = expandedWidget;
        setExpandedWidget(null);
    }, [expandedWidget]);

    // Le fil des vues ouvertes, que joindra un signalement de bug. Posé sur
    // l'état et non sur `handleExpand`, qui peut refuser l'ouverture : on note
    // ce qui s'est affiché, pas ce qui a été demandé.
    useRootView(expandedWidget ?? 'home');

    /**
     * Les trois scènes qui coûtent : le montage de l'accueil, l'ouverture d'une
     * vue, le déploiement d'un dossier. La sonde ne mesure que là, une interface
     * au repos tenant ses 60 fps même sur un appareil qui décroche (voir
     * `perf/frameBudget`).
     */
    useEffect(() => {
        armFrameProbe(2000);
    }, []);
    useEffect(() => {
        if (expandedWidget !== null || openFolder !== null) armFrameProbe(1500);
    }, [expandedWidget, openFolder]);

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
            // Nom, logo et membres d'un espace distant viennent de SA session.
            const instanceId = getWorkspaceState().activeInstanceId;
            if (instanceId === null) await refresh();
            else await refreshRemoteSession(instanceId).catch(() => {});
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

    // Taper une lettre sur l'accueil au repos ouvre la recherche, la lettre déjà
    // saisie. Une vue, un dossier ou un dialogue ouvert garde ses frappes.
    const homeIdle = !expandedWidget && !openFolder && !editing && !settingsOpen && !switching;
    useEffect(() => {
        if (!homeIdle) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.ctrlKey || e.metaKey || e.altKey || e.repeat || e.isComposing) return;
            if (!/^\p{L}$/u.test(e.key)) return;
            const target = e.target as HTMLElement | null;
            const tag = target?.tagName;
            if (target?.isContentEditable || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
            if (hasDismissLayer() || isSpotlightOpen()) return;
            e.preventDefault();
            openSpotlight(e.key);
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [homeIdle]);
    useEffect(() => closeSpotlight, []);

    // Trois arrivées ouvrent d'elles-mêmes une vue : le retour d'un paiement
    // (`?account=<module>`, dont le module lit le reste de l'URL), le lien d'un
    // mail aux administrateurs vers la page système d'un module
    // (`?admin=<module>`) et la fin d'une inscription qui portait un indice
    // (`/signup?plan=…`).
    const arrivalHandled = useRef(false);
    useEffect(() => {
        if (arrivalHandled.current || switching) return;
        arrivalHandled.current = true;
        const url = new URL(window.location.href);
        const returning = url.searchParams.get('account');
        const adminPage = url.searchParams.get('admin');
        const plan = takeSignupPlan();
        if (returning) {
            url.searchParams.delete('account');
            window.history.replaceState({}, '', url);
            if (accountEntries().some((m) => m.manifest.id === returning)) openAccountView(returning);
        } else if (adminPage) {
            url.searchParams.delete('admin');
            window.history.replaceState({}, '', url);
            if (isAdmin && adminEntries().some((m) => m.manifest.id === adminPage)) {
                requestOpenView(adminViewId(adminPage));
            }
        } else if (plan) {
            const target = accountEntries().find((m) => m.manifest.accountEntry?.signupHint);
            if (target) openAccountView(target.manifest.id, plan);
        }
    }, [switching, isAdmin]);

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

    // Une feature passe en maintenance : qui s'y trouve en sort, et ses copies
    // gardées en vie cessent d'interroger un serveur qui refuse.
    const maintenanceLockRef = useRef(maintenanceLockOf);
    maintenanceLockRef.current = maintenanceLockOf;
    useEffect(() => {
        const open = expandedWidgetRef.current;
        if (open && isHiddenView(open)) {
            requestCloseFeature(open);
            void openInfo({
                title: 'Indisponible',
                body: <p>Cette fonctionnalité n’est plus disponible.</p>,
                width: 400
            });
        } else if (open && maintenanceLockOf(open)) {
            requestCloseFeature(open);
            void openInfo({
                title: 'En maintenance',
                body: (
                    <>
                        <p>
                            « {viewTitleOf(open)} » vient de passer en maintenance. Elle rouvrira dès que possible,
                            réessayez un peu plus tard.
                        </p>
                        <StatusPageLink featureId={statusFeatureOf(open)}>Suivre son état</StatusPageLink>
                    </>
                ),
                width: 400
            });
        }
        for (const id of mountedFeatures) {
            if (id !== open && (isHiddenView(id) || maintenanceLockOf(id))) unmountFeature(id);
        }
    }, [
        isHiddenView,
        maintenanceLockOf,
        mountedFeatures,
        requestCloseFeature,
        unmountFeature,
        viewTitleOf,
        statusFeatureOf
    ]);

    const accountMenuEntries = useMemo(
        () => accountMenu().filter((entry) => !hiddenFeatures.has(entry.id)),
        [hiddenFeatures]
    );
    const adminPages = useMemo(
        () =>
            isAdmin
                ? adminMenu().filter((page) => (page.id !== 'feedback' || feedbackEnabled) && !isHiddenView(page.id))
                : [],
        [isAdmin, feedbackEnabled, isHiddenView]
    );

    const views = staticViews();
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
    const folderEntries = useMemo(
        () => (folderView ? catalogEntries(folderView.items) : []),
        // Les features en préversion quittent le dossier affiché : relu quand leur liste change.
        [folderView, hiddenFeatures]
    );

    /** L'appartenance d'un appareil, en une lecture : la boucle des tuiles en
     *  faisait une par carte, sur une liste relue à chaque relevé. */
    const deviceIds = useMemo(() => new Set(devices.map((d) => d.id)), [devices]);
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
            doExpand(pending.widgetId, pending.forceReset, pending.morphFrom);
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
                if (maintenanceLockRef.current(config.id)) continue;
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

    /**
     * Bascule d'espace : publier l'id (les commandes suivantes le portent), puis
     * recharger l'état de la cible. La vue ouverte survit si la cible la propose
     * aussi, mais son contenu repart de zéro (l'époque entre dans la clé de
     * remontage). La composition de la cible n'est connue qu'après
     * `workspace.activate` : d'ici là le contenu est démonté, sinon il
     * interrogerait le nouvel espace avec les droits de l'ancien.
     */
    const handleSelectWorkspace = (workspaceId: number, instanceId: number | null = null) => {
        // Re-choisir l'espace courant n'est pas une bascule.
        const from = getWorkspaceState();
        if (workspaceId === from.activeId && instanceId === from.activeInstanceId) return;
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
        void (async () => {
            try {
                // La socket de l'instance visée s'ouvre AVANT de publier l'espace :
                // la bascule n'a alors plus qu'un aller-retour à faire, comme entre
                // deux espaces d'ici, et rien ne se recharge.
                if (instanceId !== null && !(await ensureRemoteReady(instanceId))) {
                    devicesModule?.refreshDevices();
                    if (openView) remountFeature(openView);
                    void openInfo({
                        title: 'Instance injoignable',
                        body: 'Cette instance distante ne répond pas. Vérifiez votre connexion (VPN), puis réessayez.'
                    });
                    return;
                }
                // L'id est publié d'abord : `workspace.activate` part alors avec la
                // bonne enveloppe, et le dispatcheur en vérifie l'appartenance.
                setActiveWorkspace(workspaceId, instanceId);
                // Le coffre est celui du compte de l'instance où l'on arrive : le
                // store le relit à l'ouverture de sa socket.
                if (instanceId !== from.activeInstanceId) setUnlocked(false);
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
                // sur un espace valide, avant de lever l'écran de bascule. Depuis
                // une instance distante, l'espace valide est le personnel d'ici.
                if (openView) handleClose();
                if (instanceId !== null) setActiveWorkspace(homeWorkspaceId(), null);
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
            const choice = await OpenPopup<CreateWorkspaceChoice>(CREATE_WORKSPACE_POPUP);
            if (!choice) return;
            if (choice.kind === 'remote') {
                // `/me` repose le cookie qui élargit la politique de contenu, puis
                // la page se recharge : celle d'un document est figée, et sans
                // cela le navigateur bloquerait tout appel vers l'instance. Le
                // drapeau rouvre la connexion au retour.
                await refresh();
                try {
                    sessionStorage.setItem(PENDING_REMOTE_KEY, String(choice.instance.id));
                } catch {
                    /* sans stockage de session, la connexion se rouvre à la main */
                }
                window.location.reload();
                return;
            }
            // Un espace se crée ici, où que l'on se trouve.
            const res = await ws.local.send('workspace.add', { name: choice.name });
            upsertWorkspace(res.workspace, null);
            handleSelectWorkspace(res.workspace.id, null);
        })();
    };

    // --- Instances distantes ---------------------------------------------------
    const remotes = useRemoteInstances();
    const [remoteLogin, setRemoteLogin] = useState<{ instanceId: number; workspaceId?: number } | null>(null);
    const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
    const selectRef = useRef(handleSelectWorkspace);
    selectRef.current = handleSelectWorkspace;

    /** Après connexion : l'espace demandé s'il existe encore là-bas, sinon le personnel de ce compte. */
    const enterRemote = useCallback((instanceId: number, wanted?: number) => {
        const list = getWorkspaceState().remoteWorkspaces[instanceId] ?? [];
        const target = list.find((w) => w.id === wanted) ?? list.find((w) => w.kind === 'personal') ?? list[0];
        if (target) selectRef.current(target.id, instanceId);
    }, []);

    // Au chargement : reprendre les sessions retenues sur cet appareil, puis
    // retourner là où l'on était, ou rouvrir la connexion qu'un ajout attendait.
    useEffect(() => {
        void (async () => {
            await restoreRemoteSessions();
            let pending: number | null = null;
            try {
                const raw = sessionStorage.getItem(PENDING_REMOTE_KEY);
                sessionStorage.removeItem(PENDING_REMOTE_KEY);
                pending = raw ? Number(raw) : null;
            } catch {
                pending = null;
            }
            if (pending !== null && getRemoteInstances().some((r) => r.instance.id === pending)) {
                setRemoteLogin({ instanceId: pending });
                return;
            }
            const last = readLastRemoteWorkspace();
            if (
                last?.instanceId != null &&
                getRemoteInstances().some((r) => r.instance.id === last.instanceId && r.user)
            ) {
                enterRemote(last.instanceId, last.id);
            }
        })();
    }, [enterRemote]);

    // APRÈS le dernier hook, jamais avant : quitter ou supprimer l'espace où l'on
    // se trouve laisse un instant la page sans espace courant, et un retour
    // placé plus haut changerait le nombre de hooks d'un rendu à l'autre, ce
    // que React sanctionne en faisant tomber tout l'écran.
    if (!user || !currentWorkspace) return null;

    const heading = homeHeading(currentWorkspace, user.username);

    const handleLogoutRemote = (instanceId: number) => {
        // Assis là-bas, on rentre d'abord : la session fermée, plus rien n'y répond.
        if (getWorkspaceState().activeInstanceId === instanceId) handleSelectWorkspace(homeWorkspaceId(), null);
        void logoutRemote(instanceId);
    };

    const handleRemoveRemote = (instanceId: number) => {
        const entry = remotes.find((r) => r.instance.id === instanceId);
        if (!entry) return;
        setConfirm({
            title: `Retirer ${entry.instance.label} ?`,
            description:
                'Ses espaces quittent votre liste. Rien n’est supprimé sur cette instance, et vous pourrez la rajouter.',
            confirmLabel: 'Retirer',
            onConfirm: () => {
                setConfirm(null);
                void (async () => {
                    await logoutRemote(instanceId);
                    await ws.local.send('remote.remove', { id: instanceId });
                    await refresh();
                })();
            }
        });
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
        layoutHint.dismiss();
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
                // Un dossier rempli dont plus rien n'est connu (modules retirés)
                // s'efface ; un dossier vraiment vide reste, inerte : on vient
                // de le créer.
                if (tile.items.length > 0 && catalogEntries(tile.items).length === 0) continue;
                tiles.push(<FolderTileCard key={tile.id} folder={tile} onOpen={openFolderTile} />);
                continue;
            }

            if (isShortcutTile(tile)) {
                tiles.push(<ShortcutTileCard key={tile.id} item={tile} />);
                continue;
            }

            if (isFeatureTile(tile)) {
                const widgetId = featureCatalogEntry(tile)?.id;
                if (widgetId === undefined) continue;
                // La tuile reste posée, en retrait : la retirer déplacerait les
                // voisines. Pendant une bascule, les droits vides ne sont ceux
                // de personne : pas de grisage.
                tiles.push(
                    <FeatureTileCard
                        key={tile}
                        tile={tile}
                        lock={switching ? undefined : lockOf(widgetId)}
                        adminBadge={adminBadgeOf(widgetId)}
                        hidden={expandedWidget !== null && morphSourceRef.current === widgetId}
                        onExpand={expandTile}
                    />
                );
                continue;
            }

            // Un appareil. Escamoté quand il n'existe plus (l'effet d'élagage
            // s'en charge), plutôt que de poser une carte creuse.
            if (!deviceIds.has(tile) || hiddenFeatures.has('devices')) continue;
            tiles.push(
                <DeviceTileCard
                    key={tile}
                    deviceId={tile}
                    lock={maintenanceLockOf('devices')}
                    hidden={expandedWidget !== null && morphSourceRef.current === deviceKey(tile)}
                    onOpen={openDeviceTile}
                />
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
                    accountEntries={accountMenuEntries}
                    onOpenAccountEntry={(id, e) => handleExpand(accountViewId(id), isForceReload(e))}
                    adminPages={adminPages}
                    onOpenAdminPage={(id, e) => handleExpand(id, isForceReload(e))}
                    siteBanner={siteBanner}
                    onDismissMaintenanceBanner={dismissEnvNotice}
                    onOpenSettings={canAppearance ? () => setSettingsOpen(true) : undefined}
                    onOrganize={canLayout ? () => startOrganizing() : undefined}
                    organizing={editing}
                    onDoneOrganizing={() => setEditing(false)}
                    onManageWorkspace={(e) => handleExpand('workspace', isForceReload(e))}
                    onSelectWorkspace={handleSelectWorkspace}
                    onConnectRemote={(instanceId, workspaceId) => setRemoteLogin({ instanceId, workspaceId })}
                    onLogoutRemote={handleLogoutRemote}
                    onRemoveRemote={handleRemoveRemote}
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
                        ) : (
                            // A fresh home has no section: point the way in.
                            <EmptyHome canLayout={canLayout} onCompose={() => startOrganizing(true)} />
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
                    lockOf={lockOf}
                    adminBadgeOf={adminBadgeOf}
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
                                ? `${morphEpochRef.current}:${morphSourceRef.current}`
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

                    return (
                        <FeatureKeepAlive
                            key={`${workspaceEpoch}-${id}-${gen}`}
                            target={target}
                            featureId={statusFeatureOf(id)}
                        >
                            <ViewScope id={id}>
                                <config.FullComponent {...featureProps} />
                            </ViewScope>
                        </FeatureKeepAlive>
                    );
                })}

                <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} />

                {/* Création d'espace, pilotée depuis le menu de la topbar. */}
                <CreateWorkspacePopup />
                <RemoteLogin
                    entry={remotes.find((r) => r.instance.id === remoteLogin?.instanceId) ?? null}
                    onClose={() => setRemoteLogin(null)}
                    onConnected={(instanceId) => {
                        const wanted = remoteLogin?.workspaceId;
                        setRemoteLogin(null);
                        enterRemote(instanceId, wanted);
                    }}
                />
                {canLayout && !editing && !expandedWidget && !openFolder && (
                    <OrganizeButton
                        onOrganize={() => startOrganizing()}
                        hinted={layoutHint.show}
                        onDismissHint={layoutHint.dismiss}
                    />
                )}
                <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
                <Spotlight
                    layout={layout}
                    canLayout={canLayout}
                    canFeature={canFeature}
                    onOpen={(featureId) => expandRef.current(featureId)}
                />

                {/* Shared info dialog, registered once here so any feature's "i" button
                opens it via openInfo(). */}
                <InfoPopup />
                <QuotaPrompt />

                {/* Curseurs des pairs situés exactement là où nous sommes, et ma
                    propre bulle. Séparée : elle doit survivre au départ du dernier
                    pair, alors que `LiveCursors` sort quand il n'y a plus rien à
                    dessiner. */}
                <LiveCursors />
                <CursorChatInput />
            </div>
        </LiveProvider>
    );
}

import { useState, useCallback, useMemo, useEffect, useRef, type ComponentType, type ReactNode } from 'react';

import { useAuth } from '@/auth/AuthProvider';
import { ws } from '@/api/ws';
import { isHomeReady, onHomeReady } from '@/stores/homeReady';
import { useDevices } from '@/stores/devices';
import {
    useHomeLayout,
    getHomeLayout,
    placedDeviceIds,
    placedFeatureIds,
    pruneMissingDevices
} from '@/stores/homeLayout';
import { onOpenViewRequest } from '@/stores/viewRequest';
import { TopNavbar } from '@/Components/TopNavbar';
import { Widget } from '@/Components/Widget';
import { WidgetGrid } from '@/Components/WidgetGrid';
import { WidgetPopup, FeatureKeepAlive } from '@/Components/WidgetPopup';
import { Wallpaper } from '@/Components/Wallpaper';
import { SettingsPanel } from '@/Components/SettingsPanel';
import { InfoPopup } from '@/Components/InfoPopup';
import PopupUnlock from './popup-unlock';

// Structural feature views (no grid card)
import Clients from '@/Features/Clients';
import Security from '@/Features/Security';
import FeatureProfile from '@/Features/Profile';
import FeatureLogs from '@/Features/Logs';
// Device popup content (Monitoring panel without the sidebar)
import MonitoringPanel from '@/Features/Monitoring/MonitoringPanel';

import { FEATURE_CATALOG } from './catalog';
import { isForceReload } from './forceReload';
import { deviceTileVisual, deviceViewId, featureTileVisual, shortcutTileVisual } from './tiles/tileVisual';
import { EditableHome } from './organize/EditableHome';

import type { HomeSection } from 'deveye-types';
import type { FeatureProps } from '@/Features/types';
import styles from './Dashboard.module.css';

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
    { id: 'logs', title: 'Logs', icon: 'activity', cacheDurationMinutes: 5, hasCard: false, FullComponent: FeatureLogs }
];

function getGreeting(): string {
    const hour = new Date().getHours();
    if (hour < 12) return 'Bonjour';
    if (hour < 18) return 'Bon après-midi';
    return 'Bonsoir';
}

function formatDate(): string {
    return new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
}

export default function HomePage() {
    const { user, workspaces, setWorkspaces } = useAuth();
    const layout = useHomeLayout();
    const { devices, loading: devicesLoading } = useDevices();

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
    // Timers for TTL-based auto-unmount, keyed by view id.
    const ttlTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
    // The view whose popup is currently animating out (policy applied on exit).
    const closingFeatureRef = useRef<string | null>(null);
    // Views that must unmount on close regardless of their cache TTL (a feature
    // asked to close itself with nothing to show — see requestCloseFeature).
    const forceUnmountRef = useRef<Set<string>>(new Set());
    // Expand requested while another popup is still open / animating out.
    const pendingExpandRef = useRef<{ widgetId: string; forceReset: boolean } | null>(null);

    const currentWorkspace = useMemo(() => {
        return workspaces.find((w) => w.id === user?.defaultWorkspace) ?? workspaces[0] ?? null;
    }, [workspaces, user]);

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

    const doExpand = useCallback((widgetId: string, forceReset: boolean) => {
        clearTimeout(ttlTimers.current.get(widgetId));
        ttlTimers.current.delete(widgetId);
        if (closingFeatureRef.current === widgetId) closingFeatureRef.current = null;

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

    const handleExpand = useCallback(
        (widgetId: string, forceReset = false) => {
            if (expandedWidget && expandedWidget !== widgetId) {
                pendingExpandRef.current = { widgetId, forceReset };
                closingFeatureRef.current = expandedWidget;
                setExpandedWidget(null);
                return;
            }
            doExpand(widgetId, forceReset);
        },
        [expandedWidget, doExpand]
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

    if (!user) return null;

    const defaultWorkspace = currentWorkspace ?? {
        id: 0,
        name: 'Default',
        logo: '',
        users: [],
        features: [],
        reAuthInterval: null,
        created: 0
    };

    const handleSetWorkspace = (ws: typeof defaultWorkspace) => {
        setWorkspaces((prev) => prev.map((w) => (w.id === ws.id ? ws : w)));
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
                tiles.push(
                    <Widget
                        key={fid}
                        widgetId={v.widgetId}
                        title={v.title}
                        icon={v.icon}
                        // Hidden while its popup is open so frequent re-renders can't
                        // make the source card flash behind the morphed popup.
                        style={expandedWidget === v.widgetId ? { opacity: 0 } : undefined}
                        onExpand={(e) => handleExpand(v.widgetId, isForceReload(e))}
                    >
                        {v.body}
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
            <div key={section.id} className={styles.sectionGroup}>
                {section.title && <h2 className={styles.sectionHeading}>{section.title}</h2>}
                <WidgetGrid>{tiles}</WidgetGrid>
            </div>
        );
    };

    return (
        <div className={styles.dashboard}>
            <Wallpaper />

            <TopNavbar
                viewTitle={expandedConfig?.title}
                onBack={expandedWidget ? handleClose : undefined}
                onOpenProfile={(e) => handleExpand('profile', isForceReload(e))}
                onOpenSecurity={(e) => handleExpand('security', isForceReload(e))}
                onOpenDevices={user.role === 'admin' ? (e) => handleExpand('clients', isForceReload(e)) : undefined}
                onOpenLogs={user.role === 'admin' ? (e) => handleExpand('logs', isForceReload(e)) : undefined}
                onOpenSettings={() => setSettingsOpen(true)}
                onOrganize={() => startOrganizing()}
                organizing={editing}
                onDoneOrganizing={() => setEditing(false)}
            />

            {/* The grid stays mounted under the popup so the shared-element morph
                back into a card is smooth and never dips behind sibling cards. */}
            <main className={styles.main}>
                <div className={styles.content}>
                    <header className={styles.greeting}>
                        <h1 className={styles.greetingText}>
                            {getGreeting()}, {user.username}
                        </h1>
                        <p className={styles.dateText}>{formatDate()}</p>
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
                    layoutId={popupConfig.hasCard ? popupConfig.id : undefined}
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
                    workspace: defaultWorkspace,
                    feature: { id: config.id, name: config.title, icon: config.icon, component: () => null },
                    setWorkspace: handleSetWorkspace,
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
                    <FeatureKeepAlive key={`${id}-${gen}`} target={target}>
                        {body}
                    </FeatureKeepAlive>
                );
            })}

            <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} />

            {/* Password unlock dialog — registered globally so the Password feature
                can request it on demand. */}
            <PopupUnlock workspace={currentWorkspace} />

            {/* Shared info dialog, registered once here so any feature's "i" button
                opens it via openInfo(). */}
            <InfoPopup />
        </div>
    );
}

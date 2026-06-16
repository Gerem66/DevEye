import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react';

import { useAuth } from '@/auth/AuthProvider';
import { TopNavbar } from '@/Components/TopNavbar';
import { Widget } from '@/Components/Widget';
import { WidgetGrid } from '@/Components/WidgetGrid';
import { WidgetPopup, FeatureKeepAlive } from '@/Components/WidgetPopup';
import { Wallpaper } from '@/Components/Wallpaper';
import { SettingsPanel } from '@/Components/SettingsPanel';
import PopupUnlock from './popup-unlock';

// Widget content (compact)
import { MonitoringWidget } from '@/Features/Monitoring';
import { WeatherWidget } from '@/Features/Weather';
import { ClientsWidget } from '@/Features/Clients';
// Full feature components
import Monitoring from '@/Features/Monitoring';
import Weather from '@/Features/Weather';
import Clients from '@/Features/Clients';
import TwoFactor from '@/Features/TwoFactor';
import FeatureProfile from '@/Features/Profile';
import FeaturePassword from '@/Features/Password';

import type { FeatureProps } from '@/Features/types';
import styles from './Dashboard.module.css';

/** A view that can be opened full-screen in the popup. */
interface ViewConfig {
    id: string;
    title: string;
    icon: string;
    FullComponent: React.ComponentType<FeatureProps>;
    /**
     * How long (minutes) the view stays mounted after its popup closes.
     * - `0`         → unmount immediately on close.
     * - `> 0`       → keep mounted for that many minutes, then auto-unmount.
     * - `undefined` → keep mounted indefinitely (until a Ctrl+click reset).
     */
    cacheDurationMinutes?: number;
}

/** A modular feature: a view that also shows as a card on the home grid. */
interface FeatureConfig extends ViewConfig {
    WidgetContent: React.ComponentType;
}

// Modular features — shown as cards on the home grid; their popup morphs open
// from the card via a shared-element transition.
const FEATURES: FeatureConfig[] = [
    {
        id: 'monitoring',
        title: 'Monitoring',
        icon: 'activity',
        WidgetContent: MonitoringWidget,
        FullComponent: Monitoring,
        cacheDurationMinutes: 5
    },
    {
        id: 'weather',
        title: 'Météo',
        icon: 'cloud',
        WidgetContent: WeatherWidget,
        FullComponent: Weather,
        cacheDurationMinutes: 10
    },
    {
        id: 'clients',
        title: 'Appareils',
        icon: 'server',
        WidgetContent: ClientsWidget,
        FullComponent: Clients,
        cacheDurationMinutes: 5
    },
    {
        id: 'password',
        title: 'Mot de passe',
        icon: 'lock',
        WidgetContent: () => <PasswordWidgetContent />,
        FullComponent: FeaturePassword,
        cacheDurationMinutes: 0
    }
];

// Structural DevEye pages — part of the app itself, reached from the navbar
// menu rather than the grid; they fade in (no card to morph from).
const PAGES: ViewConfig[] = [
    {
        id: 'profile',
        title: 'Profil',
        icon: 'user',
        FullComponent: FeatureProfile,
        cacheDurationMinutes: 0
    },
    {
        id: 'twofa',
        title: 'Sécurité 2FA',
        icon: 'shield',
        FullComponent: TwoFactor,
        cacheDurationMinutes: 1
    }
];

const VIEWS: ViewConfig[] = [...FEATURES, ...PAGES];

function PasswordWidgetContent() {
    return (
        <div className={styles.profileWidget}>
            <span className={styles.simpleHint}>Modifier votre mot de passe</span>
        </div>
    );
}

function getGreeting(): string {
    const hour = new Date().getHours();
    if (hour < 12) return 'Bonjour';
    if (hour < 18) return 'Bon après-midi';
    return 'Bonsoir';
}

function formatDate(): string {
    return new Date().toLocaleDateString('fr-FR', {
        weekday: 'long',
        day: 'numeric',
        month: 'long'
    });
}

export default function HomePage() {
    const { user, workspaces, setWorkspaces } = useAuth();
    const [expandedWidget, setExpandedWidget] = useState<string | null>(null);
    const [settingsOpen, setSettingsOpen] = useState(false);

    // Set of feature ids whose components are currently mounted (cached).
    const [mountedFeatures, setMountedFeatures] = useState<Set<string>>(new Set());

    // Per-feature "generation" counter. Bumping it changes the component key,
    // forcing React to fully unmount (running the feature's onUnmount cleanup)
    // and remount a fresh instance — used for the Ctrl+click forced reset.
    const [featureGen, setFeatureGen] = useState<Map<string, number>>(new Map());

    // The open popup's body element — feature content is portaled into it.
    const [popupBodyEl, setPopupBodyEl] = useState<HTMLDivElement | null>(null);

    // Timers for TTL-based auto-unmount, keyed by feature id.
    const ttlTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

    // The feature whose popup is currently animating out (policy applied on exit).
    const closingFeatureRef = useRef<string | null>(null);

    // Feature expand requested while another popup is still open / animating out.
    // Applied in handleExitComplete once the current popup finishes closing.
    const pendingExpandRef = useRef<{ widgetId: string; forceReset: boolean } | null>(null);

    const currentWorkspace = useMemo(() => {
        return workspaces.find((w) => w.id === user?.defaultWorkspace) ?? workspaces[0] ?? null;
    }, [workspaces, user]);

    /**
     * Remove a feature from the DOM. React unmounts the component, which runs
     * its `useFeatureLifecycle` cleanup (onUnmount) — so save/teardown happens
     * automatically regardless of why the feature is being unloaded.
     */
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
            // If a popup is already open (or animating out), close it first and
            // defer the new open until the exit animation completes.
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
        // Remember which feature is closing; the unload policy is applied once
        // the morph-back animation finishes (handleExitComplete), so the content
        // stays visible *inside* the panel during the close animation.
        closingFeatureRef.current = expandedWidget;
        setExpandedWidget(null);
    }, [expandedWidget]);

    const handleExitComplete = useCallback(() => {
        const featureId = closingFeatureRef.current;
        closingFeatureRef.current = null;
        if (!featureId) return;

        const config = VIEWS.find((v) => v.id === featureId);
        if (!config) return;

        const duration = config.cacheDurationMinutes;

        if (duration === 0) {
            unmountFeature(featureId);
        } else if (duration !== undefined) {
            clearTimeout(ttlTimers.current.get(featureId));
            const timer = setTimeout(() => unmountFeature(featureId), duration * 60 * 1000);
            ttlTimers.current.set(featureId, timer);
        }

        // If another feature was waiting to open, trigger it now.
        const pending = pendingExpandRef.current;
        if (pending) {
            pendingExpandRef.current = null;
            doExpand(pending.widgetId, pending.forceReset);
        }
    }, [unmountFeature, doExpand]);

    // Clean up all timers on unmount.
    useEffect(() => {
        return () => {
            ttlTimers.current.forEach((t) => clearTimeout(t));
        };
    }, []);

    const expandedConfig = expandedWidget ? (VIEWS.find((v) => v.id === expandedWidget) ?? null) : null;

    // Keep the last opened config around so the panel still has content (and the
    // correct layoutId) during its close animation. While open we always use the
    // *current* config, so a freshly opened card morphs from its own position.
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

    return (
        <div className={styles.dashboard}>
            <Wallpaper />

            <TopNavbar
                viewTitle={expandedConfig?.title}
                onBack={expandedWidget ? handleClose : undefined}
                onOpenProfile={() => handleExpand('profile')}
                onOpenTwoFactor={() => handleExpand('twofa')}
                onOpenSettings={() => setSettingsOpen(true)}
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

                    <WidgetGrid>
                        {FEATURES.map((config) => (
                            <Widget
                                key={config.id}
                                widgetId={config.id}
                                title={config.title}
                                icon={config.icon}
                                onExpand={(e) => handleExpand(config.id, e.ctrlKey)}
                            >
                                <config.WidgetContent />
                            </Widget>
                        ))}
                    </WidgetGrid>
                </div>
            </main>

            {/* The animated popup shell. It stays visually empty — the active
                view's content is portaled into its body by the keep-alive layer
                below, so closing the popup never unmounts the view. Features
                morph from/back to their grid card; pages have no card and fade. */}
            {popupConfig && (
                <WidgetPopup
                    key={FEATURES.some((f) => f.id === popupConfig.id) ? popupConfig.id : 'page'}
                    layoutId={FEATURES.some((f) => f.id === popupConfig.id) ? popupConfig.id : undefined}
                    open={!!expandedWidget}
                    onClose={handleClose}
                    bodyRef={setPopupBodyEl}
                    onExitComplete={handleExitComplete}
                />
            )}

            {/* Keep-alive layer: every cached feature stays mounted here and is
                portaled into the open popup body when active, or parked hidden
                otherwise — preserving its state across close/reopen. */}
            {[...mountedFeatures].map((id) => {
                const config = VIEWS.find((v) => v.id === id);
                if (!config) return null;

                const featureProps: FeatureProps = {
                    user,
                    workspace: defaultWorkspace,
                    feature: {
                        id: config.id,
                        name: config.title,
                        icon: config.icon,
                        component: config.FullComponent
                    },
                    setWorkspace: handleSetWorkspace,
                    setFeature: () => {}
                };

                const gen = featureGen.get(id) ?? 0;
                // Portal into the popup body while this feature owns the popup
                // (open *or* animating out); otherwise keep it parked hidden.
                const target = popupConfig?.id === id ? popupBodyEl : null;

                return (
                    // The generation in the key forces a fresh remount on a forced
                    // reset (Ctrl+click): old instance unmounts (onUnmount fires)
                    // and a fresh one mounts, reloading the feature from scratch.
                    <FeatureKeepAlive key={`${id}-${gen}`} target={target}>
                        <config.FullComponent {...featureProps} />
                    </FeatureKeepAlive>
                );
            })}

            <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} />

            {/* Password unlock dialog — registered globally so the Password feature
                can request it on demand. */}
            <PopupUnlock workspace={currentWorkspace} />
        </div>
    );
}

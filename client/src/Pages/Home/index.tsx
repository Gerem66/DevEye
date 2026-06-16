import React, { useState, useCallback, useMemo, useEffect } from 'react';

import { useAuth } from '@/auth/AuthProvider';
import { TopNavbar } from '@/Components/TopNavbar';
import { Widget } from '@/Components/Widget';
import { WidgetGrid } from '@/Components/WidgetGrid';
import { WidgetPopup } from '@/Components/WidgetPopup';
import { Wallpaper } from '@/Components/Wallpaper';
import { SettingsPanel } from '@/Components/SettingsPanel';
import PopupUnlock from './popup-unlock';

// Widget content (compact)
import { MonitoringWidget } from '@/Features/Monitoring';
import { WeatherWidget } from '@/Features/Weather';
import { ClientsWidget } from '@/Features/Clients';
import { TwoFactorWidget } from '@/Features/TwoFactor';

// Full feature components
import Monitoring from '@/Features/Monitoring';
import Weather from '@/Features/Weather';
import Clients from '@/Features/Clients';
import TwoFactor from '@/Features/TwoFactor';
import FeatureProfile from '@/Features/Profile';
import FeaturePassword from '@/Features/Password';

import type { FeatureProps } from '@/Features/types';
import styles from './Dashboard.module.css';

interface WidgetConfig {
    id: string;
    title: string;
    icon: string;
    WidgetContent: React.ComponentType;
    FullComponent: React.ComponentType<FeatureProps>;
    /** Openable (e.g. from the topbar) but not shown as a grid card. */
    hideOnGrid?: boolean;
}

const WIDGETS: WidgetConfig[] = [
    {
        id: 'monitoring',
        title: 'Monitoring',
        icon: 'activity',
        WidgetContent: MonitoringWidget,
        FullComponent: Monitoring
    },
    {
        id: 'weather',
        title: 'Météo',
        icon: 'cloud',
        WidgetContent: WeatherWidget,
        FullComponent: Weather
    },
    {
        id: 'clients',
        title: 'Appareils',
        icon: 'server',
        WidgetContent: ClientsWidget,
        FullComponent: Clients
    },
    {
        id: 'twofa',
        title: 'Sécurité 2FA',
        icon: 'shield',
        WidgetContent: TwoFactorWidget,
        FullComponent: TwoFactor
    },
    {
        id: 'profile',
        title: 'Profil',
        icon: 'user',
        WidgetContent: () => <ProfileWidgetContent />,
        FullComponent: FeatureProfile,
        hideOnGrid: true
    },
    {
        id: 'password',
        title: 'Mot de passe',
        icon: 'lock',
        WidgetContent: () => <PasswordWidgetContent />,
        FullComponent: FeaturePassword
    }
];

const GRID_WIDGETS = WIDGETS.filter((w) => !w.hideOnGrid);

function ProfileWidgetContent() {
    const { user } = useAuth();
    return (
        <div className={styles.profileWidget}>
            <span className={styles.profileName}>{user?.username}</span>
            <span className={styles.profileEmail}>{user?.email}</span>
        </div>
    );
}

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

    const currentWorkspace = useMemo(() => {
        return workspaces.find((w) => w.id === user?.defaultWorkspace) ?? workspaces[0] ?? null;
    }, [workspaces, user]);

    const handleExpand = useCallback((widgetId: string) => {
        setExpandedWidget(widgetId);
    }, []);

    const handleClose = useCallback(() => {
        setExpandedWidget(null);
    }, []);

    const expandedConfig = expandedWidget ? (WIDGETS.find((w) => w.id === expandedWidget) ?? null) : null;

    // Keep the last opened config around so the panel still has content (and the
    // correct layoutId) during its close animation. While open we always use the
    // *current* config, so a freshly opened card morphs from its own position.
    const [lastConfig, setLastConfig] = useState<WidgetConfig | null>(null);
    useEffect(() => {
        if (expandedConfig) setLastConfig(expandedConfig);
    }, [expandedConfig]);
    const popupConfig = expandedConfig ?? lastConfig;

    if (!user) return null;

    // Build FeatureProps for the full component (uses the persisted popup config).
    const featureProps: FeatureProps = {
        user,
        workspace: currentWorkspace ?? {
            id: 0,
            name: 'Default',
            logo: '',
            users: [],
            features: [],
            reAuthInterval: null,
            created: 0
        },
        feature: {
            id: popupConfig?.id ?? '',
            name: popupConfig?.title ?? '',
            icon: popupConfig?.icon ?? '',
            component: popupConfig?.FullComponent ?? (() => null)
        },
        setWorkspace: (ws) => {
            setWorkspaces((prev) => prev.map((w) => (w.id === ws.id ? ws : w)));
        },
        setFeature: () => {}
    };

    return (
        <div className={styles.dashboard}>
            <Wallpaper />

            <TopNavbar
                viewTitle={expandedConfig?.title}
                onBack={expandedWidget ? handleClose : undefined}
                onOpenProfile={() => handleExpand('profile')}
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
                        {GRID_WIDGETS.map((config) => (
                            <Widget
                                key={config.id}
                                widgetId={config.id}
                                title={config.title}
                                icon={config.icon}
                                onExpand={() => handleExpand(config.id)}
                            >
                                <config.WidgetContent />
                            </Widget>
                        ))}
                    </WidgetGrid>
                </div>
            </main>

            {/* Popup for the expanded widget — the topbar owns the title + back action */}
            {popupConfig && (
                <WidgetPopup layoutId={popupConfig.id} open={!!expandedWidget} onClose={handleClose}>
                    <popupConfig.FullComponent {...featureProps} />
                </WidgetPopup>
            )}

            <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} />

            {/* Password unlock dialog — registered globally so the Password feature
                can request it on demand. */}
            <PopupUnlock workspace={currentWorkspace} />
        </div>
    );
}

import React, { useState, useCallback, useMemo } from 'react';

import { useAuth } from '@/auth/AuthProvider';
import { TopNavbar } from '@/Components/TopNavbar';
import { Widget } from '@/Components/Widget';
import { WidgetGrid } from '@/Components/WidgetGrid';
import { WidgetPopup } from '@/Components/WidgetPopup';
import { Wallpaper } from '@/Components/Wallpaper';
import { SettingsPanel } from '@/Components/SettingsPanel';

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
        FullComponent: FeatureProfile
    },
    {
        id: 'password',
        title: 'Mot de passe',
        icon: 'lock',
        WidgetContent: () => <PasswordWidgetContent />,
        FullComponent: FeaturePassword
    }
];

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

    const expandedConfig = expandedWidget ? WIDGETS.find((w) => w.id === expandedWidget) : null;

    if (!user) return null;

    // Build FeatureProps for full component
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
            id: expandedConfig?.id ?? '',
            name: expandedConfig?.title ?? '',
            icon: expandedConfig?.icon ?? '',
            component: expandedConfig?.FullComponent ?? (() => null)
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

            <main className={styles.main}>
                {!expandedWidget && (
                    <div className={styles.content}>
                        <header className={styles.greeting}>
                            <h1 className={styles.greetingText}>
                                {getGreeting()}, {user.username}
                            </h1>
                            <p className={styles.dateText}>{formatDate()}</p>
                        </header>

                        <WidgetGrid>
                            {WIDGETS.map((config) => (
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
                )}
            </main>

            {/* Popup for expanded widget — the topbar owns the title + back action */}
            {expandedConfig && (
                <WidgetPopup layoutId={expandedConfig.id} open={!!expandedWidget} onClose={handleClose}>
                    <expandedConfig.FullComponent {...featureProps} />
                </WidgetPopup>
            )}

            <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} />
        </div>
    );
}

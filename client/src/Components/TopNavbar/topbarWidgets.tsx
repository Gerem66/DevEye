import { type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import type { HomeTopbarWidgetId } from 'deveye-types';

import { useDevices } from '@/stores/devices';
import { useUptimeCount } from '@/stores/uptime';
import { useWeather } from '@/stores/weather';
import { useHomeLayout } from '@/stores/homeLayout';
import { wmoIcon } from '@/Features/Weather/wmoIcon';
import { SecrecyTimer } from './SecrecyTimer';
import { LivePresence } from './LivePresence';
import styles from './TopNavbar.module.css';

/**
 * Catalog of the compact widgets that can be pinned to the top-right of the
 * navbar — the source of truth for their label/icon/description in the in-place
 * "add" picker (see {@link EditableTopbarWidgets}). The live rendering of each is
 * {@link renderTopbarWidget}.
 */
export interface TopbarWidgetMeta {
    id: HomeTopbarWidgetId;
    title: string;
    icon: string;
    description: string;
}

export const TOPBAR_WIDGETS: TopbarWidgetMeta[] = [
    { id: 'weather', title: 'Météo', icon: 'cloud', description: 'Température de la ville principale' },
    { id: 'devices', title: 'Appareils connectés', icon: 'server', description: "Nombre d'appareils en ligne" },
    { id: 'secrecy', title: 'Chiffrement', icon: 'lock', description: 'Minuteur du chiffrement par mot de passe' },
    { id: 'uptime', title: 'Uptime', icon: 'uptime', description: 'Services en ligne sur les services surveillés' },
    { id: 'live', title: 'Présence', icon: 'user', description: 'Qui est dans cet espace, et où' }
];

/** Weather mini-widget: current temperature of the primary city. */
export function WeatherStatus() {
    const { report } = useWeather();
    const current = report?.current ?? null;
    return (
        <span className={styles.statusItem} title={report?.label ?? 'Météo'}>
            <span className={styles.statusTemp}>
                {current ? `${wmoIcon(current.code)} ${Math.round(current.temperature)}°` : '—'}
            </span>
        </span>
    );
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

/** Uptime mini-widget: services confirmed healthy / total monitored. */
export function UptimeStatus() {
    const { total, up, down, loading } = useUptimeCount();
    // The icon carries both the identity (which widget is this?) and the state,
    // so the two count widgets can't be mistaken for one another at a glance.
    const tone = down > 0 ? styles.statusAlert : total > 0 && up === total ? styles.statusOk : '';
    return (
        <span className={styles.statusItem} title='Services surveillés en ligne'>
            <span className={`icon icon-uptime ${tone}`} />
            {loading ? '—' : `${up}/${total}`}
        </span>
    );
}

/** Render a single topbar widget by id (shared by the live navbar and the editor). */
export function renderTopbarWidget(id: HomeTopbarWidgetId, onOpenSecurity?: (e: ReactMouseEvent) => void): ReactNode {
    switch (id) {
        case 'weather':
            return <WeatherStatus />;
        case 'devices':
            return <DevicesStatus />;
        case 'secrecy':
            return <SecrecyTimer onOpenSecurity={onOpenSecurity} />;
        case 'uptime':
            return <UptimeStatus />;
        case 'live':
            return <LivePresence />;
        default:
            return null;
    }
}

/**
 * Live mini-widgets pinned to the top-right of the navbar, in the user's order.
 * The set comes from the home layout's `topbar` category, edited in place via
 * {@link EditableTopbarWidgets}; empty by default so nothing shows until opted in.
 */
export function TopbarWidgets({ onOpenSecurity }: { onOpenSecurity?: (e: ReactMouseEvent) => void }) {
    const layout = useHomeLayout();
    const items = layout.topbar;
    if (items.length === 0) return null;
    return (
        <div className={styles.status}>
            {items.map((id) => (
                <span key={id}>{renderTopbarWidget(id, onOpenSecurity)}</span>
            ))}
        </div>
    );
}

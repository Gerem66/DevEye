import { useDeviceUsage } from './deviceUsage';
import { useDevices } from './store';
import { activityLevel, formatAgo, pct, type Activity } from './utils';
import styles from './DeviceWidget.module.css';

export interface DeviceWidgetProps {
    deviceId: string;
    /** Hide the corner status (in edit mode it would sit under the remove button). */
    hideStatus?: boolean;
}

/** CSS class carrying the activity tint, per level (mirrors the Monitoring hero). */
const LEVEL_CLASS: Record<Activity, string> = {
    idle: styles.lvlIdle,
    normal: styles.lvlNormal,
    intensive: styles.lvlIntense
};

function Metric({ label, value }: { label: string; value: number | null }) {
    return (
        <span className={styles.metric}>
            <strong className={styles.metricValue}>{value == null ? '—' : `${value}%`}</strong>
            <span className={styles.metricLabel}>{label}</span>
        </span>
    );
}

/**
 * Compact home-grid tile for a single device. When online, the whole card is
 * subtly tinted by its current activity level (idle / normal / intensive — same
 * effect as the Monitoring hero) and shows CPU / RAM / Disk as small equal
 * metrics. Status sits in the top-right corner. Usage comes from the shared,
 * ref-counted {@link useDeviceUsage} store: it seeds from one query then follows
 * the live metric stream (the polling it once did is gone). Clicking opens the
 * device popup (wired in the home grid).
 */
export function DeviceWidget({ deviceId, hideStatus }: DeviceWidgetProps) {
    const { devices } = useDevices();
    const device = devices.find((d) => d.id === deviceId) ?? null;
    const usage = useDeviceUsage(deviceId);

    if (!device) {
        return (
            <div className={styles.widget}>
                <span className={styles.name}>Appareil introuvable</span>
            </div>
        );
    }

    const online = device.online;
    const archived = device.status === 'archived';
    const showUsage = online && !archived && !!usage;
    const cores = device.report?.os.cores ?? 0;
    const level = showUsage ? activityLevel(usage, cores) : null;

    const cpu = usage ? Math.round(usage.cpuPercent) : null;
    const ram = usage ? Math.round(pct(usage.memUsedBytes, usage.memTotalBytes)) : null;
    const disk = usage ? Math.round(pct(usage.diskUsedBytes, usage.diskTotalBytes)) : null;

    const statusKind = archived ? styles.archived : online ? styles.online : styles.offline;
    const statusLabel = archived ? 'Archivé' : online ? 'En ligne' : 'Hors ligne';

    return (
        <div className={styles.widget}>
            <span className={`${styles.bg} ${level ? LEVEL_CLASS[level] : ''}`} aria-hidden='true' />

            <div className={styles.top}>
                <span className={styles.name}>
                    <span className={`icon icon-server ${styles.nameIcon}`} />
                    {device.name}
                </span>
                {!hideStatus && (
                    <span className={`${styles.status} ${statusKind}`}>
                        <span className={styles.statusDot} />
                        {statusLabel}
                    </span>
                )}
            </div>

            {showUsage ? (
                <div className={styles.metrics}>
                    <Metric label='CPU' value={cpu} />
                    <Metric label='RAM' value={ram} />
                    <Metric label='Disque' value={disk} />
                </div>
            ) : (
                <span className={styles.hint}>
                    {online && !archived
                        ? 'Mesure en cours…'
                        : archived
                          ? 'Historique en lecture seule'
                          : device.lastSeen
                            ? `Vu il y a ${formatAgo(device.lastSeen * 1000)}`
                            : 'Jamais connecté'}
                </span>
            )}
        </div>
    );
}

export default DeviceWidget;

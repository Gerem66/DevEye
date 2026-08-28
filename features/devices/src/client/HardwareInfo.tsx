import type { Device, DeviceReport, NetInterfaceKind } from '@deveye/types';
import { agentUpdatable } from './agentVersion';
import { pct } from './utils';
import styles from './style.module.css';

/**
 * Human-readable bytes (binary units), used for RAM and disks.
 *
 * Distinct de `utils.formatBytes` par un palier : l'inventaire matériel affiche
 * des capacités de disque, où le téraoctet est courant. Les graphes, eux, ne
 * dépassent jamais le gigaoctet et s'arrêtent là.
 */
function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
    if (bytes < 1024 ** 4) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
    return `${(bytes / 1024 ** 4).toFixed(2)} TB`;
}

/** Frequency in MHz → "x.xx GHz" (or "n MHz" below 1 GHz). */
function formatFreq(mhz: number): string {
    return mhz >= 1000 ? `${(mhz / 1000).toFixed(2)} GHz` : `${mhz} MHz`;
}

/** French label + display order for each inferred network interface class. */
const NET_KIND: Record<NetInterfaceKind, { label: string; order: number }> = {
    wifi: { label: 'Wi-Fi', order: 0 },
    ethernet: { label: 'Ethernet', order: 1 },
    bluetooth: { label: 'Bluetooth', order: 2 },
    other: { label: 'Autre', order: 3 },
    virtual: { label: 'Virtuel', order: 4 },
    loopback: { label: 'Boucle locale', order: 5 }
};

function Row({ label, value }: { label: string; value: React.ReactNode }) {
    return (
        <div className={styles.hwRow}>
            <dt>{label}</dt>
            <dd>{value}</dd>
        </div>
    );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
    return (
        <section className={styles.hwGroup}>
            <h4 className={styles.hwGroupTitle}>{title}</h4>
            <dl className={styles.hwRows}>{children}</dl>
        </section>
    );
}

/**
 * Body of the per-device hardware/agent dialog (opened from the panel's chip
 * icon, via openInfo). Lays out the static inventory the agent reports — CPU,
 * RAM, GPU, connectivity, storage — plus how & when the agent collected it.
 *
 * `hardware` is `null` on legacy reports (agents older than this feature): we
 * then still show what the report carries (OS, disks, agent identity) and tell
 * the user the detailed inventory will arrive at the next report.
 */
export function HardwareInfo({ report, device }: { report: DeviceReport | null; device: Device }) {
    if (!report) {
        return (
            <p>
                Aucun bilan reçu pour le moment. Les informations matérielles apparaîtront dès que l&apos;agent aura
                envoyé son premier rapport.
            </p>
        );
    }

    const hw = report.hardware;
    const interfaces = (hw?.network ?? [])
        .slice()
        .sort((a, b) => NET_KIND[a.kind].order - NET_KIND[b.kind].order || a.name.localeCompare(b.name));

    return (
        <div className={styles.hwContent}>
            <Group title='Système'>
                <Row label='Appareil' value={device.name} />
                <Row
                    label="Système d'exploitation"
                    value={`${report.os.name}${report.os.version ? ` ${report.os.version}` : ''}`}
                />
                <Row label='Architecture' value={report.os.arch} />
                <Row label='Plateforme' value={device.platform} />
            </Group>

            {hw ? (
                <>
                    <Group title='Processeur'>
                        <Row label='Modèle' value={hw.cpu.model} />
                        {hw.cpu.vendor && <Row label='Fabricant' value={hw.cpu.vendor} />}
                        <Row
                            label='Cœurs'
                            value={
                                hw.cpu.physicalCores != null
                                    ? `${hw.cpu.physicalCores} physiques · ${hw.cpu.logicalCores} logiques`
                                    : `${hw.cpu.logicalCores} logiques`
                            }
                        />
                        {hw.cpu.frequencyMhz != null && hw.cpu.frequencyMhz > 0 && (
                            <Row label='Fréquence' value={formatFreq(hw.cpu.frequencyMhz)} />
                        )}
                    </Group>

                    <Group title='Mémoire'>
                        <Row label='RAM totale' value={formatBytes(hw.memoryTotalBytes)} />
                    </Group>

                    {hw.gpus.length > 0 && (
                        <Group title={hw.gpus.length > 1 ? 'Cartes graphiques' : 'Carte graphique'}>
                            {hw.gpus.map((g, i) => (
                                <Row
                                    key={`${g}-${i}`}
                                    label={hw.gpus.length > 1 ? `GPU ${i + 1}` : 'Modèle'}
                                    value={g}
                                />
                            ))}
                        </Group>
                    )}

                    <Group title='Connectivité'>
                        {interfaces.length > 0 ? (
                            interfaces.map((n) => (
                                <Row
                                    key={n.name}
                                    label={`${NET_KIND[n.kind].label} · ${n.name}`}
                                    value={n.mac ?? '—'}
                                />
                            ))
                        ) : (
                            <Row label='Interfaces réseau' value='Aucune détectée' />
                        )}
                        <Row label='Bluetooth' value={hw.bluetooth ?? 'Non détecté'} />
                    </Group>
                </>
            ) : (
                <p className={styles.hwLegacyNote}>
                    L&apos;inventaire matériel détaillé (CPU, RAM, GPU, connectivité) n&apos;est pas disponible sur ce
                    rapport (agent antérieur à cette fonctionnalité). Il sera renseigné au prochain bilan.
                </p>
            )}

            {report.disks.length > 0 && (
                <Group title={report.disks.length > 1 ? 'Stockage' : 'Disque'}>
                    {report.disks.map((d) => (
                        <Row
                            key={d.mount}
                            label={d.mount}
                            value={`${formatBytes(d.usedBytes)} / ${formatBytes(d.totalBytes)} · ${pct(d.usedBytes, d.totalBytes).toFixed(0)}%`}
                        />
                    ))}
                </Group>
            )}

            <Group title='Agent'>
                {device.agentVersion && (
                    <Row
                        label='Version'
                        value={
                            agentUpdatable(device) ? (
                                <span
                                    className={styles.agentVersionWarn}
                                    title={
                                        device.latestAgentVersion
                                            ? `Version disponible : v${device.latestAgentVersion}`
                                            : undefined
                                    }
                                >
                                    <span className='icon icon-cloud' />v{device.agentVersion} · mise à jour disponible
                                </span>
                            ) : (
                                `v${device.agentVersion}`
                            )
                        }
                    />
                )}
                {report.agent && <Row label='Compte' value={report.agent.user || 'inconnu'} />}
                {report.agent && (
                    <Row
                        label='Privilèges'
                        value={report.agent.privileged ? (device.platform === 'windows' ? 'élevé' : 'root') : 'limité'}
                    />
                )}
                <Row label='Relevé le' value={new Date(report.collectedAt).toLocaleString('fr-FR')} />
            </Group>
        </div>
    );
}

import { useState } from 'react';
import { Button } from 'deveye-sdk-client';
import type { Device, DeviceReport, NetInterface, NetInterfaceKind } from '@deveye/types';

import { pct } from './utils';
import styles from './style.module.css';

/**
 * Human-readable bytes (binary units). Distinct de `utils.formatBytes` par un
 * palier : les capacités de disque atteignent le téraoctet.
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

/** Ce qu'une machine fabrique elle-même (ponts Docker, VPN, boucle locale) : replié par défaut. */
const FOLDED_KINDS: readonly NetInterfaceKind[] = ['virtual', 'loopback'];

/**
 * Les interfaces réseau, physiques d'abord. Les virtuelles se comptent par
 * dizaines sur un hôte Docker : repliées derrière un bouton, sauf quand il n'y
 * a qu'elles.
 */
function Connectivity({ interfaces, bluetooth }: { interfaces: NetInterface[]; bluetooth: string | null }) {
    const [showFolded, setShowFolded] = useState(false);
    const physical = interfaces.filter((n) => !FOLDED_KINDS.includes(n.kind));
    const folded = interfaces.filter((n) => FOLDED_KINDS.includes(n.kind));
    const foldable = physical.length > 0 && folded.length > 0;
    const shown = foldable && !showFolded ? physical : interfaces;

    return (
        <section className={styles.hwGroup}>
            <h4 className={styles.hwGroupTitle}>Connectivité</h4>
            <dl className={styles.hwRows}>
                {shown.length > 0 ? (
                    shown.map((n) => (
                        <Row key={n.name} label={`${NET_KIND[n.kind].label} · ${n.name}`} value={n.mac ?? '—'} />
                    ))
                ) : (
                    <Row label='Interfaces réseau' value='Aucune détectée' />
                )}
                <Row label='Bluetooth' value={bluetooth ?? 'Non détecté'} />
            </dl>
            {foldable && (
                <div>
                    <Button variant='ghost' onClick={() => setShowFolded((v) => !v)}>
                        {showFolded
                            ? 'Masquer les interfaces virtuelles'
                            : `Afficher ${folded.length} interface${folded.length > 1 ? 's' : ''} virtuelle${folded.length > 1 ? 's' : ''}`}
                    </Button>
                </div>
            )}
        </section>
    );
}

/**
 * Body of the per-device hardware dialog: the static inventory the agent
 * reports. `hardware` is `null` on legacy reports: what the report carries is
 * still shown. What the agent itself is lives in the « Agent » popup.
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

                    <Connectivity interfaces={interfaces} bluetooth={hw.bluetooth} />
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
        </div>
    );
}

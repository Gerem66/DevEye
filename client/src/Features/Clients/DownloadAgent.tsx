import { useEffect, useMemo, useState } from 'react';
import { get } from '@/api/http';
import { Dialog } from '@/Components/Dialog';
import Button from '@/Components/Button';
import { AGENT_TARGETS, agentTargetsResponseSchema, type AgentOs, type AgentTargetStatus } from 'deveye-types';
import { APP_VERSION } from '../agentVersion';
import styles from './Clients.module.css';

/** OS families in picker order, with their display label + tagline. */
const OS_GROUPS: { os: AgentOs; label: string; hint: string }[] = [
    { os: 'macos', label: 'Apple', hint: 'macOS — Intel & Silicon' },
    { os: 'linux', label: 'Linux', hint: 'x64, ARM64, Raspberry Pi' },
    { os: 'windows', label: 'Windows', hint: 'x64, x86, ARM64' }
];

/** Human-readable file size (binaries are a few MB). */
function formatSize(bytes: number | null): string {
    if (bytes === null) return '';
    const mb = bytes / (1024 * 1024);
    if (mb >= 1) return `${mb.toFixed(1)} Mo`;
    return `${Math.max(1, Math.round(bytes / 1024))} Ko`;
}

/**
 * Two-step "Télécharger l'agent" picker: pick an OS (Apple / Linux / Windows),
 * then the exact architecture. Availability comes from `/api/agent/targets` so
 * targets whose binary isn't shipped are shown disabled. The download itself is
 * a plain authenticated GET (the session cookie rides along, same origin).
 */
export function DownloadAgent({ open, onClose }: { open: boolean; onClose: () => void }) {
    const [os, setOs] = useState<AgentOs | null>(null);
    const [statuses, setStatuses] = useState<AgentTargetStatus[]>([]);
    const [agentVersion, setAgentVersion] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Reset to the OS step and (re)load availability each time the dialog opens.
    useEffect(() => {
        if (!open) return;
        setOs(null);
        setError(null);
        setLoading(true);
        get('/api/agent/targets', agentTargetsResponseSchema)
            .then((res) => {
                setStatuses(res.targets);
                setAgentVersion(res.agentVersion);
            })
            .catch(() => setError('Impossible de récupérer les versions disponibles.'))
            .finally(() => setLoading(false));
    }, [open]);

    // id -> availability, to merge onto the static AGENT_TARGETS metadata.
    const statusById = useMemo(() => new Map(statuses.map((s) => [s.id, s])), [statuses]);

    // Make sure, at download time, the agent matches the running DevEye version.
    const versionMismatch = agentVersion !== null && agentVersion !== APP_VERSION;

    const title = os ? `Agent — ${OS_GROUPS.find((g) => g.os === os)?.label}` : "Télécharger l'agent";

    return (
        <Dialog
            open={open}
            onClose={onClose}
            title={title}
            description={
                os
                    ? 'Choisissez la version correspondant à votre processeur.'
                    : "Choisissez le système de l'appareil à monitorer."
            }
            width={440}
            headerAction={
                os ? (
                    <button className={styles.iconBtn} onClick={() => setOs(null)} title='Retour' aria-label='Retour'>
                        <span className='icon icon-arrow-left' />
                    </button>
                ) : undefined
            }
            footer={
                <Button variant='secondary' onClick={onClose}>
                    Fermer
                </Button>
            }
        >
            {error && <p className={styles.genError}>{error}</p>}

            {agentVersion !== null &&
                (versionMismatch ? (
                    <p className={`${styles.agentVersion} ${styles.agentVersionWarn}`}>
                        <span className='icon icon-info' />
                        Agent v{agentVersion} — différent de l’interface (v{APP_VERSION}). Une nouvelle version est
                        peut-être en cours de déploiement.
                    </p>
                ) : (
                    <p className={styles.agentVersion}>Version de l’agent : v{agentVersion}</p>
                ))}

            {os === null ? (
                <div className={styles.osGrid}>
                    {OS_GROUPS.map((g) => (
                        <button key={g.os} className={styles.osTile} onClick={() => setOs(g.os)}>
                            <span className={styles.osName}>{g.label}</span>
                            <span className={styles.osHint}>{g.hint}</span>
                            <span className={`icon icon-chevron ${styles.osChevron}`} />
                        </button>
                    ))}
                </div>
            ) : (
                <div className={styles.archList}>
                    {AGENT_TARGETS.filter((t) => t.os === os).map((t) => {
                        const status = statusById.get(t.id);
                        const available = status?.available ?? false;
                        return (
                            <a
                                key={t.id}
                                className={`${styles.archRow} ${available ? '' : styles.archRowDisabled}`}
                                href={available ? `/api/agent/download/${t.id}` : undefined}
                                download={available ? t.filename : undefined}
                                aria-disabled={!available}
                                onClick={(e) => {
                                    if (!available) e.preventDefault();
                                }}
                            >
                                <span className={styles.archLabel}>{t.label}</span>
                                {loading && !status ? (
                                    <span className={styles.archMeta}>…</span>
                                ) : available ? (
                                    <span className={styles.archMeta}>{formatSize(status?.sizeBytes ?? null)}</span>
                                ) : (
                                    <span className={styles.archMeta}>Indisponible</span>
                                )}
                            </a>
                        );
                    })}
                </div>
            )}
        </Dialog>
    );
}

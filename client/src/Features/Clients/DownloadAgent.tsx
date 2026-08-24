import { useEffect, useMemo, useState } from 'react';
import { ensureFreshAccess, get } from '@/api/http';
import { Dialog } from '@/Components/Dialog';
import Button from '@/Components/Button';
import {
    AGENT_TARGETS,
    agentTargetsResponseSchema,
    compareVersions,
    type AgentOs,
    type AgentTargetStatus
} from '@deveye/types';
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
    /** Cible en cours de téléchargement (un seul à la fois suffit largement). */
    const [downloading, setDownloading] = useState<string | null>(null);

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

    /**
     * Télécharge un binaire, en récupérant d'abord un cookie d'accès frais.
     *
     * Le lien `<a href download>` d'origine était une NAVIGATION, pas un `fetch` :
     * elle échappait entièrement au client HTTP, donc au rejeu sur 401. Passé le
     * quart d'heure de vie du cookie, le navigateur enregistrait sagement
     * l'enveloppe JSON du 401 sous le nom du binaire — un fichier corrompu, sans
     * le moindre message. On passe donc par `fetch`, ce qui permet de VÉRIFIER la
     * réponse avant d'enregistrer quoi que ce soit ; l'ancre n'est plus qu'un
     * moyen de déclencher l'enregistrement du blob obtenu.
     */
    const download = async (id: string, filename: string) => {
        setError(null);
        setDownloading(id);
        try {
            await ensureFreshAccess();
            const res = await fetch(`/api/agent/download/${id}`, { credentials: 'include' });
            if (!res.ok) {
                setError(
                    res.status === 404
                        ? 'Binaire indisponible pour cette plateforme sur ce serveur.'
                        : `Téléchargement refusé par le serveur (${res.status}).`
                );
                return;
            }
            const blob = await res.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            a.click();
            // Révoqué au tour suivant : révoquer tout de suite couperait
            // l'enregistrement que le clic vient à peine de lancer.
            setTimeout(() => URL.revokeObjectURL(url), 0);
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Téléchargement impossible.');
        } finally {
            setDownloading(null);
        }
    };

    // Make sure, at download time, the agent matches the running DevEye version.
    // The *direction* of the gap decides the message: a served set NEWER than this
    // interface is a deploy still rolling out (transient, wait it out), whereas a
    // served set OLDER is a stale `agent/dist` — the boot sync never replaced it,
    // so the binaries offered here are frozen and nothing will fix that on its own.
    const versionGap = agentVersion === null ? 0 : compareVersions(agentVersion, APP_VERSION);
    const servedStale = versionGap < 0;
    const versionMismatch = versionGap !== 0;

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
                        {servedStale ? (
                            <>
                                Agent v{agentVersion} — en retard sur l’interface (v{APP_VERSION}). Les binaires
                                proposés ici sont périmés : vérifiez la synchronisation des agents (AGENT_REPO / jeton
                                de téléchargement).
                            </>
                        ) : (
                            <>
                                Agent v{agentVersion} — différent de l’interface (v{APP_VERSION}). Une nouvelle version
                                est peut-être en cours de déploiement.
                            </>
                        )}
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
                            <button
                                key={t.id}
                                type='button'
                                className={`${styles.archRow} ${available ? '' : styles.archRowDisabled}`}
                                disabled={!available || downloading !== null}
                                onClick={() => void download(t.id, t.filename)}
                            >
                                <span className={styles.archLabel}>{t.label}</span>
                                {downloading === t.id ? (
                                    <span className={styles.archMeta}>Téléchargement…</span>
                                ) : loading && !status ? (
                                    <span className={styles.archMeta}>…</span>
                                ) : available ? (
                                    <span className={styles.archMeta}>{formatSize(status?.sizeBytes ?? null)}</span>
                                ) : (
                                    <span className={styles.archMeta}>Indisponible</span>
                                )}
                            </button>
                        );
                    })}
                </div>
            )}
        </Dialog>
    );
}

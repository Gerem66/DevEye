import { useCallback, useEffect, useState } from 'react';
import {
    CLOUD_SYNC_CHUNK_EVENT,
    type CloudSyncChunkPush,
    type CloudSyncShare,
    type CloudSyncVersion,
    type SyncVersionSort
} from 'deveye-types';

import { ws } from '@/api/ws';
import { Button, Dialog, SelectInput } from '@/Components';
import { OpenPopup } from '@/Components/Popup';
import { formatBytesFr } from '@/Features/Monitoring/utils';
import { CLOUDSYNC_CONFIRM_POPUP, type ConfirmInput } from './ConfirmPopup';
import styles from './style.module.css';

interface VersionsBrowserProps {
    open: boolean;
    share: CloudSyncShare;
    onClose: () => void;
    onChanged: () => void;
}

const PAGE = 50;

const SORT_LABELS: Record<SyncVersionSort, string> = {
    newest: 'Plus récentes',
    oldest: 'Plus anciennes',
    largest: 'Plus volumineuses',
    path: 'Chemin (A → Z)'
};

const REASON_LABELS: Record<CloudSyncVersion['reason'], string> = {
    overwrite: 'Écrasé',
    delete: 'Supprimé',
    conflict: 'Conflit',
    restore: 'Remplacé par une restauration',
    excluded: 'Exclu du cloud'
};

/** Télécharge un blob poussé en frames `cloudSync.chunk` et le sauvegarde. */
function downloadChunks(opId: string, fileName: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const parts: Uint8Array[] = [];
        const off = ws.onMessage((msg) => {
            if (msg.command !== CLOUD_SYNC_CHUNK_EVENT || !msg.payload.ok) return;
            const d = msg.payload.data as CloudSyncChunkPush;
            if (d.opId !== opId) return;
            if (d.data.length > 0) {
                parts.push(Uint8Array.from(atob(d.data), (c) => c.charCodeAt(0)));
            }
            if (d.done) {
                off();
                if (d.error) {
                    reject(new Error(d.error));
                    return;
                }
                const url = URL.createObjectURL(new Blob(parts as BlobPart[]));
                const a = document.createElement('a');
                a.href = url;
                a.download = fileName;
                a.click();
                URL.revokeObjectURL(url);
                resolve();
            }
        });
    });
}

/**
 * Les sauvegardes (corbeille) d'un partage : liste paginée et triable avec
 * volumétrie, restauration, téléchargement, suppression à l'unité ou en masse.
 */
export default function VersionsBrowser({ open, share, onClose, onChanged }: VersionsBrowserProps) {
    const [versions, setVersions] = useState<CloudSyncVersion[]>([]);
    const [total, setTotal] = useState(0);
    const [totalBytes, setTotalBytes] = useState(0);
    const [offset, setOffset] = useState(0);
    const [sort, setSort] = useState<SyncVersionSort>('newest');
    const [busyId, setBusyId] = useState<number | null>(null);
    const [bulkBusy, setBulkBusy] = useState(false);
    const [selected, setSelected] = useState<Set<number>>(new Set());
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(
        async (nextOffset: number) => {
            try {
                const out = await ws.send('cloudSync.listVersions', {
                    shareId: share.id,
                    sort,
                    limit: PAGE,
                    offset: nextOffset
                });
                // Page devenue vide après une suppression : recule d'une page.
                if (out.versions.length === 0 && nextOffset > 0) {
                    return load(Math.max(0, Math.min(nextOffset, out.total) - PAGE));
                }
                setVersions(out.versions);
                setTotal(out.total);
                setTotalBytes(out.totalBytes);
                setOffset(nextOffset);
                // La sélection est propre à la page affichée (borne les ids envoyés).
                setSelected(new Set());
            } catch (e) {
                setError(e instanceof Error ? e.message : 'Chargement impossible.');
            }
        },
        [share.id, sort]
    );

    const toggle = (id: number): void => {
        setSelected((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    const allOnPageSelected = versions.length > 0 && versions.every((v) => selected.has(v.id));
    const toggleAll = (): void => setSelected(allOnPageSelected ? new Set() : new Set(versions.map((v) => v.id)));

    const bulk = async (label: string, message: string, action: () => Promise<unknown>): Promise<void> => {
        const ok = await OpenPopup<boolean>(CLOUDSYNC_CONFIRM_POPUP, {
            title: label,
            message,
            confirmLabel: 'Supprimer'
        } as ConfirmInput);
        if (ok !== true) return;
        setBulkBusy(true);
        setError(null);
        try {
            await action();
            await load(0);
            onChanged();
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Suppression impossible.');
        } finally {
            setBulkBusy(false);
        }
    };

    const deleteSelection = (): Promise<void> =>
        bulk(
            'Supprimer la sélection',
            `Supprimer définitivement ${selected.size} sauvegarde(s) ? Cette action est irréversible.`,
            () => ws.send('cloudSync.deleteVersions', { shareId: share.id, versionIds: [...selected] })
        );

    const clearAll = (): Promise<void> =>
        bulk(
            'Vider la corbeille',
            `Supprimer définitivement les ${total} sauvegarde(s) de « ${share.name} » ? Cette action est irréversible.`,
            () => ws.send('cloudSync.clearVersions', { shareId: share.id })
        );

    useEffect(() => {
        if (open) void load(0);
    }, [open, load]);

    const act = async (versionId: number, action: () => Promise<unknown>) => {
        setBusyId(versionId);
        setError(null);
        try {
            await action();
            await load(offset);
            onChanged();
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Action impossible.');
        } finally {
            setBusyId(null);
        }
    };

    const download = async (version: CloudSyncVersion) => {
        setBusyId(version.id);
        setError(null);
        try {
            const opId = crypto.randomUUID();
            const done = downloadChunks(opId, version.relPath.split('/').pop() ?? 'fichier');
            await ws.send('cloudSync.downloadVersion', { versionId: version.id, opId });
            await done;
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Téléchargement impossible.');
        } finally {
            setBusyId(null);
        }
    };

    return (
        <Dialog
            open={open}
            onClose={onClose}
            title={`Sauvegardes — ${share.name}`}
            description={`${total} sauvegarde(s) archivée(s) · ${formatBytesFr(totalBytes)}`}
            width={640}
            tall
        >
            <div className={styles.browserCol}>
                {versions.length > 0 && (
                    <div className={styles.selectBar}>
                        <label className={styles.checkRow}>
                            <input
                                type='checkbox'
                                className={styles.checkbox}
                                checked={allOnPageSelected}
                                onChange={toggleAll}
                            />
                            <span className={styles.rowSub}>Tout sélectionner</span>
                        </label>
                        <span className={styles.selectBarSpacer} />
                        <SelectInput
                            className={styles.sortSelect}
                            value={sort}
                            onChange={(e) => setSort(e.target.value as SyncVersionSort)}
                            title='Ordre de tri'
                        >
                            {(Object.keys(SORT_LABELS) as SyncVersionSort[]).map((s) => (
                                <option key={s} value={s}>
                                    {SORT_LABELS[s]}
                                </option>
                            ))}
                        </SelectInput>
                        {/* Un seul bouton, qui suit la sélection : rien de coché =
                            vider toute la corbeille ; coché = la sélection seule. */}
                        <Button
                            variant='danger'
                            icon='trash'
                            className={styles.bulkDelete}
                            disabled={bulkBusy}
                            onClick={() => void (selected.size > 0 ? deleteSelection() : clearAll())}
                        >
                            {selected.size > 0 ? `Supprimer la sélection (${selected.size})` : 'Tout supprimer'}
                        </Button>
                    </div>
                )}
                <div className={`${styles.rows} ${styles.scrollRows}`}>
                    {versions.map((v) => (
                        <div key={v.id} className={styles.row}>
                            <input
                                type='checkbox'
                                className={styles.checkbox}
                                checked={selected.has(v.id)}
                                onChange={() => toggle(v.id)}
                                aria-label='Sélectionner cette sauvegarde'
                            />
                            <div className={styles.rowMain}>
                                <span className={styles.rowTitle}>{v.relPath}</span>
                                <span className={styles.rowSub}>
                                    {REASON_LABELS[v.reason]} · {formatBytesFr(v.size)} ·{' '}
                                    {new Date(v.created * 1000).toLocaleString('fr-FR')}
                                    {v.sourceDeviceName ? ` · depuis ${v.sourceDeviceName}` : ''}
                                </span>
                            </div>
                            <div className={styles.rowActions}>
                                <Button
                                    variant='ghost'
                                    icon='download'
                                    title='Télécharger cette sauvegarde'
                                    disabled={busyId === v.id}
                                    onClick={() => void download(v)}
                                />
                                <Button
                                    variant='ghost'
                                    icon='restart'
                                    title='Restaurer comme contenu courant'
                                    disabled={busyId === v.id}
                                    onClick={() =>
                                        void (async () => {
                                            const ok = await OpenPopup<boolean>(CLOUDSYNC_CONFIRM_POPUP, {
                                                title: 'Restaurer cette sauvegarde',
                                                message: `Restaurer « ${v.relPath} » à cette sauvegarde ? Le contenu actuel sera archivé (rien n'est perdu).`,
                                                confirmLabel: 'Restaurer'
                                            } as ConfirmInput);
                                            if (ok === true) {
                                                await act(v.id, () =>
                                                    ws.send('cloudSync.restoreVersion', { versionId: v.id })
                                                );
                                            }
                                        })()
                                    }
                                />
                                <Button
                                    variant='ghost'
                                    icon='trash'
                                    title='Supprimer définitivement cette sauvegarde'
                                    disabled={busyId === v.id}
                                    onClick={() =>
                                        void (async () => {
                                            const ok = await OpenPopup<boolean>(CLOUDSYNC_CONFIRM_POPUP, {
                                                title: 'Supprimer la sauvegarde',
                                                message: `Supprimer définitivement cette sauvegarde de « ${v.relPath} » ? Cette action est irréversible.`,
                                                confirmLabel: 'Supprimer'
                                            } as ConfirmInput);
                                            if (ok === true) {
                                                await act(v.id, () =>
                                                    ws.send('cloudSync.deleteVersion', { versionId: v.id })
                                                );
                                            }
                                        })()
                                    }
                                />
                            </div>
                        </div>
                    ))}
                    {versions.length === 0 && (
                        <div className={styles.mutedNote}>
                            Aucune sauvegarde archivée — elles apparaissent au premier écrasement, conflit ou
                            suppression.
                        </div>
                    )}
                </div>
                {total > PAGE && (
                    <div className={styles.actions}>
                        <Button
                            variant='secondary'
                            disabled={offset === 0}
                            onClick={() => void load(Math.max(0, offset - PAGE))}
                        >
                            Précédent
                        </Button>
                        <span className={styles.mutedNote}>
                            {offset + 1}–{Math.min(offset + PAGE, total)} sur {total}
                        </span>
                        <Button
                            variant='secondary'
                            disabled={offset + PAGE >= total}
                            onClick={() => void load(offset + PAGE)}
                        >
                            Suivant
                        </Button>
                    </div>
                )}
                {error && <div className={styles.mutedNote}>{error}</div>}
            </div>
        </Dialog>
    );
}

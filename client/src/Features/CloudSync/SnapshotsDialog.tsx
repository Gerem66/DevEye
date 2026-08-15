import { useCallback, useEffect, useState } from 'react';
import type { CloudSyncShare, CloudSyncSnapshot, CloudSyncSnapshotDiff } from 'deveye-types';

import { ws } from '@/api/ws';
import { Button, Dialog } from '@/Components';
import { OpenPopup } from '@/Components/Popup';
import { formatBytesFr } from '@/Features/Monitoring/utils';
import { CLOUDSYNC_CONFIRM_POPUP } from './ConfirmPopup';
import styles from './style.module.css';

interface SnapshotsDialogProps {
    open: boolean;
    share: CloudSyncShare;
    onClose: () => void;
    onChanged: () => void;
}

const PAGE = 50;

const KIND_LABEL: Record<CloudSyncSnapshot['kind'], string> = {
    auto: 'Automatique',
    manual: 'Manuel',
    preRestore: 'Avant restauration'
};

/**
 * Les points de restauration du partage ENTIER. Là où « Sauvegardes » rend un
 * fichier d'avant, ceci remet tout le dossier dans l'état d'un instant donné.
 *
 * La restauration n'est jamais lancée à l'aveugle : on demande d'abord au
 * serveur ce qu'elle changerait, et on affiche ces chiffres dans la
 * confirmation. Elle reste par ailleurs annulable (un point de retour est pris
 * juste avant), ce que la confirmation dit explicitement.
 */
export default function SnapshotsDialog({ open, share, onClose, onChanged }: SnapshotsDialogProps) {
    const [snapshots, setSnapshots] = useState<CloudSyncSnapshot[]>([]);
    const [total, setTotal] = useState(0);
    const [offset, setOffset] = useState(0);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [note, setNote] = useState<string | null>(null);

    const load = useCallback(
        async (nextOffset: number) => {
            try {
                const out = await ws.send('cloudSync.listSnapshots', {
                    shareId: share.id,
                    limit: PAGE,
                    offset: nextOffset
                });
                setSnapshots(out.snapshots);
                setTotal(out.total);
                setOffset(nextOffset);
                setError(null);
            } catch (e) {
                setError(e instanceof Error ? e.message : 'Chargement impossible.');
            }
        },
        [share.id]
    );

    useEffect(() => {
        if (open) void load(0);
    }, [open, load]);

    async function createNow() {
        setBusy(true);
        try {
            await ws.send('cloudSync.createSnapshot', { shareId: share.id });
            setNote('Point de restauration créé.');
            await load(0);
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Création impossible.');
        } finally {
            setBusy(false);
        }
    }

    function describe(diff: CloudSyncSnapshotDiff): string {
        if (diff.missingBlobs > 0) {
            return `${diff.missingBlobs} contenu(s) de ce point de restauration ont disparu du stockage : la restauration est impossible.`;
        }
        const parts: string[] = [];
        if (diff.restored > 0) parts.push(`${diff.restored} fichier(s) rétabli(s)`);
        if (diff.removed > 0) parts.push(`${diff.removed} fichier(s) créé(s) depuis seront retirés`);
        if (parts.length === 0) return 'Le partage est déjà exactement dans cet état : rien à faire.';
        return `${parts.join(', ')}. ${diff.unchanged} fichier(s) déjà identiques.\n\nRien n'est perdu : les fichiers retirés partent dans les Sauvegardes, et un point de retour est créé juste avant — l'opération reste annulable.`;
    }

    async function restore(snapshot: CloudSyncSnapshot) {
        setBusy(true);
        setNote(null);
        try {
            // Demander d'abord CE QUE ÇA CHANGE : une restauration de dossier
            // entier ne se confirme pas à l'aveugle.
            const { diff } = await ws.send('cloudSync.diffSnapshot', { snapshotId: snapshot.id });
            if (diff.missingBlobs > 0 || (diff.restored === 0 && diff.removed === 0)) {
                setError(describe(diff));
                return;
            }
            const stamp = new Date(snapshot.created * 1000).toLocaleString('fr-FR');
            const ok = await OpenPopup<boolean>(CLOUDSYNC_CONFIRM_POPUP, {
                title: `Restaurer l'état du ${stamp}`,
                message: describe(diff),
                confirmLabel: 'Restaurer'
            });
            if (!ok) return;

            const out = await ws.send('cloudSync.restoreSnapshot', { snapshotId: snapshot.id });
            setError(null);
            setNote(
                `Partage restauré (${out.restored} rétabli(s), ${out.removed} retiré(s)). Les appareils se mettent à jour. Pour annuler, restaure le point « Avant restauration » en tête de liste.`
            );
            await load(0);
            onChanged();
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Restauration impossible.');
        } finally {
            setBusy(false);
        }
    }

    /**
     * Relit TOUS les contenus du partage et vérifie leurs scellés. Long par
     * nature, d'où le passage à la demande ; le balayage de fond fait la même
     * chose par petits budgets horaires quand il est activé.
     */
    async function verify() {
        setBusy(true);
        setNote('Vérification en cours…');
        setError(null);
        try {
            const out = await ws.send('cloudSync.verifyIntegrity', { shareId: share.id });
            if (out.corrupted === 0) {
                setNote(`${out.checked} contenu(s) vérifiés, tous intacts.`);
            } else if (out.corrupted === out.repaired) {
                setNote(
                    `${out.corrupted} contenu(s) abîmé(s) détecté(s) et TOUS réparés depuis un appareil. Rien n’est perdu.`
                );
            } else {
                setNote(null);
                setError(
                    `${out.corrupted} contenu(s) abîmé(s), dont ${out.repaired} réparé(s). Les autres ne sont détenus par aucun appareil en ligne : rebranche l’appareil qui les a, ou dépose-les à nouveau. Voir les Logs.`
                );
            }
        } catch (e) {
            setNote(null);
            setError(e instanceof Error ? e.message : 'Vérification impossible.');
        } finally {
            setBusy(false);
        }
    }

    async function remove(snapshot: CloudSyncSnapshot) {
        const stamp = new Date(snapshot.created * 1000).toLocaleString('fr-FR');
        const ok = await OpenPopup<boolean>(CLOUDSYNC_CONFIRM_POPUP, {
            title: 'Supprimer ce point de restauration',
            message: `Le point du ${stamp} sera supprimé. Les fichiers du partage ne bougent pas, mais on ne pourra plus revenir à cet instant précis.`,
            confirmLabel: 'Supprimer'
        });
        if (!ok) return;
        setBusy(true);
        try {
            await ws.send('cloudSync.deleteSnapshot', { snapshotId: snapshot.id });
            await load(offset);
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Suppression impossible.');
        } finally {
            setBusy(false);
        }
    }

    return (
        <Dialog
            open={open}
            onClose={onClose}
            title={`Points de restauration — ${share.name}`}
            description={
                total === 0
                    ? 'Aucun point de restauration pour l’instant.'
                    : `${total} point(s) — reviens à l’état exact du dossier à un instant donné.`
            }
            width={680}
            tall
        >
            <div className={styles.browserCol}>
                <div className={styles.actions}>
                    <Button variant='secondary' icon='add' disabled={busy} onClick={() => void createNow()}>
                        Créer un point maintenant
                    </Button>
                    <Button variant='ghost' icon='shield' disabled={busy} onClick={() => void verify()}>
                        Vérifier l’intégrité
                    </Button>
                </div>

                <div className={`${styles.rows} ${styles.scrollRows}`}>
                    {snapshots.map((snap) => (
                        <div key={snap.id} className={styles.row}>
                            <span className={`icon icon-clock ${styles.logIcon}`} />
                            <div className={styles.rowMain}>
                                <span className={styles.rowTitle}>
                                    {new Date(snap.created * 1000).toLocaleString('fr-FR')}
                                    {snap.label ? ` — ${snap.label}` : ''}
                                </span>
                                <span className={styles.rowSub}>
                                    {KIND_LABEL[snap.kind]} · {snap.fileCount} fichier(s) ·{' '}
                                    {formatBytesFr(snap.totalBytes)}
                                </span>
                            </div>
                            <Button variant='secondary' disabled={busy} onClick={() => void restore(snap)}>
                                Restaurer
                            </Button>
                            <Button variant='ghost' icon='trash' disabled={busy} onClick={() => void remove(snap)} />
                        </div>
                    ))}
                    {snapshots.length === 0 && (
                        <div className={styles.mutedNote}>
                            Les points de restauration sont pris automatiquement selon la cadence réglée dans « Réglages
                            ». Ils ne consomment quasiment aucun espace : seul l’inventaire du dossier est enregistré,
                            les contenus étant déjà partagés avec les sauvegardes.
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
                {note && <div className={styles.mutedNote}>{note}</div>}
                {error && <div className={styles.mutedNote}>{error}</div>}
            </div>
        </Dialog>
    );
}

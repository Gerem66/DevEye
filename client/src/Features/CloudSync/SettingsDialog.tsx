import { useEffect, useId, useState } from 'react';
import type { CloudSyncShare, SyncConflictPolicy } from 'deveye-types';

import { ws } from '@/api/ws';
import { Button, Dialog, SelectInput, TextInput } from '@/Components';
import { OpenPopup } from '@/Components/Popup';
import { CLOUDSYNC_CONFIRM_POPUP, type ConfirmInput } from './ConfirmPopup';
import NumberField from './NumberField';
import styles from './style.module.css';

interface SettingsDialogProps {
    open: boolean;
    share: CloudSyncShare;
    onClose: () => void;
    onChanged: () => void;
    /** Appelé après suppression du partage (la vue parente se rafraîchit). */
    onDeleted: () => void;
}

const GIB = 1024 * 1024 * 1024;

/** Réglages d'un partage : nom, purge auto des versions, suppression. */
export default function SettingsDialog({ open, share, onClose, onChanged, onDeleted }: SettingsDialogProps) {
    const [name, setName] = useState(share.name);
    const [conflictPolicy, setConflictPolicy] = useState<SyncConflictPolicy>(share.conflictPolicy);
    const [pruneEnabled, setPruneEnabled] = useState(share.backupPruneEnabled);
    const [limitGb, setLimitGb] = useState(
        share.backupLimitBytes === null ? '' : String(Math.round(share.backupLimitBytes / GIB))
    );
    const [error, setError] = useState<string | null>(null);
    // Associe le label au champ : cliquer le texte donne le focus au champ,
    // sans jamais activer le bouton « − » du NumberField (voir NumberField).
    const limitFieldId = useId();

    useEffect(() => {
        if (!open) return;
        setName(share.name);
        setConflictPolicy(share.conflictPolicy);
        setPruneEnabled(share.backupPruneEnabled);
        setLimitGb(share.backupLimitBytes === null ? '' : String(Math.round(share.backupLimitBytes / GIB)));
        setError(null);
    }, [open, share]);

    const save = async () => {
        setError(null);
        const parsed = Number(limitGb);
        const backupLimitBytes = limitGb.trim() === '' || !Number.isFinite(parsed) ? null : Math.round(parsed * GIB);
        if (pruneEnabled && (backupLimitBytes === null || backupLimitBytes <= 0)) {
            setError('La purge automatique exige une taille limite (en Go).');
            return;
        }
        try {
            await ws.send('cloudSync.updateShare', {
                shareId: share.id,
                name: name.trim(),
                backupPruneEnabled: pruneEnabled,
                backupLimitBytes,
                conflictPolicy
            });
            onChanged();
            onClose();
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Enregistrement impossible.');
        }
    };

    const remove = async () => {
        const ok = await OpenPopup<boolean>(CLOUDSYNC_CONFIRM_POPUP, {
            title: 'Supprimer le partage',
            message: `Supprimer « ${share.name} » ? Les fichiers locaux des appareils restent intacts ; le stockage serveur (fichiers + versions) sera définitivement effacé.`,
            confirmLabel: 'Supprimer'
        } as ConfirmInput);
        if (ok !== true) return;
        try {
            await ws.send('cloudSync.deleteShare', { shareId: share.id, deleteData: true });
            onDeleted();
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Suppression impossible.');
        }
    };

    return (
        <Dialog
            open={open}
            onClose={onClose}
            title={`Réglages — ${share.name}`}
            width={520}
            onSubmit={() => void save()}
            footer={
                <>
                    <Button variant='secondary' onClick={onClose}>
                        Annuler
                    </Button>
                    <Button disabled={name.trim() === ''} onClick={() => void save()}>
                        Enregistrer
                    </Button>
                </>
            }
        >
            <div className={styles.formCol}>
                <label className={styles.field}>
                    Nom du partage
                    <TextInput value={name} onChange={(e) => setName(e.target.value)} />
                </label>
                <div className={styles.mutedNote}>Stockage serveur : {share.storagePath}</div>
                <label className={styles.field}>
                    En cas de conflit (fichier modifié sur deux appareils)
                    <SelectInput
                        value={conflictPolicy}
                        onChange={(e) => setConflictPolicy(e.target.value as SyncConflictPolicy)}
                    >
                        <option value='newest'>Garder le plus récent (l’autre part en version)</option>
                        <option value='rename'>Garder les deux (l’autre est renommé « conflit … »)</option>
                    </SelectInput>
                </label>
                <label className={styles.checkRow}>
                    <input
                        type='checkbox'
                        className={styles.checkbox}
                        checked={pruneEnabled}
                        onChange={(e) => setPruneEnabled(e.target.checked)}
                    />
                    <span className={styles.rowTitle}>
                        Purger automatiquement les sauvegardes les plus anciennes au-delà d’une limite
                    </span>
                </label>
                {pruneEnabled && (
                    <label className={styles.field} htmlFor={limitFieldId}>
                        Limite des sauvegardes (Go)
                        <NumberField id={limitFieldId} min={1} placeholder='50' value={limitGb} onChange={setLimitGb} />
                    </label>
                )}
                {error && <div className={styles.mutedNote}>{error}</div>}
                <div className={styles.dangerZone}>
                    <span className={styles.mutedNote}>Détache tous les appareils et efface le stockage serveur.</span>
                    <Button variant='danger' icon='trash' onClick={() => void remove()}>
                        Supprimer le partage
                    </Button>
                </div>
            </div>
        </Dialog>
    );
}

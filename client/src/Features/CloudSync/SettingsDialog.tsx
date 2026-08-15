import { useEffect, useId, useState } from 'react';
import type { CloudSyncShare, SyncConflictPolicy } from 'deveye-types';

import { ws } from '@/api/ws';
import { Button, Checkbox, Dialog, SelectInput, TextInput } from '@/Components';
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
/** Les débits se saisissent en Mo/s : personne ne règle une limite en octets. */
const MBPS = 1024 * 1024;

const toMbps = (bps: number | null): string => (bps === null ? '' : String(Math.round((bps / MBPS) * 10) / 10));
const fromMbps = (text: string): number | null => {
    const value = Number(text);
    return text.trim() === '' || !Number.isFinite(value) || value <= 0 ? null : Math.round(value * MBPS);
};

/** Réglages d'un partage : nom, purge auto des versions, suppression. */
export default function SettingsDialog({ open, share, onClose, onChanged, onDeleted }: SettingsDialogProps) {
    const [name, setName] = useState(share.name);
    const [conflictPolicy, setConflictPolicy] = useState<SyncConflictPolicy>(share.conflictPolicy);
    const [pruneEnabled, setPruneEnabled] = useState(share.backupPruneEnabled);
    const [limitGb, setLimitGb] = useState(
        share.backupLimitBytes === null ? '' : String(Math.round(share.backupLimitBytes / GIB))
    );
    const [snapshotEnabled, setSnapshotEnabled] = useState(share.snapshotEnabled);
    const [snapshotHours, setSnapshotHours] = useState(String(share.snapshotIntervalHours));
    const [snapshotDays, setSnapshotDays] = useState(String(share.snapshotKeepDays));
    const [integrityScan, setIntegrityScan] = useState(share.integrityScanEnabled);
    const [upMbps, setUpMbps] = useState(toMbps(share.rateUpBps));
    const [downMbps, setDownMbps] = useState(toMbps(share.rateDownBps));
    const [trashDays, setTrashDays] = useState(String(share.trashKeepDays));
    const [error, setError] = useState<string | null>(null);
    // Associe le label au champ : cliquer le texte donne le focus au champ,
    // sans jamais activer le bouton « − » du NumberField (voir NumberField).
    const limitFieldId = useId();
    const snapshotHoursId = useId();
    const snapshotDaysId = useId();
    const downFieldId = useId();
    const upFieldId = useId();
    const trashFieldId = useId();

    useEffect(() => {
        if (!open) return;
        setName(share.name);
        setConflictPolicy(share.conflictPolicy);
        setPruneEnabled(share.backupPruneEnabled);
        setLimitGb(share.backupLimitBytes === null ? '' : String(Math.round(share.backupLimitBytes / GIB)));
        setSnapshotEnabled(share.snapshotEnabled);
        setSnapshotHours(String(share.snapshotIntervalHours));
        setSnapshotDays(String(share.snapshotKeepDays));
        setIntegrityScan(share.integrityScanEnabled);
        setUpMbps(toMbps(share.rateUpBps));
        setDownMbps(toMbps(share.rateDownBps));
        setTrashDays(String(share.trashKeepDays));
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
        const hours = Number(snapshotHours);
        const days = Number(snapshotDays);
        if (snapshotEnabled && (!Number.isInteger(hours) || hours < 1 || hours > 24 * 7)) {
            setError('La cadence des points de restauration doit être comprise entre 1 et 168 heures.');
            return;
        }
        if (snapshotEnabled && (!Number.isInteger(days) || days < 1 || days > 3650)) {
            setError('La conservation des points de restauration doit être comprise entre 1 et 3650 jours.');
            return;
        }
        const trash = Number(trashDays);
        if (!Number.isInteger(trash) || trash < 1 || trash > 3650) {
            setError('La durée de la corbeille doit être comprise entre 1 et 3650 jours.');
            return;
        }
        try {
            await ws.send('cloudSync.updateShare', {
                shareId: share.id,
                name: name.trim(),
                backupPruneEnabled: pruneEnabled,
                backupLimitBytes,
                snapshotEnabled,
                snapshotIntervalHours: snapshotEnabled ? hours : share.snapshotIntervalHours,
                snapshotKeepDays: snapshotEnabled ? days : share.snapshotKeepDays,
                integrityScanEnabled: integrityScan,
                rateUpBps: fromMbps(upMbps),
                rateDownBps: fromMbps(downMbps),
                trashKeepDays: trash,
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
                <Checkbox checked={pruneEnabled} onChange={setPruneEnabled}>
                    <span className={styles.rowTitle}>
                        Purger automatiquement les sauvegardes les plus anciennes au-delà d’une limite
                    </span>
                </Checkbox>
                {pruneEnabled && (
                    <label className={styles.field} htmlFor={limitFieldId}>
                        Limite des sauvegardes (Go)
                        <NumberField id={limitFieldId} min={1} placeholder='50' value={limitGb} onChange={setLimitGb} />
                    </label>
                )}
                <Checkbox checked={snapshotEnabled} onChange={setSnapshotEnabled}>
                    <span className={styles.rowTitle}>
                        Prendre des points de restauration automatiques du dossier entier
                    </span>
                </Checkbox>
                {snapshotEnabled && (
                    <>
                        <label className={styles.field} htmlFor={snapshotHoursId}>
                            Un point toutes les… (heures)
                            <NumberField
                                id={snapshotHoursId}
                                min={1}
                                max={24 * 7}
                                placeholder='6'
                                value={snapshotHours}
                                onChange={setSnapshotHours}
                            />
                        </label>
                        <label className={styles.field} htmlFor={snapshotDaysId}>
                            Conserver les points pendant… (jours)
                            <NumberField
                                id={snapshotDaysId}
                                min={1}
                                max={3650}
                                placeholder='90'
                                value={snapshotDays}
                                onChange={setSnapshotDays}
                            />
                        </label>
                        <div className={styles.mutedNote}>
                            Tout est gardé sur 48 h, puis un point par jour pendant 30 jours, puis un par semaine. Un
                            point ne copie aucun fichier : il n’enregistre que l’inventaire du dossier.
                        </div>
                    </>
                )}
                <Checkbox checked={integrityScan} onChange={setIntegrityScan}>
                    <span className={styles.rowTitle}>Vérifier régulièrement l’intégrité des contenus stockés</span>
                </Checkbox>
                <div className={styles.mutedNote}>
                    Quelques centaines de Mo par heure, sans se faire remarquer. Un contenu abîmé sur le disque est
                    alors détecté tout seul — et réparé depuis un appareil qui le possède encore, plutôt que découvert
                    le jour d’une restauration.
                </div>
                <label className={styles.field} htmlFor={downFieldId}>
                    Limite de téléchargement (Mo/s, vide = illimité)
                    <NumberField
                        id={downFieldId}
                        min={1}
                        placeholder='illimité'
                        value={downMbps}
                        onChange={setDownMbps}
                    />
                </label>
                <label className={styles.field} htmlFor={upFieldId}>
                    Limite d’envoi (Mo/s, vide = illimité)
                    <NumberField id={upFieldId} min={1} placeholder='illimité' value={upMbps} onChange={setUpMbps} />
                </label>
                <label className={styles.field} htmlFor={trashFieldId}>
                    Corbeille locale des appareils (jours)
                    <NumberField
                        id={trashFieldId}
                        min={1}
                        max={3650}
                        placeholder='30'
                        value={trashDays}
                        onChange={setTrashDays}
                    />
                </label>
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

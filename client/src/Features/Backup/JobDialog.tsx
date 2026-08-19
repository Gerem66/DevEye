import { useEffect, useMemo, useState } from 'react';
import type {
    BackupDestination,
    BackupJob,
    BackupScheduleKind,
    BackupSourceCandidate,
    BackupSourceKind
} from 'deveye-types';

import { Button, Dialog, SelectInput, Switch, TextInput } from '@/Components';
import { ws } from '@/api/ws';
import { backupError, DESTINATION_LABELS, SCHEDULE_LABELS, WEEKDAYS } from './format';
import styles from './style.module.css';

interface JobDialogProps {
    open: boolean;
    /** `null` = création. */
    job: BackupJob | null;
    destinations: BackupDestination[];
    onClose: () => void;
    onSaved: () => void;
}

/** La clé d'un candidat, pour qu'un `<select>` porte à la fois le genre et l'id. */
const keyOf = (kind: BackupSourceKind, id: number | null): string => `${kind}:${id ?? ''}`;

/**
 * Créer ou modifier un travail : quoi, où, quand, combien de copies.
 *
 * Les sources viennent du serveur (`backup.sources`) plutôt que d'un croisement
 * côté écran : elles vivent dans trois features différentes, chacune derrière
 * son propre droit, et les recomposer ici aurait demandé trois appels et trois
 * gardes à tenir en phase avec le serveur.
 */
export function JobDialog({ open, job, destinations, onClose, onSaved }: JobDialogProps) {
    const [candidates, setCandidates] = useState<BackupSourceCandidate[]>([]);
    const [name, setName] = useState('');
    const [sourceKey, setSourceKey] = useState('');
    const [destinationId, setDestinationId] = useState(0);
    const [enabled, setEnabled] = useState(true);
    const [schedule, setSchedule] = useState<BackupScheduleKind>('daily');
    const [hour, setHour] = useState(3);
    const [weekday, setWeekday] = useState(0);
    const [day, setDay] = useState(1);
    const [keepLast, setKeepLast] = useState(7);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!open) return;
        setError(null);
        void ws
            .send('backup.sources', {})
            .then((res) => setCandidates(res.candidates))
            .catch(() => setCandidates([]));

        if (job) {
            setName(job.name);
            setSourceKey(keyOf(job.source, job.sourceId));
            setDestinationId(job.destinationId);
            setEnabled(job.enabled);
            setSchedule(job.schedule);
            setHour(job.scheduleHour);
            setWeekday(job.scheduleWeekday);
            setDay(job.scheduleDay);
            setKeepLast(job.keepLast);
            return;
        }
        setName('');
        setSourceKey('');
        setDestinationId(destinations[0]?.id ?? 0);
        setEnabled(true);
        setSchedule('daily');
        setHour(3);
        setWeekday(0);
        setDay(1);
        setKeepLast(7);
    }, [open, job, destinations]);

    const selected = useMemo(
        () => candidates.find((c) => keyOf(c.kind, c.id) === sourceKey) ?? null,
        [candidates, sourceKey]
    );

    // Le nom suit la source tant qu'on ne l'a pas écrit soi-même : personne n'a
    // envie de retaper « Base de production » juste après l'avoir choisie.
    useEffect(() => {
        if (job || !selected || name.trim() !== '') return;
        setName(selected.name);
    }, [selected, job, name]);

    const submit = async () => {
        if (busy || !selected) return;
        setBusy(true);
        setError(null);
        try {
            const body = {
                name: name.trim(),
                destinationId,
                source: selected.kind,
                sourceId: selected.id,
                enabled,
                schedule,
                scheduleHour: hour,
                scheduleWeekday: weekday,
                scheduleDay: day,
                keepLast
            };
            if (job) await ws.send('backup.jobUpdate', { jobId: job.id, ...body });
            else await ws.send('backup.jobAdd', body);
            onSaved();
            onClose();
        } catch (e) {
            setError(backupError(e, 'Impossible d’enregistrer ce travail.'));
        } finally {
            setBusy(false);
        }
    };

    const ready = name.trim() !== '' && selected !== null && selected.available && destinationId > 0;

    return (
        <Dialog
            open={open}
            onClose={onClose}
            onSubmit={() => void submit()}
            title={job ? 'Modifier le travail' : 'Nouveau travail de sauvegarde'}
            description='Ce qui part, où ça atterrit, à quelle cadence, et combien de copies on garde.'
            width={640}
            footer={
                <>
                    <Button variant='ghost' onClick={onClose} disabled={busy}>
                        Annuler
                    </Button>
                    <Button onClick={() => void submit()} disabled={busy || !ready}>
                        {busy ? 'Enregistrement…' : 'Enregistrer'}
                    </Button>
                </>
            }
        >
            <div className={styles.form}>
                <label className={styles.field}>
                    <span className={styles.fieldLabel}>Quoi sauvegarder</span>
                    <SelectInput value={sourceKey} onChange={(e) => setSourceKey(e.target.value)}>
                        <option value=''>Choisir une source…</option>
                        {candidates.map((c) => (
                            <option key={keyOf(c.kind, c.id)} value={keyOf(c.kind, c.id)} disabled={!c.available}>
                                {c.name}
                                {c.available ? '' : ` — ${c.reason ?? 'indisponible'}`}
                            </option>
                        ))}
                    </SelectInput>
                    {selected?.detail && <span className={styles.fieldHint}>{selected.detail}</span>}
                </label>

                <label className={styles.field}>
                    <span className={styles.fieldLabel}>Nom du travail</span>
                    <TextInput
                        value={name}
                        maxLength={120}
                        placeholder='Base de production — nuit'
                        onChange={(e) => setName(e.target.value)}
                    />
                </label>

                <label className={styles.field}>
                    <span className={styles.fieldLabel}>Où l’écrire</span>
                    <SelectInput value={destinationId} onChange={(e) => setDestinationId(Number(e.target.value))}>
                        {destinations.length === 0 && <option value={0}>Aucune destination déclarée</option>}
                        {destinations.map((d) => (
                            <option key={d.id} value={d.id}>
                                {d.name} — {DESTINATION_LABELS[d.kind]}
                                {d.encrypt ? ' (chiffrée)' : ''}
                            </option>
                        ))}
                    </SelectInput>
                </label>

                <div className={styles.fieldRow}>
                    <label className={styles.field}>
                        <span className={styles.fieldLabel}>Cadence</span>
                        <SelectInput
                            value={schedule}
                            onChange={(e) => setSchedule(e.target.value as BackupScheduleKind)}
                        >
                            {(Object.keys(SCHEDULE_LABELS) as BackupScheduleKind[]).map((k) => (
                                <option key={k} value={k}>
                                    {SCHEDULE_LABELS[k]}
                                </option>
                            ))}
                        </SelectInput>
                    </label>

                    {schedule !== 'manual' && schedule !== 'hourly' && (
                        <label className={styles.field}>
                            <span className={styles.fieldLabel}>Heure</span>
                            <SelectInput value={hour} onChange={(e) => setHour(Number(e.target.value))}>
                                {Array.from({ length: 24 }, (_, h) => (
                                    <option key={h} value={h}>
                                        {String(h).padStart(2, '0')} h
                                    </option>
                                ))}
                            </SelectInput>
                        </label>
                    )}

                    {schedule === 'weekly' && (
                        <label className={styles.field}>
                            <span className={styles.fieldLabel}>Jour</span>
                            <SelectInput value={weekday} onChange={(e) => setWeekday(Number(e.target.value))}>
                                {WEEKDAYS.map((label, index) => (
                                    <option key={label} value={index}>
                                        {label}
                                    </option>
                                ))}
                            </SelectInput>
                        </label>
                    )}

                    {schedule === 'monthly' && (
                        <label className={styles.field}>
                            <span className={styles.fieldLabel}>Quantième</span>
                            <SelectInput value={day} onChange={(e) => setDay(Number(e.target.value))}>
                                {/* Borné à 28 : un travail au 31 ne partirait pas
                                    en février, et un travail qui saute un mois
                                    sans rien dire est précisément la panne qu'on
                                    ne veut pas rendre possible. */}
                                {Array.from({ length: 28 }, (_, i) => (
                                    <option key={i + 1} value={i + 1}>
                                        {i + 1}
                                    </option>
                                ))}
                            </SelectInput>
                        </label>
                    )}
                </div>

                <label className={styles.field}>
                    <span className={styles.fieldLabel}>Copies conservées</span>
                    <TextInput
                        type='number'
                        min={1}
                        max={365}
                        value={keepLast}
                        onChange={(e) => setKeepLast(Math.min(365, Math.max(1, Number(e.target.value) || 1)))}
                    />
                    <span className={styles.fieldHint}>
                        Au-delà, la plus ancienne archive est effacée de la destination après chaque sauvegarde réussie.
                        Un échec n’efface jamais rien.
                    </span>
                </label>

                <Switch
                    checked={enabled}
                    onChange={setEnabled}
                    label='Travail actif'
                    hint='Désactivé, il ne part plus tout seul mais reste déclenchable à la main.'
                />

                {error && <p className={styles.error}>{error}</p>}
            </div>
        </Dialog>
    );
}

export default JobDialog;

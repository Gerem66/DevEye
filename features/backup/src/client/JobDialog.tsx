import { useEffect, useMemo, useRef, useState } from 'react';
import type { BackupDestination, BackupScheduleKind, BackupSourceCandidate } from '../contracts/domain';

import {
    Button,
    Dialog,
    FeatureSettingsButton,
    humanizeError,
    SearchSelect,
    Switch,
    TextInput
} from 'deveye-sdk-client';
import { api } from './api';
import {
    candidateKey,
    DAY_OPTIONS,
    DESTINATION_LABELS,
    HOUR_OPTIONS,
    SCHEDULE_OPTIONS,
    WEEKDAY_OPTIONS
} from './format';
import JobSourceFields, { EMPTY_FOLDER, type FolderDraft } from './JobSourceFields';
import styles from './style.module.css';

interface JobDialogProps {
    open: boolean;
    destinations: BackupDestination[];
    onClose: () => void;
    onSaved: () => void;
}

/**
 * Créer un travail. Rien d'autre : une fois créé, un travail se règle dans
 * l'onglet Général de sa fiche, comme tout élément.
 *
 * Les sources viennent du serveur (`backup.sources`) : elles vivent dans trois
 * features, chacune derrière son droit.
 */
export default function JobDialog({ open, destinations, onClose, onSaved }: JobDialogProps) {
    const [candidates, setCandidates] = useState<BackupSourceCandidate[]>([]);
    const [name, setName] = useState('');
    const [source, setSource] = useState('');
    const [folder, setFolder] = useState<FolderDraft>(EMPTY_FOLDER);
    const [destinationId, setDestinationId] = useState(0);
    const [enabled, setEnabled] = useState(true);
    const [schedule, setSchedule] = useState<BackupScheduleKind>('daily');
    const [hour, setHour] = useState(3);
    const [weekday, setWeekday] = useState(0);
    const [day, setDay] = useState(1);
    const [keepLast, setKeepLast] = useState(7);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    /**
     * Les destinations connues à l'ouverture des réglages : celle qui apparaît
     * ensuite vient d'y être créée pour ce travail.
     */
    const knownIds = useRef<Set<number> | null>(null);

    // À l'ouverture seule, pas quand `destinations` bouge : la liste se
    // recharge au rythme du sujet Live et remettrait le formulaire à zéro sous
    // les doigts.
    useEffect(() => {
        if (!open) return;
        setError(null);
        knownIds.current = null;
        void api
            .send('backup.sources', {})
            .then((res) => setCandidates(res.candidates))
            .catch(() => setCandidates([]));
        setName('');
        setSource('');
        setFolder(EMPTY_FOLDER);
        setDestinationId(0);
        setEnabled(true);
        setSchedule('daily');
        setHour(3);
        setWeekday(0);
        setDay(1);
        setKeepLast(7);
    }, [open]);

    // Sans destination choisie, la première de la liste.
    useEffect(() => {
        if (!open) return;
        setDestinationId((prev) => (prev !== 0 ? prev : (destinations[0]?.id ?? 0)));
    }, [open, destinations]);

    // Une destination apparue pendant que les réglages étaient ouverts se
    // sélectionne toute seule.
    useEffect(() => {
        if (knownIds.current === null) return;
        const fresh = destinations.find((d) => !knownIds.current?.has(d.id));
        if (!fresh) return;
        knownIds.current = new Set(destinations.map((d) => d.id));
        setDestinationId(fresh.id);
    }, [destinations]);

    const selected = useMemo(() => candidates.find((c) => candidateKey(c) === source) ?? null, [candidates, source]);

    // Le nom suit la source tant qu'on ne l'a pas écrit soi-même : personne n'a
    // envie de retaper « Base de production » juste après l'avoir choisie.
    useEffect(() => {
        if (!selected || name.trim() !== '') return;
        setName(selected.name);
    }, [selected, name]);

    const submit = async () => {
        if (busy || !selected) return;
        setBusy(true);
        setError(null);
        try {
            await api.send('backup.jobAdd', {
                name: name.trim(),
                destinationId,
                source: selected.kind,
                sourceId: selected.id,
                folder:
                    selected.kind === 'deviceFolder' && selected.deviceId
                        ? {
                              deviceId: selected.deviceId,
                              path: folder.path.trim(),
                              exclusions: folder.exclusions,
                              oneFileSystem: folder.oneFileSystem
                          }
                        : null,
                enabled,
                schedule,
                scheduleHour: hour,
                scheduleWeekday: weekday,
                scheduleDay: day,
                keepLast,
                // La forme se règle dans l'onglet Chiffrement ; un travail naît scellé.
                encryption: 'server'
            });
            onSaved();
            onClose();
        } catch (e) {
            setError(humanizeError(e, 'Impossible de créer ce travail.'));
        } finally {
            setBusy(false);
        }
    };

    const ready =
        name.trim() !== '' &&
        selected !== null &&
        selected.available &&
        (selected.kind !== 'deviceFolder' || folder.path.trim() !== '') &&
        destinationId > 0;

    return (
        <Dialog
            open={open}
            onClose={onClose}
            onSubmit={() => void submit()}
            title='Nouveau travail de sauvegarde'
            description='Ce qui part, où ça atterrit, à quelle cadence, et combien de copies on garde.'
            width={640}
            footer={
                <>
                    <Button variant='ghost' onClick={onClose} disabled={busy}>
                        Annuler
                    </Button>
                    <Button onClick={() => void submit()} disabled={busy || !ready}>
                        {busy ? 'Création…' : 'Créer'}
                    </Button>
                </>
            }
        >
            <div className={styles.form}>
                <JobSourceFields
                    candidates={candidates}
                    source={source}
                    onSourceChange={setSource}
                    folder={folder}
                    onFolderChange={setFolder}
                    classes={{ field: styles.field, label: styles.fieldLabel, hint: styles.fieldHint }}
                />

                <label className={styles.field}>
                    <span className={styles.fieldLabel}>Nom du travail</span>
                    <TextInput
                        value={name}
                        maxLength={120}
                        placeholder='Base de production, la nuit'
                        onChange={(e) => setName(e.target.value)}
                    />
                </label>

                <div className={styles.field}>
                    <span className={styles.fieldLabel}>Où l’écrire</span>
                    <div className={styles.fieldWithAction}>
                        <SearchSelect
                            value={String(destinationId)}
                            aria-label='Où l’écrire'
                            placeholder={destinations.length === 0 ? 'Aucune destination déclarée' : 'Choisir…'}
                            options={destinations.map((d) => ({
                                value: String(d.id),
                                label: d.name,
                                detail: DESTINATION_LABELS[d.kind]
                            }))}
                            onChange={(v) => setDestinationId(Number(v))}
                        />
                        {/* Les destinations se déclarent dans Réglages → Sources ;
                            celle créée pendant ce temps est adoptée
                            (`onOpenChange` fige la liste connue). */}
                        <FeatureSettingsButton
                            scope={{ kind: 'feature', feature: 'backup' }}
                            initialSection='sources'
                            variant='ghost'
                            label='Destinations'
                            onOpenChange={(opened) => {
                                if (opened) knownIds.current = new Set(destinations.map((d) => d.id));
                            }}
                        />
                    </div>
                    {destinations.length === 0 && (
                        <span className={styles.fieldHint}>
                            Aucune destination dans cet espace : le bouton ouvre les réglages pour en déclarer une.
                        </span>
                    )}
                </div>

                <div className={styles.fieldRow}>
                    <label className={styles.field}>
                        <span className={styles.fieldLabel}>Cadence</span>
                        <SearchSelect
                            value={schedule}
                            aria-label='Cadence'
                            options={SCHEDULE_OPTIONS}
                            onChange={setSchedule}
                        />
                    </label>

                    {schedule !== 'manual' && schedule !== 'hourly' && (
                        <label className={styles.field}>
                            <span className={styles.fieldLabel}>Heure</span>
                            <SearchSelect
                                value={String(hour)}
                                aria-label='Heure'
                                options={HOUR_OPTIONS}
                                onChange={(v) => setHour(Number(v))}
                            />
                        </label>
                    )}

                    {schedule === 'weekly' && (
                        <label className={styles.field}>
                            <span className={styles.fieldLabel}>Jour</span>
                            <SearchSelect
                                value={String(weekday)}
                                aria-label='Jour'
                                options={WEEKDAY_OPTIONS}
                                onChange={(v) => setWeekday(Number(v))}
                            />
                        </label>
                    )}

                    {schedule === 'monthly' && (
                        <label className={styles.field}>
                            <span className={styles.fieldLabel}>Quantième</span>
                            <SearchSelect
                                value={String(day)}
                                aria-label='Quantième'
                                options={DAY_OPTIONS}
                                onChange={(v) => setDay(Number(v))}
                            />
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

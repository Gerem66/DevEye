import { useEffect, useMemo, useRef, useState } from 'react';
import type {
    BackupDestination,
    BackupJob,
    BackupScheduleKind,
    BackupSourceCandidate,
    BackupSourceKind
} from '../contracts/domain';

import {
    Button,
    Dialog,
    FeatureSettingsButton,
    humanizeError,
    SelectInput,
    Switch,
    TextInput
} from 'deveye-sdk-client';
import { api } from './api';
import { DESTINATION_LABELS, SCHEDULE_LABELS, WEEKDAYS } from './format';
import styles from './style.module.css';

interface JobDialogProps {
    open: boolean;
    /** `null` = création. */
    job: BackupJob | null;
    destinations: BackupDestination[];
    onClose: () => void;
    onSaved: () => void;
    /**
     * Le travail vient d'être supprimé ; la suppression vit dans la zone danger
     * de ce dialogue, comme pour une cible ou un dépôt. Absent = pas proposée.
     */
    onRemoved?: () => void;
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
 *
 * La cadence reste un déroulant : cinq choix, un de plus que ce qu'une rangée
 * de segments sait montrer sans s'étirer.
 */
export default function JobDialog({ open, job, destinations, onClose, onSaved, onRemoved }: JobDialogProps) {
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
    /** La suppression emporte l'historique : elle se confirme sur place. */
    const [confirmRemove, setConfirmRemove] = useState(false);
    /**
     * Les destinations connues au moment d'ouvrir les réglages : celle qui
     * apparaît ensuite vient d'y être créée, et c'est pour ce travail-ci qu'on
     * l'a créée ; elle se sélectionne donc toute seule au retour.
     */
    const knownIds = useRef<Set<number> | null>(null);

    // À l'ouverture seule, surtout pas quand `destinations` bouge : la liste
    // se recharge au rythme du sujet Live (chaque exécution nocturne la fait
    // battre), et remettre le formulaire à zéro sous les doigts effacerait la
    // saisie en cours. Le choix de la destination par défaut vit dans les deux
    // effets qui suivent.
    useEffect(() => {
        if (!open) return;
        setError(null);
        setConfirmRemove(false);
        knownIds.current = null;
        void api
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
        setDestinationId(0);
        setEnabled(true);
        setSchedule('daily');
        setHour(3);
        setWeekday(0);
        setDay(1);
        setKeepLast(7);
    }, [open, job]);

    // Sans destination choisie, la première de la liste : couvre l'ouverture
    // (l'ancien défaut) comme l'arrivée de la toute première destination.
    useEffect(() => {
        if (!open) return;
        setDestinationId((prev) => (prev !== 0 ? prev : (destinations[0]?.id ?? 0)));
    }, [open, destinations]);

    // L'adoption : une destination apparue pendant que les réglages étaient
    // ouverts vient d'y être créée, et c'est pour ce travail-ci ; elle se
    // sélectionne toute seule, comme les dialogues de liaison des Projets
    // relient ce qu'ils viennent de créer.
    useEffect(() => {
        if (knownIds.current === null) return;
        const fresh = destinations.find((d) => !knownIds.current?.has(d.id));
        if (!fresh) return;
        knownIds.current = new Set(destinations.map((d) => d.id));
        setDestinationId(fresh.id);
    }, [destinations]);

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
                keepLast,
                // La forme des archives se règle dans l'onglet Chiffrement des
                // réglages du travail : le formulaire préserve l'existante, et
                // un travail naît scellé (le défaut sûr).
                encryption: job?.encryption ?? ('server' as const)
            };
            if (job) await api.send('backup.jobUpdate', { jobId: job.id, ...body });
            else await api.send('backup.jobAdd', body);
            onSaved();
            onClose();
        } catch (e) {
            setError(humanizeError(e, 'Impossible d’enregistrer ce travail.'));
        } finally {
            setBusy(false);
        }
    };

    const remove = async () => {
        if (!job || busy) return;
        setBusy(true);
        setError(null);
        try {
            await api.send('backup.jobRemove', { jobId: job.id });
            onRemoved?.();
        } catch (e) {
            setError(humanizeError(e, 'Impossible de supprimer ce travail.'));
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
                                {c.available ? '' : ` (${c.reason ?? 'indisponible'})`}
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
                        placeholder='Base de production, la nuit'
                        onChange={(e) => setName(e.target.value)}
                    />
                </label>

                <div className={styles.field}>
                    <span className={styles.fieldLabel}>Où l’écrire</span>
                    <div className={styles.fieldWithAction}>
                        <SelectInput value={destinationId} onChange={(e) => setDestinationId(Number(e.target.value))}>
                            {destinations.length === 0 && <option value={0}>Aucune destination déclarée</option>}
                            {destinations.map((d) => (
                                <option key={d.id} value={d.id}>
                                    {d.name} ({DESTINATION_LABELS[d.kind]})
                                </option>
                            ))}
                        </SelectInput>
                        {/* La fiche choisit, les réglages gèrent : les
                            destinations se déclarent dans Réglages → Sources,
                            jamais ici. Le bouton commun y mène, par-dessus, et
                            la destination créée pendant ce temps est adoptée
                            (`onOpenChange` fige la liste connue à l'ouverture). */}
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

                {job && onRemoved && (
                    <div className={styles.dangerZone}>
                        <div className={styles.dangerText}>
                            <strong>Supprimer ce travail</strong>
                            <span className={styles.fieldHint}>
                                Son historique part avec lui. Les archives déjà écrites, elles, restent où elles sont :
                                à vous de les effacer si vous le souhaitez.
                            </span>
                        </div>
                        {confirmRemove ? (
                            <div className={styles.dangerActions}>
                                <Button variant='secondary' onClick={() => setConfirmRemove(false)} disabled={busy}>
                                    Annuler
                                </Button>
                                <Button variant='danger' onClick={() => void remove()} disabled={busy}>
                                    Confirmer
                                </Button>
                            </div>
                        ) : (
                            <Button
                                variant='danger'
                                icon='trash'
                                onClick={() => setConfirmRemove(true)}
                                disabled={busy}
                            >
                                Supprimer
                            </Button>
                        )}
                    </div>
                )}

                {error && <p className={styles.error}>{error}</p>}
            </div>
        </Dialog>
    );
}

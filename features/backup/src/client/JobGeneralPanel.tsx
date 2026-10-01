import { useEffect, useMemo, useRef, useState } from 'react';
import type { SettingsPanelProps } from '@deveye/types/sdk/client';
import type {
    BackupFolder,
    BackupJob,
    BackupScheduleKind,
    BackupSourceCandidate,
    BackupSourceKind
} from '../contracts/domain';

import {
    Button,
    ConfirmDialog,
    FeatureSettingsButton,
    humanizeError,
    invalidate,
    ReadOnlyNotice,
    SaveButton,
    SearchSelect,
    settingsStyles as shell,
    Switch,
    TextInput,
    useResource,
    type ConfirmRequest
} from 'deveye-sdk-client';
import { api } from './api';
import {
    candidateKey,
    DAY_OPTIONS,
    DESTINATION_LABELS,
    folderInput,
    HOUR_OPTIONS,
    SCHEDULE_OPTIONS,
    sourceKey,
    WEEKDAY_OPTIONS
} from './format';
import JobSourceFields, { EMPTY_FOLDER, type FolderDraft } from './JobSourceFields';
import styles from './style.module.css';

/**
 * Le travail lui-même : ce qui part, où, à quelle cadence, combien de copies
 * on garde, s'il est actif, et sa suppression. L'onglet Général de ses
 * réglages, là où le bouton commun mène. Le dialogue ne sert plus qu'à CRÉER
 * un travail, geste qui n'a pas d'élément à viser.
 *
 * La forme des archives a son propre onglet (Chiffrement) : l'enregistrement
 * d'ici la recopie telle quelle.
 */
export default function JobGeneralPanel({ scope, canWrite, gone }: SettingsPanelProps) {
    const jobId = scope.kind === 'item' ? Number(scope.itemId) : null;
    const [job, setJob] = useState<BackupJob | null>(null);
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
    // Sur ce serveur, rien ne resterait pour les effacer ensuite.
    const removalNote =
        job?.destinationKind === 'local'
            ? 'Son historique et ses archives, gardées sur ce serveur, partent avec lui : la place se libère.'
            : 'Son historique part avec lui. Les archives déjà écrites restent où elles sont, sur la destination : à vous de les effacer si vous le souhaitez.';
    const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
    /**
     * Les destinations connues à l'ouverture des réglages de la feature : celle
     * qui apparaît ensuite vient d'y être créée pour ce travail.
     */
    const knownIds = useRef<Set<number> | null>(null);

    // Vivante (le sujet de la feature la relit) : une destination déclarée
    // derrière le bouton commun arrive ici sans qu'on la recharge.
    const { data: destinations, error: destinationsError } = useResource(
        'backup.destinationList',
        () => api.send('backup.destinationList', {}).then((res) => res.destinations),
        'Impossible de charger les destinations.'
    );

    // Lu une fois : une relecture (le sujet live bat à chaque exécution) ne
    // doit pas effacer une saisie en cours. Les sources vivent dans trois
    // features, chacune derrière son droit : sans elles, la liste reste vide.
    useEffect(() => {
        if (jobId === null) return;
        void (async () => {
            try {
                const [res, sources] = await Promise.all([
                    api.send('backup.jobGet', { jobId, limit: 1 }),
                    api.send('backup.sources', {}).catch(() => ({ candidates: [] }))
                ]);
                setCandidates(sources.candidates);
                setJob(res.job);
                setName(res.job.name);
                setSource(sourceKey(res.job.source, res.job.sourceId ?? res.job.folder?.deviceId ?? null));
                setFolder(res.job.folder ? { ...EMPTY_FOLDER, ...folderInput(res.job.folder) } : EMPTY_FOLDER);
                setDestinationId(res.job.destinationId);
                setEnabled(res.job.enabled);
                setSchedule(res.job.schedule);
                setHour(res.job.scheduleHour);
                setWeekday(res.job.scheduleWeekday);
                setDay(res.job.scheduleDay);
                setKeepLast(res.job.keepLast);
            } catch (e) {
                setError(humanizeError(e, 'Le travail n’a pas pu être lu.'));
            }
        })();
    }, [jobId]);

    // Une destination apparue pendant que les réglages étaient ouverts se
    // sélectionne toute seule.
    useEffect(() => {
        if (knownIds.current === null || !destinations) return;
        const fresh = destinations.find((d) => !knownIds.current?.has(d.id));
        if (!fresh) return;
        knownIds.current = new Set(destinations.map((d) => d.id));
        setDestinationId(fresh.id);
    }, [destinations]);

    const selected = useMemo(() => candidates.find((c) => candidateKey(c) === source) ?? null, [candidates, source]);

    const save = async () => {
        if (!job || !selected) return;
        setError(null);
        try {
            const res = await api.send('backup.jobUpdate', {
                jobId: job.id,
                name: name.trim(),
                destinationId,
                source: selected.kind,
                sourceId: selected.id,
                folder: folderOf(selected.kind, selected.deviceId, folder),
                enabled,
                schedule,
                scheduleHour: hour,
                scheduleWeekday: weekday,
                scheduleDay: day,
                keepLast,
                encryption: job.encryption
            });
            setJob(res.job);
            invalidate('backup.jobList', 'backup.detail', 'backup.destinationList', 'backup.count');
        } catch (e) {
            setError(humanizeError(e, 'Impossible d’enregistrer ce travail.'));
            // Relancé : le bouton n'annonce « Enregistré » que sur un succès.
            throw e;
        }
    };

    const remove = async () => {
        if (!job) return;
        setBusy(true);
        setError(null);
        try {
            await api.send('backup.jobRemove', { jobId: job.id });
            // La fiche s'en va AVANT que la liste ne se relise : relue après
            // coup, elle chercherait un travail qui n'existe plus.
            gone();
            invalidate('backup.jobList', 'backup.destinationList', 'backup.count');
        } catch (e) {
            setError(humanizeError(e, 'Impossible de supprimer ce travail.'));
        } finally {
            setBusy(false);
        }
    };

    if (!job || destinations === null) {
        const message = error ?? destinationsError;
        return <p className={message ? shell.notice : shell.empty}>{message ?? 'Chargement…'}</p>;
    }

    // Un travail projeté se modifie chez lui : le serveur le refuse d'ici.
    if (job.foreign) {
        return (
            <p className={shell.sectionHint}>
                Ce travail vient d’un autre espace : ses réglages et sa suppression se font depuis là-bas.
            </p>
        );
    }

    const editable = canWrite && !busy;
    const ready =
        name.trim() !== '' &&
        selected !== null &&
        selected.available &&
        (selected.kind !== 'deviceFolder' || folder.path.trim() !== '') &&
        destinationId > 0;
    const unchanged =
        name.trim() === job.name &&
        source === sourceKey(job.source, job.sourceId ?? job.folder?.deviceId ?? null) &&
        JSON.stringify(folderOf(job.source, job.folder?.deviceId ?? null, folder)) ===
            JSON.stringify(folderInput(job.folder)) &&
        destinationId === job.destinationId &&
        enabled === job.enabled &&
        schedule === job.schedule &&
        hour === job.scheduleHour &&
        weekday === job.scheduleWeekday &&
        day === job.scheduleDay &&
        keepLast === job.keepLast;

    return (
        <div className={shell.section}>
            <JobSourceFields
                candidates={candidates}
                source={source}
                onSourceChange={setSource}
                folder={folder}
                onFolderChange={setFolder}
                author={job.folder ? job.folder.authorName : undefined}
                disabled={!editable}
                classes={{ field: shell.field, label: shell.sectionLabel, hint: shell.fieldHint }}
            />

            <label className={shell.field}>
                <span className={shell.sectionLabel}>Nom du travail</span>
                <TextInput
                    value={name}
                    maxLength={120}
                    placeholder='Base de production, la nuit'
                    disabled={!editable}
                    onChange={(e) => setName(e.target.value)}
                />
            </label>

            <div className={shell.field}>
                <span className={shell.sectionLabel}>Où l’écrire</span>
                <div className={shell.fieldWithAction}>
                    <SearchSelect
                        value={String(destinationId)}
                        disabled={!editable}
                        aria-label='Où l’écrire'
                        options={destinations.map((d) => ({
                            value: String(d.id),
                            label: d.name,
                            detail: DESTINATION_LABELS[d.kind]
                        }))}
                        onChange={(v) => setDestinationId(Number(v))}
                    />
                    {/* Le bouton commun ouvre les réglages de la feature par-dessus,
                        et la destination qui y est créée est adoptée au retour
                        (`onOpenChange` fige la liste connue). */}
                    {canWrite && (
                        <FeatureSettingsButton
                            scope={{ kind: 'feature', feature: 'backup' }}
                            initialSection='sources'
                            variant='ghost'
                            label='Destinations'
                            onOpenChange={(opened) => {
                                if (opened) knownIds.current = new Set(destinations.map((d) => d.id));
                            }}
                        />
                    )}
                </div>
                <span className={shell.fieldHint}>
                    Les destinations se déclarent dans Réglages → Sources (« Destinations » y mène) et servent à tous
                    les travaux.
                </span>
            </div>

            {/* `styles.field` et non `shell.field` : dans une rangée, les champs
                se partagent la largeur, ce que la feuille de la coquille ne
                prévoit pas. */}
            <div className={styles.fieldRow}>
                <label className={styles.field}>
                    <span className={shell.sectionLabel}>Cadence</span>
                    <SearchSelect
                        value={schedule}
                        aria-label='Cadence'
                        options={SCHEDULE_OPTIONS}
                        disabled={!editable}
                        onChange={setSchedule}
                    />
                </label>

                {schedule !== 'manual' && schedule !== 'hourly' && (
                    <label className={styles.field}>
                        <span className={shell.sectionLabel}>Heure</span>
                        <SearchSelect
                            value={String(hour)}
                            aria-label='Heure'
                            options={HOUR_OPTIONS}
                            disabled={!editable}
                            onChange={(v) => setHour(Number(v))}
                        />
                    </label>
                )}

                {schedule === 'weekly' && (
                    <label className={styles.field}>
                        <span className={shell.sectionLabel}>Jour</span>
                        <SearchSelect
                            value={String(weekday)}
                            aria-label='Jour'
                            options={WEEKDAY_OPTIONS}
                            disabled={!editable}
                            onChange={(v) => setWeekday(Number(v))}
                        />
                    </label>
                )}

                {schedule === 'monthly' && (
                    <label className={styles.field}>
                        <span className={shell.sectionLabel}>Quantième</span>
                        <SearchSelect
                            value={String(day)}
                            aria-label='Quantième'
                            options={DAY_OPTIONS}
                            disabled={!editable}
                            onChange={(v) => setDay(Number(v))}
                        />
                    </label>
                )}
            </div>

            <label className={shell.field}>
                <span className={shell.sectionLabel}>Copies conservées</span>
                <TextInput
                    type='number'
                    min={1}
                    max={365}
                    value={keepLast}
                    disabled={!editable}
                    onChange={(e) => setKeepLast(Math.min(365, Math.max(1, Number(e.target.value) || 1)))}
                />
                <span className={shell.fieldHint}>
                    Au-delà, la plus ancienne archive est effacée de la destination après chaque sauvegarde réussie. Un
                    échec n’efface jamais rien.
                </span>
            </label>

            <Switch
                checked={enabled}
                disabled={!editable}
                onChange={setEnabled}
                label='Travail actif'
                hint='Désactivé, il ne part plus tout seul mais reste déclenchable à la main.'
            />

            {canWrite ? (
                <SaveButton onSave={save} disabled={busy || !ready || unchanged} />
            ) : (
                <ReadOnlyNotice>
                    Votre rôle ne permet pas de modifier un travail : cela relève de l’écriture sur les Sauvegardes.
                </ReadOnlyNotice>
            )}

            {canWrite && (
                <div className={shell.field}>
                    <span className={shell.sectionLabel}>Supprimer ce travail</span>
                    <span className={shell.fieldHint}>{removalNote}</span>
                    <div className={shell.sectionActions}>
                        <Button
                            variant='danger'
                            disabled={busy}
                            onClick={() =>
                                setConfirm({
                                    title: `Supprimer « ${job.name} » ?`,
                                    description: removalNote,
                                    confirmLabel: 'Supprimer le travail',
                                    onConfirm: () => void remove()
                                })
                            }
                        >
                            Supprimer le travail
                        </Button>
                    </div>
                </div>
            )}

            {error && <p className={shell.notice}>{error}</p>}

            <ConfirmDialog request={confirm} busy={busy} onClose={() => setConfirm(null)} />
        </div>
    );
}

/** Le dossier à envoyer : celui de la saisie pour une machine, rien pour les autres sources. */
function folderOf(kind: BackupSourceKind, deviceId: string | null, draft: FolderDraft): BackupFolder | null {
    if (kind !== 'deviceFolder' || !deviceId) return null;
    return {
        deviceId,
        path: draft.path.trim(),
        exclusions: draft.exclusions,
        oneFileSystem: draft.oneFileSystem
    };
}

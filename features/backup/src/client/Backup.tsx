import { useCallback, useEffect, useState } from 'react';
import type { FeatureViewProps } from '@deveye/types/sdk/client';
import type { BackupJob } from '../contracts/domain';

import {
    Button,
    FeatureSettingsButton,
    formatBytesFr,
    humanizeError,
    invalidate,
    useLiveSegment,
    useResource,
    useWorkspacePermissions
} from 'deveye-sdk-client';
import { api } from './api';
import JobDialog from './JobDialog';
import JobView from './JobView';
import {
    describeSchedule,
    DESTINATION_LABELS,
    formatAgo,
    formatIn,
    RUN_LABELS,
    runTone,
    SOURCE_LABELS
} from './format';
import styles from './style.module.css';

/**
 * Sauvegardes : ce qui part, où, et si c'est bien parti.
 *
 * Feature d'espace de premier rang, comme Git, Bases de données et Déploiement.
 * Deux moitiés qui ne se recouvrent pas : les **destinations** (rarement
 * touchées ; ce sont les sources de la feature, gérées dans Réglages → Sources)
 * et les **travaux**, qui sont ce qu'on vient regarder.
 *
 * L'écran est construit autour d'une seule question : « est-ce que mes
 * sauvegardes tournent ? ». Le dernier état de chaque travail est donc en
 * évidence sur la liste, et non caché derrière un clic : un travail cassé qui
 * ne se voit qu'en ouvrant sa fiche est un travail cassé qu'on ne voit pas.
 *
 * Ne demande jamais de mot de passe : tout vit à l'étage ouvert, condition pour
 * que l'ordonnanceur puisse écrire la nuit.
 */
export default function Backup(_props: FeatureViewProps) {
    const permissions = useWorkspacePermissions();
    const canWrite = permissions.canFeature('backup', 'write');

    const jobsResource = useResource(
        'backup.jobList',
        () => api.send('backup.jobList', {}).then((res) => res.jobs),
        'Impossible de charger les travaux de sauvegarde.'
    );
    // La liste des destinations n'est qu'un appoint de l'écran : son absence
    // ne doit pas masquer les travaux, qui sont l'essentiel. Son erreur n'est
    // donc jamais montrée ici.
    const { data: destinations } = useResource(
        'backup.destinationList',
        () => api.send('backup.destinationList', {}).then((res) => res.destinations),
        'Impossible de charger les destinations.'
    );
    const jobs = jobsResource.data;
    const [error, setError] = useState<string | null>(null);

    const [openedId, setOpenedId] = useState<number | null>(null);
    const [jobDialog, setJobDialog] = useState<{ job: BackupJob | null } | null>(null);

    const refresh = useCallback(() => invalidate('backup.jobList', 'backup.destinationList', 'backup.count'), []);

    const runNow = async (job: BackupJob) => {
        try {
            await api.send('backup.jobRun', { jobId: job.id });
            invalidate('backup.jobList', 'backup.detail', 'backup.count');
        } catch (e) {
            setError(humanizeError(e, 'Impossible de lancer cette sauvegarde.'));
        }
    };

    const opened = jobs?.find((j) => j.id === openedId) ?? null;

    // La fiche ouverte est un lieu : déclarée à la présence par son identifiant
    // nu, donc rejoignable, et atteignable par la téléportation de « Régler
    // dans <espace> » d'un élément projeté.
    const liveTarget = useLiveSegment('l1', openedId === null ? null : String(openedId));
    useEffect(() => {
        if (!liveTarget || !jobs) return;
        if (liveTarget.value === null) {
            setOpenedId(null);
            return;
        }
        const id = Number(liveTarget.value);
        // Pas encore chargé : la cible reste posée, le rendu suivant la relit.
        if (!Number.isInteger(id) || !jobs.some((j) => j.id === id)) return;
        setOpenedId(id);
    }, [liveTarget, jobs]);

    const destinationCount = destinations?.length ?? 0;

    return (
        <div className={styles.root}>
            {opened === null ? (
                <>
                    <div className={styles.toolbar}>
                        <div className={styles.toolbarInfo}>
                            <h2 className={styles.title}>Sauvegardes</h2>
                            <p className={styles.subtitle}>
                                {destinationCount === 0
                                    ? 'Aucune destination pour l’instant : le premier travail vous proposera d’en déclarer une, ou passez par Réglages → Sources.'
                                    : `${destinationCount} destination${destinationCount > 1 ? 's' : ''} déclarée${destinationCount > 1 ? 's' : ''}`}
                            </p>
                        </div>
                        <div className={styles.toolbarActions}>
                            {/* Les destinations vivaient derrière leur propre
                                bouton : elles sont dans Réglages → Sources,
                                comme les sources de toute feature. */}
                            <FeatureSettingsButton scope={{ kind: 'feature', feature: 'backup' }} />
                            {canWrite && (
                                <Button icon='plus' onClick={() => setJobDialog({ job: null })}>
                                    Nouveau travail
                                </Button>
                            )}
                        </div>
                    </div>

                    {(error ?? jobsResource.error) && <p className={styles.error}>{error ?? jobsResource.error}</p>}
                    {jobs === null && !jobsResource.error && <p className={styles.empty}>Chargement…</p>}
                    {jobs?.length === 0 && (
                        <p className={styles.empty}>
                            Aucune sauvegarde programmée. Le plus utile pour commencer : la base de DevEye, chaque nuit,
                            vers un endroit qui n’est pas ce serveur.
                        </p>
                    )}

                    {jobs && jobs.length > 0 && (
                        <ul className={styles.grid}>
                            {jobs.map((job) => (
                                <li key={job.id} className={styles.card}>
                                    <div
                                        className={styles.cardBody}
                                        role='button'
                                        tabIndex={0}
                                        onClick={() => setOpenedId(job.id)}
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter' || e.key === ' ') {
                                                e.preventDefault();
                                                setOpenedId(job.id);
                                            }
                                        }}
                                    >
                                        <p className={styles.cardName}>
                                            <span
                                                className={styles.statusDot}
                                                data-tone={job.enabled ? runTone(job.lastStatus) : 'neutral'}
                                                aria-hidden='true'
                                            />
                                            {job.name}
                                            {job.foreign && (
                                                <span
                                                    className={styles.statusTag}
                                                    data-tone='neutral'
                                                    title='Ce travail appartient à un autre espace qui le partage ici'
                                                >
                                                    partagé
                                                </span>
                                            )}
                                        </p>
                                        <p className={styles.cardMeta}>
                                            {SOURCE_LABELS[job.source]} → {job.destinationName} (
                                            {DESTINATION_LABELS[job.destinationKind]})
                                        </p>
                                        <p className={styles.cardMeta}>
                                            {describeSchedule(job)}
                                            {job.enabled ? ` · ${formatIn(job.nextRunAt)}` : ' · désactivé'}
                                        </p>
                                        <div className={styles.cardFoot}>
                                            <span className={styles.statusTag} data-tone={runTone(job.lastStatus)}>
                                                {job.lastStatus ? RUN_LABELS[job.lastStatus] : 'jamais'}
                                            </span>
                                            <span>{formatAgo(job.lastRunAt)}</span>
                                            {job.totalBytes > 0 && <span>{formatBytesFr(job.totalBytes)}</span>}
                                            <span>
                                                {job.runCount} passage{job.runCount > 1 ? 's' : ''}
                                            </span>
                                        </div>
                                        {job.lastError && <p className={styles.rowError}>{job.lastError}</p>}
                                    </div>
                                </li>
                            ))}
                        </ul>
                    )}
                </>
            ) : (
                <JobView
                    job={opened}
                    canWrite={canWrite}
                    running={opened.lastStatus === 'running'}
                    onBack={() => setOpenedId(null)}
                    onEdit={() => setJobDialog({ job: opened })}
                    onRun={() => void runNow(opened)}
                />
            )}

            <JobDialog
                open={jobDialog !== null}
                job={jobDialog?.job ?? null}
                destinations={destinations ?? []}
                onClose={() => setJobDialog(null)}
                onSaved={refresh}
                onRemoved={() => {
                    setJobDialog(null);
                    setOpenedId(null);
                    refresh();
                }}
            />
        </div>
    );
}

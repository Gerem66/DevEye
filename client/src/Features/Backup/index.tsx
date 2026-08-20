import { useCallback, useEffect, useState } from 'react';
import type { BackupDestination, BackupJob } from 'deveye-types';

import { Button, Dialog } from '@/Components';
import { ws } from '@/api/ws';
import { FeatureSettingsButton } from '@/Components/FeatureSettings';
import { invalidate, useResourceVersion } from '@/stores/invalidation';
import { useWorkspacePermissions } from '@/stores/workspace';
import type { FeatureProps } from '@/Features/types';
import DestinationDialog from './DestinationDialog';
import DestinationsPanel from './DestinationsPanel';
import JobDialog from './JobDialog';
import JobView from './JobView';
import {
    backupError,
    describeSchedule,
    DESTINATION_LABELS,
    formatAgo,
    formatBytes,
    formatIn,
    RUN_LABELS,
    runTone,
    SOURCE_LABELS
} from './format';
import styles from './style.module.css';

/**
 * Sauvegardes — ce qui part, où, et si c'est bien parti.
 *
 * Feature d'espace de premier rang, comme Git, Bases de données et Déploiement.
 * Deux moitiés qui ne se recouvrent pas : les **destinations** (rarement
 * touchées, rangées dans leur propre dialogue) et les **travaux**, qui sont ce
 * qu'on vient regarder.
 *
 * L'écran est construit autour d'une seule question : « est-ce que mes
 * sauvegardes tournent ? ». Le dernier état de chaque travail est donc en
 * évidence sur la liste, et non caché derrière un clic — un travail cassé qui
 * ne se voit qu'en ouvrant sa fiche est un travail cassé qu'on ne voit pas.
 *
 * Ne demande jamais de mot de passe : tout vit à l'étage ouvert, condition pour
 * que l'ordonnanceur puisse écrire la nuit.
 */
export function FeatureBackup(_props: FeatureProps) {
    const permissions = useWorkspacePermissions();
    const canWrite = permissions.canFeature('backup', 'write');

    const [jobs, setJobs] = useState<BackupJob[] | null>(null);
    const [destinations, setDestinations] = useState<BackupDestination[]>([]);
    const [error, setError] = useState<string | null>(null);

    const [openedId, setOpenedId] = useState<number | null>(null);
    const [destinationsOpen, setDestinationsOpen] = useState(false);
    const [destinationDialog, setDestinationDialog] = useState<{ destination: BackupDestination | null } | null>(null);
    const [jobDialog, setJobDialog] = useState<{ job: BackupJob | null } | null>(null);
    const [confirmRemove, setConfirmRemove] = useState<BackupJob | null>(null);

    const jobsVersion = useResourceVersion('backup.jobList');
    const destinationsVersion = useResourceVersion('backup.destinationList');

    const loadJobs = useCallback(async () => {
        try {
            const res = await ws.send('backup.jobList', {});
            setJobs(res.jobs);
            setError(null);
        } catch (e) {
            setError(backupError(e, 'Impossible de charger les travaux de sauvegarde.'));
        }
    }, []);

    const loadDestinations = useCallback(async () => {
        try {
            const res = await ws.send('backup.destinationList', {});
            setDestinations(res.destinations);
        } catch {
            // La liste des destinations n'est qu'un appoint de l'écran : son
            // absence ne doit pas masquer les travaux, qui sont l'essentiel.
        }
    }, []);

    useEffect(() => {
        void loadJobs();
    }, [loadJobs, jobsVersion]);

    useEffect(() => {
        void loadDestinations();
    }, [loadDestinations, destinationsVersion]);

    const refresh = useCallback(() => {
        invalidate('backup.jobList');
        invalidate('backup.destinationList');
        invalidate('backup.count');
    }, []);

    const runNow = async (job: BackupJob) => {
        try {
            await ws.send('backup.jobRun', { jobId: job.id });
            invalidate('backup.jobList');
            invalidate('backup.detail');
            invalidate('backup.count');
        } catch (e) {
            setError(backupError(e, 'Impossible de lancer cette sauvegarde.'));
        }
    };

    const removeJob = async (job: BackupJob) => {
        try {
            await ws.send('backup.jobRemove', { jobId: job.id });
            setConfirmRemove(null);
            setOpenedId(null);
            refresh();
        } catch (e) {
            setError(backupError(e, 'Impossible de supprimer ce travail.'));
        }
    };

    const opened = jobs?.find((j) => j.id === openedId) ?? null;

    return (
        <div className={styles.root}>
            {opened === null ? (
                <>
                    <div className={styles.toolbar}>
                        <div className={styles.toolbarInfo}>
                            <h2 className={styles.title}>Sauvegardes</h2>
                            <p className={styles.subtitle}>
                                {destinations.length === 0
                                    ? 'Commencez par déclarer une destination : un dossier du serveur, une machine, ou un bucket S3.'
                                    : `${destinations.length} destination${destinations.length > 1 ? 's' : ''} déclarée${destinations.length > 1 ? 's' : ''}`}
                            </p>
                        </div>
                        <div className={styles.toolbarActions}>
                            <Button variant='ghost' icon='server' onClick={() => setDestinationsOpen(true)}>
                                Destinations
                            </Button>
                            {canWrite && (
                                <>
                                    <FeatureSettingsButton
                                        scope={{ kind: 'feature', feature: 'backup' }}
                                        variant='ghost'
                                    />
                                    <Button
                                        icon='plus'
                                        disabled={destinations.length === 0}
                                        title={
                                            destinations.length === 0 ? 'Déclarez d’abord une destination' : undefined
                                        }
                                        onClick={() => setJobDialog({ job: null })}
                                    >
                                        Nouveau travail
                                    </Button>
                                </>
                            )}
                        </div>
                    </div>

                    {error && <p className={styles.error}>{error}</p>}
                    {jobs === null && <p className={styles.empty}>Chargement…</p>}
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
                                            {job.totalBytes > 0 && <span>{formatBytes(job.totalBytes)}</span>}
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
                    onRemove={() => setConfirmRemove(opened)}
                />
            )}

            <DestinationsPanel
                open={destinationsOpen}
                destinations={destinations}
                canWrite={canWrite}
                onClose={() => setDestinationsOpen(false)}
                onCreate={() => setDestinationDialog({ destination: null })}
                onEdit={(destination) => setDestinationDialog({ destination })}
                onChanged={refresh}
            />

            <DestinationDialog
                open={destinationDialog !== null}
                destination={destinationDialog?.destination ?? null}
                onClose={() => setDestinationDialog(null)}
                onSaved={refresh}
            />

            <JobDialog
                open={jobDialog !== null}
                job={jobDialog?.job ?? null}
                destinations={destinations}
                onClose={() => setJobDialog(null)}
                onSaved={refresh}
            />

            <Dialog
                open={confirmRemove !== null}
                onClose={() => setConfirmRemove(null)}
                onSubmit={() => confirmRemove && void removeJob(confirmRemove)}
                title='Supprimer ce travail ?'
                description='Son historique part avec lui. Les archives déjà écrites, elles, restent où elles sont — à vous de les effacer si vous le souhaitez.'
                width={480}
                footer={
                    <>
                        <Button variant='ghost' onClick={() => setConfirmRemove(null)}>
                            Annuler
                        </Button>
                        <Button variant='danger' onClick={() => confirmRemove && void removeJob(confirmRemove)}>
                            Supprimer
                        </Button>
                    </>
                }
            />
        </div>
    );
}

export default FeatureBackup;

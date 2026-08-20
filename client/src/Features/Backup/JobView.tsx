import { useCallback, useEffect, useState } from 'react';
import type { BackupJob, BackupRun } from 'deveye-types';

import { Button, StatusBadge } from '@/Components';
import { ws } from '@/api/ws';
import { useResourceVersion } from '@/stores/invalidation';
import {
    backupError,
    describeSchedule,
    DESTINATION_LABELS,
    formatAgo,
    formatBytes,
    formatIn,
    formatMoment,
    RUN_LABELS,
    runTone,
    SOURCE_LABELS
} from './format';
import styles from './style.module.css';
import { FeatureSettingsButton } from '@/Components/FeatureSettings';

interface JobViewProps {
    job: BackupJob;
    canWrite: boolean;
    onBack: () => void;
    onEdit: () => void;
    onRun: () => void;
    running: boolean;
}

/**
 * La fiche d'un travail : ses réglages en tête, son historique en dessous.
 *
 * L'historique est **la** raison d'ouvrir cette fiche. Une sauvegarde ne se juge
 * pas sur sa configuration mais sur ce qu'elle a réellement produit : une
 * cadence quotidienne dont la dernière archive date de trois semaines est un
 * travail cassé, quoi que dise son formulaire.
 */
export function JobView({ job, canWrite, onBack, onEdit, onRun, running }: JobViewProps) {
    const [runs, setRuns] = useState<BackupRun[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const version = useResourceVersion('backup.detail');

    const reload = useCallback(async () => {
        try {
            const res = await ws.send('backup.jobGet', { jobId: job.id, limit: 50 });
            setRuns(res.runs);
            setError(null);
        } catch (e) {
            setError(backupError(e, 'Impossible de charger l’historique.'));
        }
    }, [job.id]);

    useEffect(() => {
        void reload();
    }, [reload, version]);

    return (
        <div className={styles.detail}>
            {/* Retour, titre, actions : une seule rangée, la même que dans les
                fiches des autres features. Le titre vivait dessous, et la
                suppression avait son bouton ici — elle vit désormais dans le
                dialogue de modification, comme pour une cible ou un dépôt. */}
            <div className={styles.detailHead}>
                <Button variant='ghost' icon='arrow-left' onClick={onBack}>
                    Travaux
                </Button>
                <h2 className={styles.detailTitle}>
                    {job.name}
                    {/* Sans cette pastille, rien ne distingue un travail local
                        d'une fenêtre sur l'espace voisin. */}
                    {job.foreign && (
                        <span title='Ce travail appartient à un autre espace qui le partage ici'>
                            {' '}
                            <StatusBadge tone='accent'>partagé</StatusBadge>
                        </span>
                    )}
                </h2>
                <div className={styles.detailActions}>
                    {canWrite && (
                        <Button
                            icon={running ? 'spinner' : 'play'}
                            disabled={running}
                            onClick={onRun}
                            title='Lancer une sauvegarde maintenant'
                        >
                            {running ? 'En cours…' : 'Sauvegarder'}
                        </Button>
                    )}
                    {/* `!job.foreign` : la destination et la source d'un travail
                        se choisissent parmi les objets de SON espace — le
                        serveur le refuse, l'écran ne le propose donc pas.
                        Sauvegarder, lui, reste permis : c'est tout l'objet de
                        la projection. */}
                    {canWrite && !job.foreign && (
                        <Button variant='secondary' icon='edit' onClick={onEdit}>
                            Modifier
                        </Button>
                    )}
                    {/* Les réglages **de ce travail** : ses propres canaux, ou
                        ceux des Sauvegardes tant qu'il les suit. */}
                    <FeatureSettingsButton
                        scope={{ kind: 'item', feature: 'backup', itemId: job.id, itemLabel: job.name }}
                    />
                </div>
            </div>

            <div className={styles.facts}>
                <Fact label='Source'>
                    {SOURCE_LABELS[job.source]}
                    {job.sourceName && job.source !== 'deveye' ? ` — ${job.sourceName}` : ''}
                    {job.source !== 'deveye' && job.sourceName === null && (
                        <span className={styles.factWarn}> — supprimée</span>
                    )}
                </Fact>
                <Fact label='Destination'>
                    {job.destinationName} ({DESTINATION_LABELS[job.destinationKind]})
                </Fact>
                <Fact label='Cadence'>{describeSchedule(job)}</Fact>
                <Fact label='Prochain passage'>{job.enabled ? formatIn(job.nextRunAt) : 'travail désactivé'}</Fact>
                <Fact label='Copies conservées'>{job.keepLast}</Fact>
                <Fact label='Occupation'>{formatBytes(job.totalBytes)}</Fact>
            </div>

            {job.lastError && <p className={styles.error}>Dernier échec : {job.lastError}</p>}
            {error && <p className={styles.error}>{error}</p>}

            <h3 className={styles.sectionTitle}>Historique</h3>
            {runs === null && <p className={styles.empty}>Chargement…</p>}
            {runs?.length === 0 && <p className={styles.empty}>Ce travail n’a encore jamais tourné.</p>}
            {runs && runs.length > 0 && (
                <ul className={styles.runs}>
                    {runs.map((run) => (
                        <li key={run.id} className={styles.run}>
                            <span className={styles.statusTag} data-tone={runTone(run.status)}>
                                {RUN_LABELS[run.status]}
                            </span>
                            <div className={styles.runMain}>
                                <p className={styles.runTitle}>
                                    {formatMoment(run.startedAt)}
                                    {run.status === 'success' && (
                                        <>
                                            {' · '}
                                            {formatBytes(run.sizeBytes)}
                                            {run.encrypted ? ' · chiffrée' : ''}
                                            {run.pruned ? ' · effacée par rétention' : ''}
                                        </>
                                    )}
                                </p>
                                {run.artifact && !run.pruned && <p className={styles.runPath}>{run.artifact}</p>}
                                {run.error && <p className={styles.rowError}>{run.error}</p>}
                                {/* Le condensé est du **clair**, avant scellement :
                                    c'est lui qui permet de vérifier une
                                    restauration sans faire confiance à la
                                    destination. */}
                                {run.checksum && <p className={styles.runHash}>sha256 : {run.checksum}</p>}
                            </div>
                            <span className={styles.runAgo}>{formatAgo(run.startedAt)}</span>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div className={styles.fact}>
            <span className={styles.factLabel}>{label}</span>
            <span className={styles.factValue}>{children}</span>
        </div>
    );
}

export default JobView;

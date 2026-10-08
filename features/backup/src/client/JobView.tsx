import { useState, type ReactNode } from 'react';
import type { BackupJob, BackupRun } from '../contracts/domain';

import {
    Button,
    ConfirmDialog,
    FeatureSettingsButton,
    formatBytesFr,
    humanizeError,
    StatusBadge,
    useResource,
    type ConfirmRequest
} from 'deveye-sdk-client';
import { api } from './api';
import {
    describeSchedule,
    DESTINATION_LABELS,
    formatAgo,
    formatIn,
    formatMoment,
    RUN_LABELS,
    runTone,
    SOURCE_LABELS
} from './format';
import styles from './style.module.css';

interface JobViewProps {
    job: BackupJob;
    canWrite: boolean;
    onBack: () => void;
    onRun: () => void;
    running: boolean;
}

/** La fiche d'un travail : ses réglages en tête, son historique en dessous. */
export default function JobView({ job, canWrite, onBack, onRun, running }: JobViewProps) {
    const {
        data: runs,
        error,
        reload
    } = useResource(
        'backup.detail',
        () => api.send('backup.jobGet', { jobId: job.id, limit: 50 }).then((res) => res.runs),
        'Impossible de charger l’historique.',
        [job.id]
    );
    const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
    const [busy, setBusy] = useState(false);
    const [removeError, setRemoveError] = useState<string | null>(null);
    // Un travail projeté s'administre chez lui : ses archives aussi.
    const canErase = canWrite && !job.foreign;

    const doErase = async (run: BackupRun): Promise<void> => {
        setBusy(true);
        setRemoveError(null);
        try {
            await api.send('backup.runRemove', { runId: run.id });
            reload();
        } catch (failure) {
            setRemoveError(humanizeError(failure, 'La sauvegarde n’a pas pu être effacée.'));
        } finally {
            setBusy(false);
        }
    };
    const erase = (run: BackupRun): void =>
        setConfirm({
            title: 'Effacer cette sauvegarde ?',
            description: `L’archive du ${formatMoment(run.startedAt)} est effacée de sa destination, sans retour possible. La place qu’elle occupait se libère.`,
            confirmLabel: 'Effacer',
            onConfirm: () => void doErase(run)
        });

    return (
        <div className={styles.detail}>
            <div className={styles.detailHead}>
                <Button variant='ghost' icon='arrow-left' onClick={onBack}>
                    Travaux
                </Button>
                <h2 className={styles.detailTitle}>
                    {job.name}
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
                    {/* Les réglages de ce travail, sa suppression comprise
                        (onglet Général) ; un travail projeté se modifie chez
                        lui, le sauvegarder d'ici reste permis. Supprimé ou
                        déplacé depuis la coquille, le travail n'est plus ici :
                        la fiche revient à la liste. */}
                    <FeatureSettingsButton
                        scope={{ kind: 'item', feature: 'backup', itemId: String(job.id), itemLabel: job.name }}
                        onGone={onBack}
                    />
                </div>
            </div>

            <div className={styles.facts}>
                <Fact label='Source'>
                    {SOURCE_LABELS[job.source]}
                    {job.sourceName && job.source !== 'deveye' ? ` : ${job.sourceName}` : ''}
                    {job.source !== 'deveye' && job.sourceName === null && (
                        <span className={styles.factWarn}> (supprimée)</span>
                    )}
                </Fact>
                {job.author && (
                    <Fact label='Au nom de'>
                        {job.author.name ?? <span className={styles.factWarn}>un ancien membre</span>}
                    </Fact>
                )}
                <Fact label='Destination'>
                    {job.destinationName} ({DESTINATION_LABELS[job.destinationKind]})
                </Fact>
                <Fact label='Cadence'>{describeSchedule(job)}</Fact>
                <Fact label='Prochain passage'>{job.enabled ? formatIn(job.nextRunAt) : 'travail désactivé'}</Fact>
                <Fact label='Copies conservées'>{job.keepLast}</Fact>
                <Fact label='Occupation'>{formatBytesFr(job.totalBytes)}</Fact>
            </div>

            {job.lastError && <p className={styles.error}>Dernier échec : {job.lastError}</p>}
            {error && <p className={styles.error}>{error}</p>}
            {removeError && <p className={styles.error}>{removeError}</p>}

            <h3 className={styles.sectionTitle}>Historique</h3>
            {runs === null && !error && <p className={styles.empty}>Chargement…</p>}
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
                                            {formatBytesFr(run.sizeBytes)}
                                            {run.encrypted ? ' · chiffrée' : ''}
                                            {run.pruned ? ' · archive effacée' : ''}
                                        </>
                                    )}
                                </p>
                                {run.artifact && !run.pruned && <p className={styles.runPath}>{run.artifact}</p>}
                                {run.error && <p className={styles.rowError}>{run.error}</p>}
                                {run.warning && <p className={styles.runWarning}>{run.warning}</p>}
                                {/* Condensé du clair, avant scellement : vérifie une
                                    restauration sans faire confiance à la destination. */}
                                {run.checksum && <p className={styles.runHash}>sha256 : {run.checksum}</p>}
                            </div>
                            <span className={styles.runAgo}>{formatAgo(run.startedAt)}</span>
                            {canErase && run.status === 'success' && !run.pruned && (
                                <Button
                                    variant='ghost'
                                    icon='trash'
                                    disabled={busy}
                                    title='Effacer cette sauvegarde'
                                    aria-label={`Effacer la sauvegarde du ${formatMoment(run.startedAt)}`}
                                    onClick={() => erase(run)}
                                />
                            )}
                        </li>
                    ))}
                </ul>
            )}

            <ConfirmDialog request={confirm} busy={busy} onClose={() => setConfirm(null)} />
        </div>
    );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
    return (
        <div className={styles.fact}>
            <span className={styles.factLabel}>{label}</span>
            <span className={styles.factValue}>{children}</span>
        </div>
    );
}

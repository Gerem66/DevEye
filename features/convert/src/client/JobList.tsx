import { Button, formatBytesFr, StatusBadge } from 'deveye-sdk-client';

import { CATALOGUE } from '../contracts/catalogue';
import type { ConvertJob, ConvertProgress } from '../contracts/domain';
import { ERROR_LABELS, formatDuration, formatRemaining, PHASE_LABELS } from './format';
import { ProgressBar } from './ProgressBar';
import styles from './style.module.css';

const TONES = {
    awaiting_upload: 'neutral',
    uploading: 'accent',
    queued: 'neutral',
    running: 'accent',
    done: 'success',
    error: 'danger',
    canceled: 'neutral',
    expired: 'neutral'
} as const;

function formatLabel(job: ConvertJob): string {
    const kind = CATALOGUE.find((k) => k.id === job.kind);
    const source = kind?.sources.find((s) => s.id === job.sourceFormat)?.label ?? job.sourceFormat;
    const target = kind?.targets.find((t) => t.id === job.targetFormat)?.label ?? job.targetFormat;
    return `${source} vers ${target}`;
}

interface JobRowProps {
    job: ConvertJob;
    live?: ConvertProgress;
    canWrite: boolean;
    onDownload: (job: ConvertJob) => void;
    onCancel: (job: ConvertJob) => void;
    onRemove: (job: ConvertJob) => void;
}

export function JobRow({ job, live, canWrite, onDownload, onCancel, onRemove }: JobRowProps) {
    const busy = job.phase === 'queued' || job.phase === 'running' || job.phase === 'uploading';
    const progress = (live?.progress ?? job.progress) / 1000;
    return (
        <li className={styles.job}>
            <div className={styles.jobHead}>
                <span className={styles.jobName}>{job.originalName ?? 'Fichier'}</span>
                <StatusBadge tone={TONES[job.phase]} dot>
                    {PHASE_LABELS[job.phase]}
                </StatusBadge>
            </div>
            <div className={styles.jobMeta}>
                <span>{formatLabel(job)}</span>
                <span>
                    {formatBytesFr(job.inputBytes)}
                    {job.outputBytes !== null && ` → ${formatBytesFr(job.outputBytes)}`}
                </span>
                {job.phase === 'done' && job.expiresAt !== null && <span>Retiré {formatRemaining(job.expiresAt)}</span>}
                {job.phase === 'running' && live?.etaSeconds != null && (
                    <span>Encore {formatDuration(live.etaSeconds)}</span>
                )}
            </div>
            {busy && (
                <ProgressBar
                    label={`Avancement de ${job.originalName ?? 'la conversion'}`}
                    ratio={job.phase === 'running' && progress > 0 ? progress : null}
                />
            )}
            {job.phase === 'error' && (
                <p className={styles.jobError}>
                    {job.errorMessage ?? (job.errorCode ? ERROR_LABELS[job.errorCode] : ERROR_LABELS.engine_failed)}
                </p>
            )}
            <div className={styles.jobActions}>
                {job.phase === 'done' && (
                    <Button variant='primary' icon='download' onClick={() => onDownload(job)}>
                        Télécharger
                    </Button>
                )}
                {canWrite && busy && (
                    <Button variant='ghost' onClick={() => onCancel(job)}>
                        Annuler
                    </Button>
                )}
                {canWrite && !busy && job.phase !== 'awaiting_upload' && (
                    <Button variant='ghost' icon='trash' onClick={() => onRemove(job)}>
                        Retirer
                    </Button>
                )}
            </div>
        </li>
    );
}

interface JobListProps extends Omit<JobRowProps, 'job' | 'live'> {
    jobs: readonly ConvertJob[];
    live: ReadonlyMap<number, ConvertProgress>;
}

export function JobList({ jobs, live, ...actions }: JobListProps) {
    if (jobs.length === 0) return null;
    return (
        <section className={styles.jobs} aria-labelledby='convert-jobs-title'>
            <h3 id='convert-jobs-title' className={styles.sectionTitle}>
                Mes conversions
            </h3>
            <ul className={styles.jobList}>
                {jobs.map((job) => (
                    <JobRow key={job.id} job={job} live={live.get(job.id)} {...actions} />
                ))}
            </ul>
        </section>
    );
}

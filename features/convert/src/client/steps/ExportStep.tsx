import { Button, formatBytesFr } from 'deveye-sdk-client';

import type { SourceFormat, TargetFormat } from '../../contracts/catalogue';
import { outputName } from '../../contracts/catalogue';
import type { ConvertJob, ConvertProgress } from '../../contracts/domain';
import type { SizeEstimate } from '../../contracts/estimate';
import { ERROR_LABELS, formatDuration, formatRemaining, formatTtl } from '../format';
import { ProgressBar } from '../ProgressBar';
import { SizeSummary } from '../SizeSummary';
import styles from '../style.module.css';
import type { Wizard } from '../useWizard';

/** Où en est l'envoi. À 100 % le serveur écrit et vérifie encore : l'écran le dit au lieu de rester figé. */
export type Sending = { stage: 'uploading'; ratio: number } | { stage: 'verifying' };

/**
 * Le travail né de cet export, suivi jusqu'à son terme. `gone` : il n'est plus
 * dans la liste (résultat échu, ou retiré depuis un autre onglet).
 */
export interface Tracked {
    job: ConvertJob;
    progress: ConvertProgress | undefined;
    gone: boolean;
}

/** L'export est parti et n'a pas échoué : les étapes d'avant ne se rouvrent plus jusqu'à la conversion suivante. */
export function isLocked(sending: Sending | null, tracked: Tracked | null): boolean {
    if (sending) return true;
    return tracked !== null && !tracked.gone && tracked.job.phase !== 'error' && tracked.job.phase !== 'canceled';
}

interface ExportStepProps {
    wizard: Wizard;
    source: SourceFormat;
    target: TargetFormat;
    estimate: SizeEstimate | null;
    pending: boolean;
    sending: Sending | null;
    tracked: Tracked | null;
    error: string | null;
    canWrite: boolean;
    resultTtlSeconds: number | null;
    onExport: () => void;
    onAbortUpload: () => void;
    onCancel: () => void;
    onDownload: () => void;
    onNew: () => void;
}

function Status({ sending, tracked }: Pick<ExportStepProps, 'sending' | 'tracked'>) {
    if (sending) {
        return (
            <div className={styles.status}>
                <span>
                    {sending.stage === 'uploading'
                        ? `Envoi du fichier : ${Math.round(sending.ratio * 100)} %`
                        : 'Vérification du fichier…'}
                </span>
                <ProgressBar label='Envoi du fichier' ratio={sending.stage === 'uploading' ? sending.ratio : null} />
            </div>
        );
    }
    if (!tracked) return null;
    const { job, progress, gone } = tracked;
    if (gone)
        return <p className={styles.note}>Cette conversion n’est plus sur le serveur : son résultat a été retiré.</p>;
    if (job.phase === 'canceled') return <p className={styles.note}>Conversion annulée.</p>;
    if (job.phase === 'error') {
        return (
            <p className={styles.problem} role='alert'>
                {job.errorMessage ?? (job.errorCode ? ERROR_LABELS[job.errorCode] : ERROR_LABELS.engine_failed)}
            </p>
        );
    }
    if (job.phase === 'done') {
        return (
            <p className={styles.success}>
                Votre fichier est prêt{job.outputBytes !== null && ` : ${formatBytesFr(job.outputBytes)}`}.
                {job.expiresAt !== null && ` Il sera retiré du serveur ${formatRemaining(job.expiresAt)}.`}
            </p>
        );
    }
    const ratio = (progress?.progress ?? job.progress) / 1000;
    const running = job.phase === 'running';
    return (
        <div className={styles.status}>
            <span>
                {running ? `Conversion en cours : ${Math.round(ratio * 100)} %` : 'En file d’attente…'}
                {running && progress?.etaSeconds != null && ` · encore ${formatDuration(progress.etaSeconds)}`}
            </span>
            <ProgressBar label='Avancement de la conversion' ratio={running && ratio > 0 ? ratio : null} />
        </div>
    );
}

export function ExportStep(props: ExportStepProps) {
    const { wizard, source, target, sending, tracked } = props;
    const file = wizard.state.file;
    if (!file) return null;

    const locked = isLocked(sending, tracked);
    const done = locked && tracked?.job.phase === 'done';
    const produced = done && tracked.job.outputBytes !== null ? { bytes: tracked.job.outputBytes, exact: true } : null;

    return (
        <div className={styles.stepBody}>
            <div className={styles.recapBox}>
                <dl className={styles.recap}>
                    <div>
                        <dt>Fichier</dt>
                        <dd>{file.name}</dd>
                    </div>
                    <div>
                        <dt>Conversion</dt>
                        <dd>
                            {source.label} vers {target.label}
                        </dd>
                    </div>
                    <div>
                        <dt>Nom du résultat</dt>
                        <dd>{outputName(file.name, target)}</dd>
                    </div>
                </dl>
                <SizeSummary inputBytes={file.size} estimate={produced ?? props.estimate} pending={props.pending} />
            </div>

            <div aria-live='polite'>
                <Status sending={sending} tracked={tracked} />
            </div>
            {props.error && (
                <p className={styles.problem} role='alert'>
                    {props.error}
                </p>
            )}
            {!props.canWrite && (
                <p className={styles.note}>Votre rôle dans cet espace ne permet pas de lancer une conversion.</p>
            )}
            {props.resultTtlSeconds !== null && !locked && (
                <ul className={styles.promises}>
                    <li>Votre fichier d’origine est supprimé du serveur dès que la conversion est terminée.</li>
                    <li>
                        Le fichier converti reste téléchargeable pendant {formatTtl(props.resultTtlSeconds)}, puis il
                        est supprimé à son tour.
                    </li>
                </ul>
            )}

            <div className={styles.stepNav}>
                {sending ? (
                    <Button variant='ghost' onClick={props.onAbortUpload}>
                        Annuler l’envoi
                    </Button>
                ) : done || tracked?.gone ? (
                    <Button variant='ghost' icon='plus' onClick={props.onNew}>
                        Nouvelle conversion
                    </Button>
                ) : locked ? (
                    <Button variant='ghost' disabled={!props.canWrite} onClick={props.onCancel}>
                        Annuler la conversion
                    </Button>
                ) : (
                    <Button variant='ghost' icon='arrow-left' onClick={() => wizard.open('options')}>
                        Options
                    </Button>
                )}
                {done ? (
                    <Button variant='primary' icon='download' onClick={props.onDownload}>
                        Télécharger
                    </Button>
                ) : (
                    !tracked?.gone && (
                        <Button variant='primary' disabled={locked || !props.canWrite} onClick={props.onExport}>
                            {locked ? 'Conversion…' : 'Exporter'}
                        </Button>
                    )
                )}
            </div>
        </div>
    );
}

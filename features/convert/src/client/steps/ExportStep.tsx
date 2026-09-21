import { Button } from 'deveye-sdk-client';

import type { SourceFormat, TargetFormat } from '../../contracts/catalogue';
import { outputName } from '../../contracts/catalogue';
import type { SizeEstimate } from '../../contracts/estimate';
import { formatTtl } from '../format';
import { ProgressBar } from '../ProgressBar';
import { SizeSummary } from '../SizeSummary';
import styles from '../style.module.css';
import type { Wizard } from '../useWizard';

/** Où en est l'envoi. À 100 % le serveur écrit et vérifie encore : l'écran le dit au lieu de rester figé. */
export type Sending = { stage: 'uploading'; ratio: number } | { stage: 'verifying' };

interface ExportStepProps {
    wizard: Wizard;
    source: SourceFormat;
    target: TargetFormat;
    estimate: SizeEstimate | null;
    sending: Sending | null;
    error: string | null;
    canWrite: boolean;
    resultTtlSeconds: number | null;
    onExport: () => void;
    onAbort: () => void;
}

export function ExportStep(props: ExportStepProps) {
    const { wizard, source, target, estimate, sending, error } = props;
    const file = wizard.state.file;
    if (!file) return null;

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
                <SizeSummary inputBytes={file.size} estimate={estimate} />
            </div>

            {sending && (
                <div className={styles.sending} aria-live='polite'>
                    <span>
                        {sending.stage === 'uploading'
                            ? `Envoi du fichier : ${Math.round(sending.ratio * 100)} %`
                            : 'Vérification du fichier…'}
                    </span>
                    <ProgressBar
                        label='Envoi du fichier'
                        ratio={sending.stage === 'uploading' ? sending.ratio : null}
                    />
                </div>
            )}
            {error && (
                <p className={styles.problem} role='alert'>
                    {error}
                </p>
            )}
            {!props.canWrite && (
                <p className={styles.note}>Votre rôle dans cet espace ne permet pas de lancer une conversion.</p>
            )}
            {props.resultTtlSeconds !== null && !sending && (
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
                    <Button variant='ghost' onClick={props.onAbort}>
                        Annuler l’envoi
                    </Button>
                ) : (
                    <Button variant='ghost' icon='arrow-left' onClick={() => wizard.open('options')}>
                        Options
                    </Button>
                )}
                <Button variant='primary' disabled={sending !== null || !props.canWrite} onClick={props.onExport}>
                    Exporter
                </Button>
            </div>
        </div>
    );
}

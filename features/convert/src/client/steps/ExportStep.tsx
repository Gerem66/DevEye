import { Button, formatBytesFr } from 'deveye-sdk-client';

import type { SourceFormat, TargetFormat } from '../../contracts/catalogue';
import { outputName } from '../../contracts/catalogue';
import type { SizeEstimate } from '../../contracts/estimate';
import { ProgressBar } from '../ProgressBar';
import styles from '../style.module.css';
import type { Wizard } from '../useWizard';
import { EstimateLine } from './OptionsStep';

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
            <dl className={styles.recap}>
                <div>
                    <dt>Fichier</dt>
                    <dd>
                        {file.name} <span className={styles.fileMeta}>({formatBytesFr(file.size)})</span>
                    </dd>
                </div>
                <div>
                    <dt>Conversion</dt>
                    <dd>
                        {source.label} vers {target.label}
                    </dd>
                </div>
                <div>
                    <dt>Résultat</dt>
                    <dd>
                        {outputName(file.name, target)}
                        <br />
                        <EstimateLine estimate={estimate} inputBytes={file.size} />
                    </dd>
                </div>
            </dl>

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
                <p className={styles.note}>
                    Le fichier converti reste disponible {Math.round(props.resultTtlSeconds / 60)} minutes, puis il est
                    retiré du serveur, comme l’original dès la conversion finie.
                </p>
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

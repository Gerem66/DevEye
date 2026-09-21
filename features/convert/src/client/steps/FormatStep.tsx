import { Button, formatBytesFr, SelectInput } from 'deveye-sdk-client';

import { kindOf, targetsFor } from '../../contracts/catalogue';
import type { ConvertFamily } from '../../contracts/domain';
import { Dropzone } from '../Dropzone';
import { KIND_NOUNS } from '../format';
import styles from '../style.module.css';
import type { Wizard } from '../useWizard';

interface FormatStepProps {
    wizard: Wizard;
    family: ConvertFamily | undefined;
    /** Pourquoi ce fichier ne peut pas partir (trop lourd pour l'offre). `null` : rien ne s'y oppose. */
    fileProblem: string | null;
}

export function FormatStep({ wizard, family, fileProblem }: FormatStepProps) {
    const { state } = wizard;
    if (!state.kind) return null;
    const kind = kindOf(state.kind);
    const sources = kind.sources.filter((s) => !family?.missingSources.includes(s.id));
    const targets = state.sourceId
        ? targetsFor(state.kind, state.sourceId).filter((t) => !family?.missingTargets.includes(t.id))
        : [];
    const accept = sources.flatMap((s) => s.ext.map((e) => `.${e}`)).join(',');

    return (
        <div className={styles.stepBody}>
            {state.file ? (
                <div className={styles.fileChip}>
                    <div className={styles.fileChipText}>
                        <span className={styles.fileName}>{state.file.name}</span>
                        <span className={styles.fileMeta}>{formatBytesFr(state.file.size)}</span>
                    </div>
                    <Dropzone compact title='Changer de fichier' accept={accept} onFile={wizard.pickFile} />
                </div>
            ) : (
                <Dropzone
                    title={`Choisissez ${KIND_NOUNS[state.kind]}`}
                    hint='Déposez le fichier ici, ou cliquez pour le choisir.'
                    accept={accept}
                    onFile={wizard.pickFile}
                />
            )}
            {fileProblem && (
                <p className={styles.problem} role='alert'>
                    {fileProblem}
                </p>
            )}

            <div className={styles.formats}>
                <label className={styles.formatField}>
                    <span className={styles.optionLabel}>Format du fichier</span>
                    <SelectInput value={state.sourceId ?? ''} onChange={(e) => wizard.setSource(e.target.value)}>
                        <option value='' disabled>
                            Choisir…
                        </option>
                        {sources.map((s) => (
                            <option key={s.id} value={s.id}>
                                {s.label}
                            </option>
                        ))}
                    </SelectInput>
                </label>
                <span className={styles.formatArrow} aria-hidden='true'>
                    →
                </span>
                <label className={styles.formatField}>
                    <span className={styles.optionLabel}>Format voulu</span>
                    <SelectInput
                        value={state.targetId ?? ''}
                        disabled={!state.sourceId}
                        onChange={(e) => wizard.setTarget(e.target.value)}
                    >
                        <option value='' disabled>
                            {state.sourceId ? 'Choisir…' : 'Choisissez d’abord le format du fichier'}
                        </option>
                        {targets.map((t) => (
                            <option key={t.id} value={t.id}>
                                {t.id === state.sourceId ? `${t.label} (compresser)` : t.label}
                            </option>
                        ))}
                    </SelectInput>
                </label>
            </div>
            {state.file && !state.sourceId && (
                <p className={styles.note}>
                    Le type de ce fichier n’a pas été reconnu à son nom : indiquez son format à la main.
                </p>
            )}

            <div className={styles.stepNav}>
                <Button variant='ghost' icon='arrow-left' onClick={() => wizard.open('kinds')}>
                    Type de fichier
                </Button>
                <Button
                    variant='primary'
                    disabled={!state.file || !state.sourceId || !state.targetId || fileProblem !== null}
                    onClick={() => wizard.open('options')}
                >
                    Continuer
                </Button>
            </div>
        </div>
    );
}

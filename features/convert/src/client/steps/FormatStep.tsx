import { Button, SelectInput } from 'deveye-sdk-client';

import { kindOf, targetsFor } from '../../contracts/catalogue';
import type { ConvertFamily } from '../../contracts/domain';
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
    const detected = kind.sources.find((s) => s.id === state.detectedSourceId);
    const overridden = detected !== undefined && state.sourceId !== null && state.sourceId !== detected.id;

    return (
        <div className={styles.stepBody}>
            <div className={styles.formats}>
                <label className={styles.formatField}>
                    <span className={styles.fieldLabel}>Format du fichier</span>
                    <SelectInput value={state.sourceId ?? ''} onChange={(e) => wizard.setSource(e.target.value)}>
                        <option value='' disabled>
                            Choisir…
                        </option>
                        {sources.map((s) => (
                            <option key={s.id} value={s.id}>
                                {s.id === detected?.id ? `${s.label} (détecté)` : s.label}
                            </option>
                        ))}
                    </SelectInput>
                </label>
                <span className={styles.formatArrow} aria-hidden='true'>
                    →
                </span>
                <label className={styles.formatField}>
                    <span className={styles.fieldLabel}>Format voulu</span>
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

            {overridden && (
                <p className={styles.warning}>
                    Ce fichier a été reconnu comme {detected.label}. Avec un autre format d’entrée, la conversion risque
                    d’échouer : ne le changez que si l’extension du fichier est trompeuse.
                </p>
            )}
            {state.file && !detected && (
                <p className={styles.note}>
                    Le type de ce fichier n’a pas été reconnu à son nom : indiquez son format à la main.
                </p>
            )}
            {fileProblem && (
                <p className={styles.problem} role='alert'>
                    {fileProblem}
                </p>
            )}

            <div className={`${styles.stepNav} ${styles.stepNavEnd}`}>
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

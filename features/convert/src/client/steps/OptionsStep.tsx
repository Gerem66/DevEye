import { Button } from 'deveye-sdk-client';

import type { SizeEstimate } from '../../contracts/estimate';
import { cropRect } from '../../contracts/geometry';
import { cropOf, defaultOf, isActive, OPTION_SECTIONS, resolveOptions, type OptionSpec } from '../../contracts/options';
import { OptionControl } from '../controls/OptionControl';
import { SizeSummary } from '../SizeSummary';
import styles from '../style.module.css';
import type { Wizard } from '../useWizard';

interface OptionsStepProps {
    wizard: Wizard;
    /** Les réglages de la cible, ajustés au fichier choisi (`adaptOptions`). */
    specs: readonly OptionSpec[];
    estimate: SizeEstimate | null;
    pending: boolean;
}

export function OptionsStep({ wizard, specs, estimate, pending }: OptionsStepProps) {
    const { state } = wizard;
    const values = resolveOptions(specs, state.values);
    const visible = specs.filter((spec) => isActive(spec, values));
    const dims = state.info?.width && state.info.height ? { width: state.info.width, height: state.info.height } : null;
    const cropped = dims ? (cropRect(dims, cropOf(values, 'crop')) ?? dims) : null;
    const sections = OPTION_SECTIONS.map((section) => ({
        ...section,
        specs: visible.filter((spec) => spec.section === section.id)
    })).filter((section) => section.specs.length > 0);

    return (
        <div className={styles.stepBody}>
            <p className={styles.note}>
                {sections.length === 0
                    ? 'Rien à régler pour ce format : la conversion se fait telle quelle.'
                    : 'Tout est facultatif : les réglages proposés conviennent dans la plupart des cas.'}
            </p>

            {sections.map((section) => (
                <section key={section.id} className={styles.optionSection} aria-labelledby={`convert-${section.id}`}>
                    <h3 id={`convert-${section.id}`} className={styles.optionSectionTitle}>
                        {section.label}
                    </h3>
                    <div className={styles.fields}>
                        {section.specs.map((spec) => (
                            <OptionControl
                                key={spec.id}
                                spec={spec}
                                value={values[spec.id] ?? defaultOf(spec)}
                                sourceDims={dims}
                                croppedDims={cropped}
                                onChange={(value) => wizard.setValue(spec.id, value)}
                            />
                        ))}
                    </div>
                </section>
            ))}

            <div className={styles.stickyFoot}>
                <SizeSummary inputBytes={state.file?.size ?? 0} estimate={estimate} pending={pending} />
                <div className={styles.stepNav}>
                    <Button variant='ghost' icon='arrow-left' onClick={() => wizard.open('format')}>
                        Format
                    </Button>
                    <Button variant='primary' onClick={() => wizard.open('export')}>
                        Continuer
                    </Button>
                </div>
            </div>
        </div>
    );
}

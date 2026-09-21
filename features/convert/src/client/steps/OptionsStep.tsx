import { useRef } from 'react';
import { Button } from 'deveye-sdk-client';

import type { SizeEstimate } from '../../contracts/estimate';
import { cropRect, scaleOf, sizeAtScale, type Scale } from '../../contracts/geometry';
import {
    cropOf,
    defaultOf,
    isActive,
    isDefault,
    OPTION_SECTIONS,
    resolveOptions,
    sizeOf,
    type OptionSpec,
    type OptionValue
} from '../../contracts/options';
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
    const sections = OPTION_SECTIONS.map((section) => {
        const own = visible.filter((spec) => spec.section === section.id);
        return { ...section, specs: own, touched: own.some((spec) => !isDefault(spec, values[spec.id])) };
    }).filter((section) => section.specs.length > 0);

    // L'échelle que les dimensions demandées représentent, retenue tant que c'est
    // le recadrage qui bouge : les dimensions le suivent sans qu'un arrondi
    // s'ajoute à chaque geste. Dès qu'on les saisit soi-même, elle se relit.
    const scale = useRef<Scale | null>(null);
    const change = (spec: OptionSpec, value: OptionValue): void => {
        wizard.setValue(spec.id, value);
        if (spec.kind === 'size') scale.current = null;
        const resize = specs.find((other) => other.kind === 'size');
        if (spec.kind !== 'crop' || !resize || !dims || !cropped) return;
        const size = sizeOf(values, resize.id);
        if (size.width === null && size.height === null) return;
        scale.current ??= scaleOf(size, cropped);
        const area = cropRect(dims, cropOf({ [spec.id]: value }, spec.id)) ?? dims;
        wizard.setValue(resize.id, sizeAtScale(size, scale.current, area));
    };

    return (
        <div className={styles.stepBody}>
            <p className={styles.note}>
                {sections.length === 0
                    ? 'Rien à régler pour ce format : la conversion se fait telle quelle.'
                    : 'Tout est facultatif : les réglages proposés conviennent dans la plupart des cas.'}
            </p>

            {sections.map((section) => (
                <section
                    key={section.id}
                    className={`${styles.optionSection} ${
                        section.quiet && !section.touched ? styles.optionSectionQuiet : ''
                    }`}
                    aria-labelledby={`convert-${section.id}`}
                >
                    <div className={styles.optionSectionHead}>
                        <h3 id={`convert-${section.id}`} className={styles.optionSectionTitle}>
                            {section.label}
                        </h3>
                        {section.quiet && section.touched && (
                            <button
                                type='button'
                                className={styles.sectionReset}
                                aria-label={`Rétablir les réglages d’origine : ${section.label}`}
                                title='Rétablir les réglages d’origine'
                                onClick={() => {
                                    scale.current = null;
                                    wizard.forgetValues(section.specs.map((spec) => spec.id));
                                }}
                            >
                                <span className='icon icon-restart' aria-hidden='true' />
                            </button>
                        )}
                    </div>
                    <div className={styles.fields}>
                        {section.specs.map((spec) => (
                            <OptionControl
                                key={spec.id}
                                spec={spec}
                                value={values[spec.id] ?? defaultOf(spec)}
                                sourceDims={dims}
                                croppedDims={cropped}
                                onChange={(value) => change(spec, value)}
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

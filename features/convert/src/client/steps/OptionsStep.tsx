import { Button, formatBytesFr } from 'deveye-sdk-client';

import type { TargetFormat } from '../../contracts/catalogue';
import type { SizeEstimate } from '../../contracts/estimate';
import { defaultOf, isActive, resolveOptions } from '../../contracts/options';
import { OptionControl } from '../controls/OptionControl';
import styles from '../style.module.css';
import type { Wizard } from '../useWizard';

interface OptionsStepProps {
    wizard: Wizard;
    target: TargetFormat;
    estimate: SizeEstimate | null;
}

export function EstimateLine({ estimate, inputBytes }: { estimate: SizeEstimate | null; inputBytes: number }) {
    if (!estimate)
        return <span className={styles.estimateMuted}>Taille finale : connue à la fin de la conversion</span>;
    const saved = inputBytes > 0 ? Math.round((1 - estimate.bytes / inputBytes) * 100) : 0;
    return (
        <span>
            Taille finale :{' '}
            <strong>
                {estimate.exact ? '' : 'environ '}
                {formatBytesFr(estimate.bytes)}
            </strong>
            {saved >= 5 && <span className={styles.estimateGain}> ({saved} % de moins)</span>}
            {saved <= -5 && <span className={styles.estimateMuted}> ({-saved} % de plus)</span>}
        </span>
    );
}

export function OptionsStep({ wizard, target, estimate }: OptionsStepProps) {
    const { state } = wizard;
    const values = resolveOptions(target.options, state.values);
    const visible = target.options.filter((spec) => isActive(spec, values));
    const dims = state.info?.width && state.info.height ? { width: state.info.width, height: state.info.height } : null;

    return (
        <div className={styles.stepBody}>
            {visible.length === 0 ? (
                <p className={styles.note}>Rien à régler pour ce format : la conversion se fait telle quelle.</p>
            ) : (
                <>
                    <p className={styles.note}>
                        Tout est facultatif : les réglages proposés conviennent dans la plupart des cas.
                    </p>
                    <div className={styles.options}>
                        {visible.map((spec) => (
                            <OptionControl
                                key={spec.id}
                                spec={spec}
                                value={values[spec.id] ?? defaultOf(spec)}
                                sourceDims={dims}
                                onChange={(value) => wizard.setValue(spec.id, value)}
                            />
                        ))}
                    </div>
                </>
            )}

            <div className={styles.stickyFoot}>
                <span className={styles.estimate} aria-live='polite'>
                    <EstimateLine estimate={estimate} inputBytes={state.file?.size ?? 0} />
                </span>
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

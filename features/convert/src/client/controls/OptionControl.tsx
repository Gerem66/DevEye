import { NumberInput, SegmentedControl, SelectInput, Slider, Switch } from 'deveye-sdk-client';

import type { Dims } from '../../contracts/geometry';
import {
    cropValueSchema,
    EMPTY_SIZE,
    sizeValueSchema,
    type OptionSpec,
    type OptionValue
} from '../../contracts/options';
import styles from '../style.module.css';
import { BytesField } from './BytesField';
import { CropField } from './CropField';
import { SizeField } from './SizeField';

/** Au-delà, les choix ne tiennent plus côte à côte : ils passent en liste déroulante. */
const SEGMENTS_MAX = 4;

interface OptionControlProps {
    spec: OptionSpec;
    value: OptionValue;
    sourceDims: Dims | null;
    /** Les dimensions une fois le recadrage en cours appliqué : le point de départ d'un redimensionnement. */
    croppedDims: Dims | null;
    onChange: (value: OptionValue) => void;
}

/**
 * Un réglage du catalogue, rendu d'après sa seule forme. Ce composant ne
 * connaît aucun format : ajouter un réglage à une cible ne demande rien ici.
 *
 * Tous partagent la même ossature (intitulé, contrôle, explication) pour
 * tomber sur les mêmes lignes ; seul l'interrupteur se range à droite de son
 * intitulé, comme partout ailleurs dans l'app.
 */
export function OptionControl({ spec, value, sourceDims, croppedDims, onChange }: OptionControlProps) {
    const width = spec.half ? styles.fieldHalf : styles.fieldFull;

    if (spec.kind === 'slider') {
        const current = typeof value === 'number' ? value : spec.default;
        return (
            <Slider
                className={width}
                label={spec.label}
                hint={spec.hint}
                min={spec.min}
                max={spec.max}
                step={spec.step}
                value={current}
                valueLabel={spec.unit ? `${current} ${spec.unit}` : String(current)}
                marks={spec.marks}
                onChange={onChange}
            />
        );
    }

    if (spec.kind === 'toggle') {
        return (
            <div className={`${styles.field} ${styles.fieldInline} ${width}`}>
                <div className={styles.fieldText}>
                    <span className={styles.fieldLabel}>{spec.label}</span>
                    {spec.hint && <p className={styles.fieldHint}>{spec.hint}</p>}
                </div>
                <Switch aria-label={spec.label} checked={value === true} onChange={onChange} />
            </div>
        );
    }

    const control = (() => {
        switch (spec.kind) {
            case 'segments': {
                const current = typeof value === 'string' ? value : spec.default;
                return spec.options.length <= SEGMENTS_MAX ? (
                    <SegmentedControl
                        aria-label={spec.label}
                        fullWidth
                        value={current}
                        options={[...spec.options]}
                        onChange={onChange}
                    />
                ) : (
                    <SelectInput aria-label={spec.label} value={current} onChange={(e) => onChange(e.target.value)}>
                        {spec.options.map((o) => (
                            <option key={o.value} value={o.value}>
                                {o.label}
                            </option>
                        ))}
                    </SelectInput>
                );
            }
            case 'number':
                return (
                    <NumberInput
                        aria-label={spec.unit ? `${spec.label}, en ${spec.unit}` : spec.label}
                        value={typeof value === 'number' ? value : null}
                        min={spec.min}
                        max={spec.max}
                        step={spec.step}
                        placeholder={spec.unit ? `en ${spec.unit}` : undefined}
                        onChange={onChange}
                    />
                );
            case 'bytes':
                return (
                    <BytesField
                        label={spec.label}
                        value={typeof value === 'number' ? value : spec.default}
                        onChange={onChange}
                    />
                );
            case 'size': {
                const parsed = sizeValueSchema.safeParse(value);
                return (
                    <SizeField
                        value={parsed.success ? parsed.data : EMPTY_SIZE}
                        natural={croppedDims}
                        onChange={onChange}
                    />
                );
            }
            case 'crop': {
                const parsed = cropValueSchema.safeParse(value);
                return (
                    <CropField value={parsed.success ? parsed.data : null} source={sourceDims} onChange={onChange} />
                );
            }
        }
    })();

    return (
        <div className={`${styles.field} ${width}`}>
            <span className={styles.fieldLabel}>{spec.label}</span>
            {control}
            {spec.hint && <p className={styles.fieldHint}>{spec.hint}</p>}
        </div>
    );
}

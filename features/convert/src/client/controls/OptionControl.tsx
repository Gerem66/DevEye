import { SegmentedControl, SelectInput, Slider, Switch } from 'deveye-sdk-client';

import type { Dims } from '../../contracts/geometry';
import { cropValueSchema, sizeValueSchema, type OptionSpec, type OptionValue } from '../../contracts/options';
import styles from '../style.module.css';
import { BytesField } from './BytesField';
import { CropField } from './CropField';
import { NumberField } from './NumberField';
import { SizeField } from './SizeField';

/** Au-delà, les choix ne tiennent plus côte à côte : ils passent en liste déroulante. */
const SEGMENTS_MAX = 4;

interface OptionControlProps {
    spec: OptionSpec;
    value: OptionValue;
    sourceDims: Dims | null;
    onChange: (value: OptionValue) => void;
}

/**
 * Un réglage du catalogue, rendu d'après sa seule forme. Ce composant ne
 * connaît aucun format : ajouter un réglage à une cible ne demande rien ici.
 */
export function OptionControl({ spec, value, sourceDims, onChange }: OptionControlProps) {
    if (spec.kind === 'slider') {
        const current = typeof value === 'number' ? value : spec.default;
        return (
            <Slider
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
        return <Switch label={spec.label} hint={spec.hint} checked={value === true} onChange={onChange} />;
    }

    const body = (() => {
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
                    <NumberField
                        aria-label={spec.unit ? `${spec.label}, en ${spec.unit}` : spec.label}
                        value={typeof value === 'number' ? value : null}
                        min={spec.min}
                        max={spec.max}
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
                        value={parsed.success ? parsed.data : { width: null, height: null }}
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
        <div className={styles.option}>
            <span className={styles.optionLabel}>{spec.label}</span>
            {body}
            {spec.hint && <p className={styles.optionHint}>{spec.hint}</p>}
        </div>
    );
}

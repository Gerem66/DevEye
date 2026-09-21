import { SelectInput } from 'deveye-sdk-client';

import type { Dims } from '../../contracts/geometry';
import type { CropValue } from '../../contracts/options';
import styles from '../style.module.css';
import { NumberField } from './NumberField';

const RATIOS = [
    { id: '1:1', label: 'Carré (1:1)', ratio: 1 },
    { id: '16:9', label: 'Paysage large (16:9)', ratio: 16 / 9 },
    { id: '4:3', label: 'Paysage (4:3)', ratio: 4 / 3 },
    { id: '3:4', label: 'Portrait (3:4)', ratio: 3 / 4 },
    { id: '9:16', label: 'Portrait étroit (9:16)', ratio: 9 / 16 }
] as const;

/** Le plus grand cadre de ces proportions qui tient dans l'image, centré. */
function centered(source: Dims, ratio: number): CropValue {
    const width = Math.min(source.width, Math.round(source.height * ratio));
    const height = Math.min(source.height, Math.round(width / ratio));
    return {
        x: Math.floor((source.width - width) / 2),
        y: Math.floor((source.height - height) / 2),
        width,
        height
    };
}

interface CropFieldProps {
    value: CropValue | null;
    /** Les dimensions de l'original. Inconnues, seule la saisie à la main reste possible. */
    source: Dims | null;
    onChange: (value: CropValue | null) => void;
}

export function CropField({ value, source, onChange }: CropFieldProps) {
    const current =
        value && source ? (RATIOS.find((r) => sameCrop(centered(source, r.ratio), value))?.id ?? 'custom') : 'none';
    const edit = (patch: Partial<CropValue>): void => {
        if (value) onChange({ ...value, ...patch });
    };
    return (
        <div className={styles.cropField}>
            <SelectInput
                aria-label='Proportions du recadrage'
                value={value ? current : 'none'}
                onChange={(e) => {
                    const ratio = RATIOS.find((r) => r.id === e.target.value);
                    if (e.target.value === 'none') onChange(null);
                    else if (ratio && source) onChange(centered(source, ratio.ratio));
                    else onChange(value ?? { x: 0, y: 0, width: source?.width ?? 100, height: source?.height ?? 100 });
                }}
            >
                <option value='none'>Ne pas recadrer</option>
                {source &&
                    RATIOS.map((r) => (
                        <option key={r.id} value={r.id}>
                            {r.label}
                        </option>
                    ))}
                <option value='custom'>À la main</option>
            </SelectInput>
            {value && (
                <div className={styles.cropGrid}>
                    {(
                        [
                            ['x', 'Depuis la gauche'],
                            ['y', 'Depuis le haut'],
                            ['width', 'Largeur'],
                            ['height', 'Hauteur']
                        ] as const
                    ).map(([key, label]) => (
                        <label key={key} className={styles.pairField}>
                            <span>{label}</span>
                            <NumberField
                                aria-label={`${label}, en pixels`}
                                value={value[key]}
                                min={key === 'x' || key === 'y' ? 0 : 2}
                                onChange={(next) => next !== null && edit({ [key]: Math.round(next) })}
                            />
                        </label>
                    ))}
                </div>
            )}
        </div>
    );
}

function sameCrop(a: CropValue, b: CropValue): boolean {
    return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

import { SelectInput, Slider } from 'deveye-sdk-client';

import { cropRect, type Dims } from '../../contracts/geometry';
import type { CropValue } from '../../contracts/options';
import styles from '../style.module.css';
import { NumberField } from './NumberField';

const NONE: CropValue = { top: 0, right: 0, bottom: 0, left: 0 };

const RATIOS = [
    { id: '1:1', label: 'Carré (1:1)', ratio: 1 },
    { id: '16:9', label: 'Paysage large (16:9)', ratio: 16 / 9 },
    { id: '4:3', label: 'Paysage (4:3)', ratio: 4 / 3 },
    { id: '3:4', label: 'Portrait (3:4)', ratio: 3 / 4 },
    { id: '9:16', label: 'Portrait étroit (9:16)', ratio: 9 / 16 }
] as const;

/** Dans l'ordre où on les lit sur une image : deux lignes, le vertical puis l'horizontal. */
const EDGES = [
    { id: 'top', label: 'Haut', axis: 'height', opposite: 'bottom' },
    { id: 'bottom', label: 'Bas', axis: 'height', opposite: 'top' },
    { id: 'left', label: 'Gauche', axis: 'width', opposite: 'right' },
    { id: 'right', label: 'Droite', axis: 'width', opposite: 'left' }
] as const;

/** Les marges du plus grand cadre de ces proportions qui tient dans l'image, centré. */
function centered(source: Dims, ratio: number): CropValue {
    const width = Math.min(source.width, Math.round(source.height * ratio));
    const height = Math.min(source.height, Math.round(width / ratio));
    const left = Math.floor((source.width - width) / 2);
    const top = Math.floor((source.height - height) / 2);
    return { top, left, right: source.width - width - left, bottom: source.height - height - top };
}

const same = (a: CropValue, b: CropValue): boolean =>
    a.top === b.top && a.right === b.right && a.bottom === b.bottom && a.left === b.left;

interface CropFieldProps {
    value: CropValue | null;
    /** Les dimensions de l'original. Inconnues, les marges se saisissent sans curseur ni proportions toutes faites. */
    source: Dims | null;
    onChange: (value: CropValue | null) => void;
}

/**
 * Le recadrage, dit comme on le pense : ce qu'on retire de chaque bord. Chaque
 * geste remonte aussitôt, l'aperçu suit le curseur.
 */
export function CropField({ value, source, onChange }: CropFieldProps) {
    const edges = value ?? NONE;
    const emit = (next: CropValue): void => onChange(same(next, NONE) ? null : next);
    const preset = source ? (RATIOS.find((r) => same(centered(source, r.ratio), edges))?.id ?? 'custom') : 'custom';
    const kept = source ? (cropRect(source, edges) ?? source) : null;

    return (
        <div className={styles.cropField}>
            {source && (
                <SelectInput
                    aria-label='Proportions du recadrage'
                    value={value ? preset : 'none'}
                    onChange={(e) => {
                        const ratio = RATIOS.find((r) => r.id === e.target.value);
                        if (ratio) emit(centered(source, ratio.ratio));
                        else if (e.target.value === 'none') onChange(null);
                    }}
                >
                    <option value='none'>Ne pas recadrer</option>
                    {RATIOS.map((r) => (
                        <option key={r.id} value={r.id}>
                            {r.label}
                        </option>
                    ))}
                    <option value='custom' disabled={!value}>
                        Réglé à la main
                    </option>
                </SelectInput>
            )}

            <div className={styles.cropGrid}>
                {EDGES.map((edge) =>
                    source ? (
                        <Slider
                            key={edge.id}
                            label={edge.label}
                            valueLabel={`${edges[edge.id]} px`}
                            min={0}
                            max={source[edge.axis] - 2}
                            value={edges[edge.id]}
                            // Le bord d'en face garde toujours sa place : on ne rogne que ce qu'il laisse.
                            onChange={(next) =>
                                emit({
                                    ...edges,
                                    [edge.id]: Math.min(next, source[edge.axis] - 2 - edges[edge.opposite])
                                })
                            }
                        />
                    ) : (
                        <label key={edge.id} className={styles.pairField}>
                            <span>{edge.label} (px)</span>
                            <NumberField
                                live
                                aria-label={`À retirer du bord ${edge.label.toLowerCase()}, en pixels`}
                                value={edges[edge.id] || null}
                                min={0}
                                placeholder='0'
                                onChange={(next) => emit({ ...edges, [edge.id]: Math.round(next ?? 0) })}
                            />
                        </label>
                    )
                )}
            </div>

            {kept && value && (
                <p className={styles.fieldHint}>
                    Zone gardée : {kept.width} × {kept.height} px
                </p>
            )}
        </div>
    );
}

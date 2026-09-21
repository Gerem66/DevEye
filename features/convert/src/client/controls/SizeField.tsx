import { useId } from 'react';
import { NumberInput } from 'deveye-sdk-client';

import type { Dims } from '../../contracts/geometry';
import type { SizeValue } from '../../contracts/options';
import styles from '../style.module.css';

const MAX_SIDE = 16_384;

interface SizeFieldProps {
    value: SizeValue;
    /** Les dimensions de l'image une fois recadrée : ce que les champs montrent tant que rien n'est demandé. */
    natural: Dims | null;
    onChange: (value: SizeValue) => void;
}

/**
 * Largeur et hauteur du résultat, remplies avec les vraies dimensions. Cadenas
 * fermé, changer l'une entraîne l'autre ; ouvert, chacune est libre et l'image
 * s'étire. Revenir aux dimensions d'origine vaut « inchangé » : aucun
 * redimensionnement n'est alors demandé au serveur.
 */
export function SizeField({ value, natural, onChange }: SizeFieldProps) {
    const id = useId();
    const shown = { width: value.width ?? natural?.width ?? null, height: value.height ?? natural?.height ?? null };
    const ratio = natural ? natural.width / natural.height : null;

    const emit = (next: SizeValue): void => {
        const untouched = natural !== null && next.width === natural.width && next.height === natural.height;
        onChange(untouched ? { ...next, width: null, height: null } : next);
    };

    const edit = (side: 'width' | 'height', raw: number | null): void => {
        const other = side === 'width' ? 'height' : 'width';
        const size = raw === null ? null : Math.round(raw);
        if (size === null) return emit({ ...value, [side]: null, ...(value.keepRatio ? { [other]: null } : {}) });
        if (!value.keepRatio || ratio === null) return emit({ ...value, [side]: size, [other]: shown[other] });
        const linked = Math.max(1, Math.round(side === 'width' ? size / ratio : size * ratio));
        emit({ ...value, [side]: size, [other]: linked });
    };

    const toggleLock = (): void => {
        const keepRatio = !value.keepRatio;
        // En refermant le cadenas, la hauteur se range sur la largeur : deux valeurs libres n'ont plus de sens.
        if (keepRatio && ratio !== null && shown.width !== null) {
            return emit({ keepRatio, width: shown.width, height: Math.max(1, Math.round(shown.width / ratio)) });
        }
        emit({ ...value, keepRatio });
    };

    return (
        <div className={styles.sizeRow}>
            <div className={styles.pairField}>
                <label htmlFor={`${id}-width`}>Largeur (px)</label>
                <NumberInput
                    live
                    id={`${id}-width`}
                    value={shown.width}
                    min={1}
                    max={MAX_SIDE}
                    placeholder='inchangée'
                    onChange={(width) => edit('width', width)}
                />
            </div>
            <button
                type='button'
                className={`${styles.lock} ${value.keepRatio ? styles.lockOn : ''}`}
                aria-pressed={value.keepRatio}
                aria-label='Garder les proportions'
                title={value.keepRatio ? 'Proportions gardées' : 'Dimensions libres : l’image peut se déformer'}
                onClick={toggleLock}
            >
                <span className={`icon ${value.keepRatio ? 'icon-lock' : 'icon-unlock'}`} aria-hidden='true' />
            </button>
            <div className={styles.pairField}>
                <label htmlFor={`${id}-height`}>Hauteur (px)</label>
                <NumberInput
                    live
                    id={`${id}-height`}
                    value={shown.height}
                    min={1}
                    max={MAX_SIDE}
                    placeholder='inchangée'
                    onChange={(height) => edit('height', height)}
                />
            </div>
        </div>
    );
}

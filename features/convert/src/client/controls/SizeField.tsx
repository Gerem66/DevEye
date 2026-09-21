import type { SizeValue } from '../../contracts/options';
import styles from '../style.module.css';
import { NumberField } from './NumberField';

const MAX_SIDE = 16_384;

export function SizeField({ value, onChange }: { value: SizeValue; onChange: (value: SizeValue) => void }) {
    return (
        <div className={styles.pairRow}>
            <label className={styles.pairField}>
                <span>Largeur</span>
                <NumberField
                    aria-label='Largeur maximale, en pixels'
                    value={value.width}
                    min={1}
                    max={MAX_SIDE}
                    placeholder='inchangée'
                    onChange={(width) => onChange({ ...value, width: width === null ? null : Math.round(width) })}
                />
            </label>
            <label className={styles.pairField}>
                <span>Hauteur</span>
                <NumberField
                    aria-label='Hauteur maximale, en pixels'
                    value={value.height}
                    min={1}
                    max={MAX_SIDE}
                    placeholder='inchangée'
                    onChange={(height) => onChange({ ...value, height: height === null ? null : Math.round(height) })}
                />
            </label>
        </div>
    );
}

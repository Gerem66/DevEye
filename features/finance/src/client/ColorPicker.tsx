import type { FinanceColor } from '../contracts/domain';
import { FINANCE_COLORS } from '../contracts/domain';

import { COLOR_LABELS } from './format';
import { colorVar } from './shared';
import styles from './style.module.css';

interface ColorPickerProps {
    value: FinanceColor;
    onChange: (color: FinanceColor) => void;
    disabled?: boolean;
    'aria-label': string;
}

/** Les pastilles de la palette : un compte ou une catégorie s'y reconnaît d'un coup d'œil. */
export function ColorPicker({ value, onChange, disabled, 'aria-label': label }: ColorPickerProps) {
    return (
        <div className={styles.swatches} role='radiogroup' aria-label={label}>
            {FINANCE_COLORS.map((color) => (
                <button
                    key={color}
                    type='button'
                    role='radio'
                    aria-label={COLOR_LABELS[color]}
                    title={COLOR_LABELS[color]}
                    aria-checked={value === color}
                    disabled={disabled}
                    className={value === color ? styles.swatchActive : styles.swatch}
                    style={{ background: colorVar(color) }}
                    onClick={() => onChange(color)}
                />
            ))}
        </div>
    );
}

export default ColorPicker;

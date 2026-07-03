import styles from './style.module.css';

interface NumberFieldProps {
    /** Valeur contrôlée sous forme de chaîne (permet le champ vide). */
    value: string;
    onChange: (value: string) => void;
    /**
     * Id posé sur l'<input>, à référencer via `htmlFor` par le label parent.
     * Indispensable si le label ENGLOBE ce composant : sans association
     * explicite, cliquer le label activerait le premier contrôle labelable —
     * le bouton « − » — au lieu de simplement donner le focus au champ.
     */
    id?: string;
    min?: number;
    max?: number;
    step?: number;
    placeholder?: string;
}

/**
 * Champ numérique aux flèches ± maison : les spinners natifs (moches et
 * hétérogènes selon les navigateurs) sont masqués au profit de deux boutons
 * cohérents avec la charte. Le clamp min/max est appliqué aux pas.
 */
export default function NumberField({ value, onChange, id, min, max, step = 1, placeholder }: NumberFieldProps) {
    const parsed = Number(value);
    const current = value.trim() === '' || !Number.isFinite(parsed) ? null : parsed;

    const clamp = (n: number): number => {
        let v = n;
        if (min !== undefined) v = Math.max(min, v);
        if (max !== undefined) v = Math.min(max, v);
        return v;
    };

    const bump = (dir: 1 | -1): void => {
        const base = current ?? min ?? 0;
        onChange(String(clamp(base + dir * step)));
    };

    return (
        <div className={styles.numberField}>
            <button
                type='button'
                className={styles.numberStep}
                onClick={() => bump(-1)}
                tabIndex={-1}
                aria-label='Diminuer'
            >
                −
            </button>
            <input
                id={id}
                className={styles.numberInput}
                type='number'
                inputMode='numeric'
                min={min}
                max={max}
                step={step}
                placeholder={placeholder}
                value={value}
                onChange={(e) => onChange(e.target.value)}
            />
            <button
                type='button'
                className={styles.numberStep}
                onClick={() => bump(1)}
                tabIndex={-1}
                aria-label='Augmenter'
            >
                +
            </button>
        </div>
    );
}

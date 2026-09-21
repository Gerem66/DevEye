import { useEffect, useState, type ChangeEvent } from 'react';

import styles from './style.module.css';

export interface NumberInputProps {
    /** `null` : le champ est vide. */
    value: number | null;
    onChange: (value: number | null) => void;
    min?: number;
    max?: number;
    step?: number;
    placeholder?: string;
    disabled?: boolean;
    /**
     * Remonte la valeur à chaque frappe, dès qu'elle tient dans les bornes, pour
     * ce qui se voit tout de suite (un aperçu, un résultat). Sans lui, à la
     * sortie du champ.
     */
    live?: boolean;
    /** À référencer par `htmlFor` quand un `<label>` englobe le champ : sans lui, cliquer le label activerait « − ». */
    id?: string;
    /** Nécessaire quand aucun libellé visible ne désigne le champ. */
    'aria-label'?: string;
    className?: string;
}

const text = (value: number | null): string => (value === null ? '' : String(value));
const decimalsOf = (n: number): number => (String(n).split('.')[1] ?? '').length;

/**
 * Le champ de nombre de l'app : un `<input type='number'>` entre deux boutons ±
 * maison, les flèches natives, différentes d'un navigateur à l'autre, étant
 * masquées. Ce qu'on tape n'est jamais réécrit tant que le champ a le focus :
 * la valeur n'est bornée qu'à sa sortie.
 */
export function NumberInput({
    value,
    onChange,
    min,
    max,
    step = 1,
    placeholder,
    disabled,
    live,
    id,
    className,
    ...aria
}: NumberInputProps) {
    const [draft, setDraft] = useState(text(value));
    const [editing, setEditing] = useState(false);
    // À la sortie du champ, c'est la valeur retenue par le parent qui s'affiche, pas ce qui a été tapé.
    useEffect(() => {
        if (!editing) setDraft(text(value));
    }, [value, editing]);

    const clamp = (n: number): number => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n));

    const type = (event: ChangeEvent<HTMLInputElement>): void => {
        const raw = event.target.value;
        setDraft(raw);
        // `badInput` : une saisie en cours (« 12, ») que le navigateur rend vide. Ce n'est pas un champ vidé.
        if (!live || event.target.validity.badInput) return;
        if (raw === '') return onChange(null);
        const parsed = Number(raw);
        // Hors bornes, c'est aussi une saisie en cours (« 1 » avant « 120 ») : la borner la réécrirait sous les doigts.
        if (Number.isFinite(parsed) && parsed === clamp(parsed)) onChange(parsed);
    };

    const commit = (): void => {
        const parsed = draft === '' ? null : Number(draft);
        const next = parsed === null || !Number.isFinite(parsed) ? null : clamp(parsed);
        if (next !== value) onChange(next);
        setEditing(false);
    };

    const bump = (direction: 1 | -1): void => {
        const base = value ?? min ?? 0;
        const precision = Math.max(decimalsOf(step), decimalsOf(base));
        const next = clamp(Number((base + direction * step).toFixed(precision)));
        setDraft(text(next));
        onChange(next);
    };

    return (
        <div className={`${styles.field} ${disabled ? styles.disabled : ''} ${className ?? ''}`}>
            {/* Hors de l'ordre de tabulation : au clavier, les flèches haut et bas du champ font déjà le pas. */}
            <button
                type='button'
                className={styles.step}
                onClick={() => bump(-1)}
                disabled={disabled || (min !== undefined && value !== null && value <= min)}
                tabIndex={-1}
                aria-label='Diminuer'
            >
                −
            </button>
            <input
                id={id}
                className={styles.input}
                type='number'
                inputMode='decimal'
                min={min}
                max={max}
                step={step}
                placeholder={placeholder}
                disabled={disabled}
                aria-label={aria['aria-label']}
                value={draft}
                onFocus={() => setEditing(true)}
                onChange={type}
                onBlur={commit}
                // La molette sur un champ qui a le focus changerait sa valeur en faisant défiler la page.
                onWheel={(event) => event.currentTarget.blur()}
                onKeyDown={(event) => {
                    if (event.key === 'Enter') event.currentTarget.blur();
                }}
            />
            <button
                type='button'
                className={styles.step}
                onClick={() => bump(1)}
                disabled={disabled || (max !== undefined && value !== null && value >= max)}
                tabIndex={-1}
                aria-label='Augmenter'
            >
                +
            </button>
        </div>
    );
}

export default NumberInput;

import { useId } from 'react';

import styles from './style.module.css';

export interface SliderProps {
    value: number;
    onChange: (value: number) => void;
    min: number;
    max: number;
    step?: number;
    label: string;
    /** La valeur telle qu'elle se lit, à droite du libellé (« 24 », « 80 % »). Absente, rien ne s'affiche. */
    valueLabel?: string;
    /** Repères sous la piste, de gauche à droite (« Léger », « Fidèle »). */
    marks?: readonly string[];
    hint?: string;
    disabled?: boolean;
    className?: string;
}

/**
 * Un curseur aux couleurs du projet. Le `<input type='range'>` natif est gardé :
 * il apporte le clavier, le tactile et la lecture d'écran, que rien de maison
 * n'égale.
 */
export function Slider({
    value,
    onChange,
    min,
    max,
    step = 1,
    label,
    valueLabel,
    marks,
    hint,
    disabled,
    className
}: SliderProps) {
    const id = useId();
    return (
        <div className={`${styles.slider} ${className ?? ''}`}>
            <label className={styles.head} htmlFor={id}>
                {label}
                {valueLabel !== undefined && <span className={styles.value}>{valueLabel}</span>}
            </label>
            <input
                id={id}
                type='range'
                min={min}
                max={max}
                step={step}
                value={value}
                disabled={disabled}
                aria-valuetext={valueLabel}
                className={styles.input}
                onChange={(e) => onChange(Number(e.target.value))}
            />
            {marks && marks.length > 0 && (
                <div className={styles.marks} aria-hidden='true'>
                    {marks.map((mark) => (
                        <span key={mark}>{mark}</span>
                    ))}
                </div>
            )}
            {hint && <p className={styles.hint}>{hint}</p>}
        </div>
    );
}

export default Slider;

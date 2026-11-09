import { useId, type CSSProperties } from 'react';

import NumberInput from '@/Components/NumberInput';

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
    /**
     * Un champ de nombre à la place de `valueLabel` : la valeur exacte se tape,
     * au même pas. Les bornes du curseur ne sont qu'un conseil : le champ va
     * de 0 à bien au-delà.
     */
    editable?: boolean;
    /** Repères sous la piste, de gauche à droite (« Léger », « Fidèle »). */
    marks?: readonly string[];
    /**
     * Une valeur de référence, marquée d'un trait discret sur la piste (la
     * qualité d'origine d'un fichier, par exemple). Décoratif : ce qu'il veut
     * dire se dit dans `hint`.
     */
    indicator?: number;
    hint?: string;
    disabled?: boolean;
    className?: string;
}

/** Ce que le champ accepte au plus : de quoi ne jamais gêner, sans ouvrir à l'absurde. */
const EDITABLE_MAX = 9999;

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
    editable,
    marks,
    indicator,
    hint,
    disabled,
    className
}: SliderProps) {
    const id = useId();
    return (
        <div className={`${styles.slider} ${className ?? ''}`}>
            <div className={styles.head}>
                <label htmlFor={id}>{label}</label>
                {editable ? (
                    <NumberInput
                        className={styles.number}
                        value={value}
                        min={0}
                        max={EDITABLE_MAX}
                        step={step}
                        disabled={disabled}
                        live
                        aria-label={label}
                        onChange={(next) => next !== null && onChange(next)}
                    />
                ) : (
                    valueLabel !== undefined && <span className={styles.value}>{valueLabel}</span>
                )}
            </div>
            <div className={styles.track}>
                {indicator !== undefined && indicator >= min && indicator <= max && max > min && (
                    <span
                        className={styles.indicator}
                        style={{ '--at': (indicator - min) / (max - min) } as CSSProperties}
                        aria-hidden='true'
                    />
                )}
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
            </div>
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

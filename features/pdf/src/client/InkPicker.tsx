import { useRef, useState, type CSSProperties } from 'react';

import { INK, type HexColor, type Ink, type InkColor } from './elements';
import styles from './pdf.module.css';
import { inkCss } from './Stage';

/** Les encres libres du compte, et ce qu'on en fait quand l'une change. */
export interface InkSlots {
    /** Un emplacement vaut `null` tant qu'aucune couleur n'y a été choisie. */
    custom: readonly (HexColor | null)[];
    onCustomChange: (index: number, hex: HexColor) => void;
}

interface InkPickerProps extends InkSlots {
    value: Ink;
    onChange: (ink: Ink) => void;
}

/**
 * Les quatre encres du document, puis les encres libres. Un emplacement vide
 * s'ouvre sur le sélecteur du navigateur au premier clic ; un emplacement
 * choisi, sur un second clic. Deux emplacements de même couleur restent deux.
 */
export function InkPicker({ value, onChange, custom, onCustomChange }: InkPickerProps) {
    const input = useRef<HTMLInputElement>(null);
    /** L'emplacement cliqué en dernier : deux emplacements de même couleur ne s'allument pas ensemble. */
    const [slot, setSlot] = useState<number | null>(null);
    const editing = useRef<number | null>(null);
    const active =
        slot !== null && custom[slot] === value ? slot : custom.findIndex((hex) => hex !== null && hex === value);

    const openPicker = (index: number): void => {
        const el = input.current;
        if (!el) return;
        editing.current = index;
        el.value = custom[index] ?? '#ffffff';
        el.click();
    };

    const dot = (key: string, ink: Ink | null, checked: boolean, title: string, onClick: () => void) => (
        <button
            key={key}
            type='button'
            role='radio'
            aria-checked={checked}
            aria-label={title}
            title={title}
            className={`${styles.colorDot} ${ink === null ? styles.colorDotEmpty : ''} ${checked ? styles.colorDotActive : ''}`}
            style={ink === null ? undefined : ({ '--ink': inkCss(ink) } as CSSProperties)}
            onClick={onClick}
        />
    );

    return (
        <div className={styles.inkPicker}>
            <div className={styles.inkGroup}>
                <span className={styles.inkCaption} aria-hidden='true'>
                    Encre
                </span>
                <div className={styles.colorDots} role='radiogroup' aria-label='Encre du document'>
                    {(Object.keys(INK) as InkColor[]).map((c) =>
                        dot(c, c, c === value, INK[c].label, () => {
                            setSlot(null);
                            onChange(c);
                        })
                    )}
                </div>
            </div>
            <div className={styles.inkGroup}>
                <span className={styles.inkCaption} aria-hidden='true'>
                    Libre
                </span>
                <div className={styles.colorDots} role='radiogroup' aria-label='Encres libres'>
                    {custom.map((hex, i) =>
                        dot(
                            `custom-${i}`,
                            hex,
                            i === active,
                            hex === null
                                ? `Couleur libre ${i + 1} : à choisir`
                                : `Couleur libre ${i + 1} (cliquer à nouveau pour la changer)`,
                            () => {
                                if (hex === null || i === active) {
                                    openPicker(i);
                                    return;
                                }
                                setSlot(i);
                                onChange(hex);
                            }
                        )
                    )}
                </div>
            </div>
            <input
                ref={input}
                type='color'
                className={styles.colorInput}
                tabIndex={-1}
                aria-hidden='true'
                defaultValue='#ffffff'
                onChange={(e) => {
                    const index = editing.current;
                    if (index === null) return;
                    const hex = e.target.value as HexColor;
                    onCustomChange(index, hex);
                    setSlot(index);
                    onChange(hex);
                }}
            />
        </div>
    );
}

import { useCallback, useEffect, useRef, useState } from 'react';

import styles from './Security.module.css';

interface MinutesEditorProps {
    /** La valeur enregistrée, en minutes. */
    value: number;
    min: number;
    max: number;
    /** Rejette quand l'enregistrement échoue : l'icône d'échec s'affiche. */
    onSave: (minutes: number) => Promise<void>;
    'aria-label': string;
}

/**
 * Un délai en minutes, enregistré seul 500 ms après la dernière frappe, avec
 * une petite icône d'état plutôt qu'un bouton. Le texte reste une chaîne : le
 * champ peut se vider en cours de saisie sans retomber à zéro.
 */
export function MinutesEditor({ value, min, max, onSave, ...rest }: MinutesEditorProps) {
    const [input, setInput] = useState(String(value));
    const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
    const debounce = useRef<number | undefined>(undefined);
    const savedTimer = useRef<number | undefined>(undefined);

    useEffect(() => setInput(String(value)), [value]);

    const parsed = Number(input);
    const valid = input.trim() !== '' && Number.isInteger(parsed) && parsed >= min && parsed <= max;
    const dirty = valid && parsed !== value;

    const save = useCallback(async () => {
        if (!valid) return;
        setSaveState('saving');
        try {
            await onSave(parsed);
            setSaveState('saved');
            window.clearTimeout(savedTimer.current);
            savedTimer.current = window.setTimeout(() => setSaveState('idle'), 2000);
        } catch {
            setSaveState('error');
        }
    }, [valid, parsed, onSave]);

    useEffect(() => {
        if (!dirty) return;
        window.clearTimeout(debounce.current);
        debounce.current = window.setTimeout(() => void save(), 500);
        return () => window.clearTimeout(debounce.current);
    }, [dirty, input, save]);

    useEffect(
        () => () => {
            window.clearTimeout(debounce.current);
            window.clearTimeout(savedTimer.current);
        },
        []
    );

    return (
        <div className={styles.minutesEditor}>
            <span className={styles.minutesStatus} aria-live='polite'>
                {saveState === 'saving' && (
                    <span key='saving' className={`icon icon-spinner ${styles.minutesSpin}`} title='Enregistrement…' />
                )}
                {saveState === 'saved' && (
                    <span key='saved' className={`icon icon-check-circle ${styles.minutesOk}`} title='Enregistré' />
                )}
                {saveState === 'error' && (
                    <span
                        key='error'
                        className={`icon icon-x-circle ${styles.minutesErr}`}
                        title="Échec de l'enregistrement"
                    />
                )}
            </span>
            <input
                type='number'
                inputMode='numeric'
                min={min}
                max={max}
                step={1}
                className={styles.minutesInput}
                value={input}
                onChange={(e) => setInput(e.target.value.replace(/\D/g, ''))}
                onKeyDown={(e) => {
                    if (e.key === 'Enter' && dirty) void save();
                }}
                aria-label={rest['aria-label']}
            />
            <span className={styles.minutesUnit}>min</span>
        </div>
    );
}

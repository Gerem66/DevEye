import { useEffect, useState } from 'react';
import { TextInput } from 'deveye-sdk-client';

import { formatNumber, parseNumber } from '../format';

interface NumberFieldProps {
    value: number | null;
    onChange: (value: number | null) => void;
    min?: number;
    max?: number;
    placeholder?: string;
    /**
     * Remonte la valeur à chaque frappe, dès qu'elle tient dans les bornes, pour
     * ce qui se voit tout de suite (un aperçu). Sans lui, à la sortie du champ.
     */
    live?: boolean;
    'aria-label': string;
}

/**
 * Un champ de nombre qui tolère une saisie en cours (« 12, ») : ce qu'on tape
 * n'est jamais réécrit tant que le champ a le focus, et la valeur n'est bornée
 * qu'à sa sortie. Vide veut dire « inchangé ».
 */
export function NumberField({ value, onChange, min, max, placeholder, live, ...aria }: NumberFieldProps) {
    const [draft, setDraft] = useState(value === null ? '' : formatNumber(value));
    const [editing, setEditing] = useState(false);
    // À la sortie du champ, c'est la valeur retenue par le parent qui s'affiche, pas ce qui a été tapé.
    useEffect(() => {
        if (!editing) setDraft(value === null ? '' : formatNumber(value));
    }, [value, editing]);

    const clamp = (n: number): number => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n));

    const type = (text: string): void => {
        setDraft(text);
        if (!live) return;
        const parsed = parseNumber(text);
        // Hors bornes, c'est une saisie en cours (« 1 » avant « 120 ») : la borner la réécrirait sous les doigts.
        if (parsed === null) onChange(null);
        else if (parsed === clamp(parsed)) onChange(parsed);
    };

    const commit = (): void => {
        const parsed = parseNumber(draft);
        const next = parsed === null ? null : clamp(parsed);
        if (next !== value) onChange(next);
        setEditing(false);
    };

    return (
        <TextInput
            inputMode='decimal'
            value={draft}
            placeholder={placeholder}
            aria-label={aria['aria-label']}
            onFocus={() => setEditing(true)}
            onChange={(e) => type(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur();
            }}
        />
    );
}

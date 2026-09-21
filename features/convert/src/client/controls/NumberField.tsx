import { useEffect, useState } from 'react';
import { TextInput } from 'deveye-sdk-client';

import { formatNumber, parseNumber } from '../format';

interface NumberFieldProps {
    value: number | null;
    onChange: (value: number | null) => void;
    min?: number;
    max?: number;
    placeholder?: string;
    'aria-label': string;
}

/**
 * Un champ de nombre qui tolère une saisie en cours (« 12, ») : la valeur n'est
 * remontée qu'à la sortie du champ, bornée. Vide veut dire « inchangé ».
 */
export function NumberField({ value, onChange, min, max, placeholder, ...aria }: NumberFieldProps) {
    const [draft, setDraft] = useState(value === null ? '' : formatNumber(value));
    useEffect(() => setDraft(value === null ? '' : formatNumber(value)), [value]);

    const commit = (): void => {
        const parsed = parseNumber(draft);
        if (parsed === null) return onChange(null);
        onChange(Math.min(max ?? Infinity, Math.max(min ?? -Infinity, parsed)));
    };

    return (
        <TextInput
            inputMode='decimal'
            value={draft}
            placeholder={placeholder}
            aria-label={aria['aria-label']}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
                if (e.key === 'Enter') commit();
            }}
        />
    );
}

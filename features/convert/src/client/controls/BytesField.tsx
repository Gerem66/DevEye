import { useState } from 'react';
import { NumberInput, SegmentedControl } from 'deveye-sdk-client';

import styles from '../style.module.css';

const UNITS = [
    { value: 'kb', label: 'Ko', factor: 1024 },
    { value: 'mb', label: 'Mo', factor: 1024 ** 2 },
    { value: 'gb', label: 'Go', factor: 1024 ** 3 }
] as const;
type UnitId = (typeof UNITS)[number]['value'];

/** Les plafonds qu'on rencontre vraiment : une pièce jointe, une messagerie, un envoi par lien. */
const PRESETS = [
    { label: '8 Mo', bytes: 8 * 1024 ** 2 },
    { label: '25 Mo', bytes: 25 * 1024 ** 2 },
    { label: '100 Mo', bytes: 100 * 1024 ** 2 },
    { label: '500 Mo', bytes: 500 * 1024 ** 2 }
];

const unitFor = (bytes: number): UnitId => (bytes >= 1024 ** 3 ? 'gb' : bytes >= 1024 ** 2 ? 'mb' : 'kb');

export function BytesField({
    label,
    value,
    onChange
}: {
    label: string;
    value: number;
    onChange: (v: number) => void;
}) {
    const [unit, setUnit] = useState<UnitId>(unitFor(value));
    const factor = UNITS.find((u) => u.value === unit)?.factor ?? 1;
    return (
        <div className={styles.bytesField}>
            <div className={styles.bytesRow}>
                <NumberInput
                    aria-label={label}
                    value={Math.round((value / factor) * 100) / 100}
                    min={0.01}
                    onChange={(next) => next !== null && onChange(Math.round(next * factor))}
                />
                <SegmentedControl
                    aria-label='Unité'
                    value={unit}
                    options={UNITS.map(({ value: v, label: l }) => ({ value: v, label: l }))}
                    onChange={setUnit}
                />
            </div>
            <div className={styles.chips}>
                {PRESETS.map((preset) => (
                    <button
                        key={preset.label}
                        type='button'
                        className={`${styles.chip} ${preset.bytes === value ? styles.chipOn : ''}`}
                        onClick={() => {
                            setUnit(unitFor(preset.bytes));
                            onChange(preset.bytes);
                        }}
                    >
                        {preset.label}
                    </button>
                ))}
            </div>
        </div>
    );
}

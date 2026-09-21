import { useMemo, useState } from 'react';
import { Button, SelectInput } from 'deveye-sdk-client';

import { convertUnit, UNIT_CATEGORIES } from '../contracts/units';
import { NumberField } from './controls/NumberField';
import { formatNumber } from './format';
import styles from './style.module.css';

/** Les unités physiques. Tout se calcule ici, dans le navigateur : rien ne part sur le réseau. */
export function Units({ onBack }: { onBack: () => void }) {
    const [categoryId, setCategoryId] = useState(UNIT_CATEGORIES[0].id);
    const category = UNIT_CATEGORIES.find((c) => c.id === categoryId) ?? UNIT_CATEGORIES[0];
    const [from, setFrom] = useState(category.units[0].id);
    const [to, setTo] = useState(category.units[1].id);
    const [value, setValue] = useState<number | null>(1);

    const pickCategory = (id: string): void => {
        const next = UNIT_CATEGORIES.find((c) => c.id === id) ?? UNIT_CATEGORIES[0];
        setCategoryId(next.id);
        setFrom(next.units[0].id);
        setTo(next.units[1].id);
    };

    const result = useMemo(
        () => (value === null ? null : convertUnit(category, from, to, value)),
        [category, from, to, value]
    );
    const symbol = (id: string): string => category.units.find((u) => u.id === id)?.symbol ?? '';

    return (
        <div className={styles.stepBody}>
            <label className={styles.formatField}>
                <span className={styles.optionLabel}>Grandeur</span>
                <SelectInput value={category.id} onChange={(e) => pickCategory(e.target.value)}>
                    {UNIT_CATEGORIES.map((c) => (
                        <option key={c.id} value={c.id}>
                            {c.label}
                        </option>
                    ))}
                </SelectInput>
            </label>

            <div className={styles.converter}>
                <div className={styles.converterSide}>
                    <NumberField aria-label='Valeur à convertir' value={value} onChange={setValue} />
                    <SelectInput aria-label='Unité de départ' value={from} onChange={(e) => setFrom(e.target.value)}>
                        {category.units.map((u) => (
                            <option key={u.id} value={u.id}>
                                {u.label} ({u.symbol})
                            </option>
                        ))}
                    </SelectInput>
                </div>
                <button
                    type='button'
                    className={styles.swap}
                    aria-label='Inverser les deux unités'
                    onClick={() => {
                        setFrom(to);
                        setTo(from);
                    }}
                >
                    ⇄
                </button>
                <div className={styles.converterSide}>
                    <output className={styles.result} aria-live='polite'>
                        {result === null ? '…' : `${formatNumber(result)} ${symbol(to)}`}
                    </output>
                    <SelectInput aria-label='Unité d’arrivée' value={to} onChange={(e) => setTo(e.target.value)}>
                        {category.units.map((u) => (
                            <option key={u.id} value={u.id}>
                                {u.label} ({u.symbol})
                            </option>
                        ))}
                    </SelectInput>
                </div>
            </div>

            <div className={styles.stepNav}>
                <Button variant='ghost' icon='arrow-left' onClick={onBack}>
                    Convertisseur
                </Button>
            </div>
        </div>
    );
}

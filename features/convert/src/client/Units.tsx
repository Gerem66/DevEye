import { useMemo, useState } from 'react';
import { NumberInput, SearchSelect, type SearchSelectOption } from 'deveye-sdk-client';

import { convertUnit, UNIT_CATEGORIES, type UnitCategory } from '../contracts/units';
import { formatNumber } from './format';
import styles from './style.module.css';

const optionsOf = (category: UnitCategory): SearchSelectOption[] =>
    category.units.map((u) => ({ value: u.id, label: u.label, detail: u.symbol }));

const CATEGORY_OPTIONS: SearchSelectOption[] = UNIT_CATEGORIES.map((c) => ({ value: c.id, label: c.label }));

/** Les unités physiques. Tout se calcule ici, dans le navigateur : rien ne part sur le réseau. */
export function Units() {
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

    const options = useMemo(() => optionsOf(category), [category]);
    const result = value === null ? null : convertUnit(category, from, to, value);
    const symbol = category.units.find((u) => u.id === to)?.symbol ?? '';

    return (
        <div className={styles.tool}>
            <label className={styles.formatField}>
                <span className={styles.fieldLabel}>Grandeur</span>
                <SearchSelect
                    aria-label='Grandeur'
                    value={category.id}
                    onChange={pickCategory}
                    options={CATEGORY_OPTIONS}
                />
            </label>

            <div className={styles.converter}>
                <div className={styles.converterSide}>
                    <NumberInput live aria-label='Valeur à convertir' value={value} onChange={setValue} />
                    <SearchSelect
                        aria-label='Unité de départ'
                        searchPlaceholder='Chercher une unité…'
                        value={from}
                        options={options}
                        onChange={setFrom}
                    />
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
                        {result === null ? '…' : `${formatNumber(result)} ${symbol}`}
                    </output>
                    <SearchSelect
                        aria-label='Unité d’arrivée'
                        searchPlaceholder='Chercher une unité…'
                        value={to}
                        options={options}
                        onChange={setTo}
                    />
                </div>
            </div>
        </div>
    );
}

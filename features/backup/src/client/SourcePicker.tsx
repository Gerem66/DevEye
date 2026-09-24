import { useMemo } from 'react';
import type { BackupSourceCandidate, BackupSourceKind } from '../contracts/domain';

import { SearchSelect, type SearchSelectOption } from 'deveye-sdk-client';
import { candidateKey, SOURCE_GROUPS, SOURCE_ICONS } from './format';
import styles from './style.module.css';

interface SourcePickerProps {
    candidates: readonly BackupSourceCandidate[];
    /** La `sourceKey` choisie, `''` sans choix. */
    value: string;
    onChange: (value: string) => void;
    disabled?: boolean;
}

const RANK = Object.keys(SOURCE_GROUPS) as BackupSourceKind[];
const compareNames = new Intl.Collator('fr', { sensitivity: 'base', numeric: true }).compare;

/** « Quoi sauvegarder » : les sources rangées par genre, chaque genre par ordre alphabétique. */
export default function SourcePicker({ candidates, value, onChange, disabled }: SourcePickerProps) {
    const options = useMemo(
        () =>
            [...candidates]
                .sort((a, b) => RANK.indexOf(a.kind) - RANK.indexOf(b.kind) || compareNames(a.name, b.name))
                .map((c): SearchSelectOption => ({
                    value: candidateKey(c),
                    label: c.name,
                    group: SOURCE_GROUPS[c.kind],
                    prefix: <span className={`icon icon-${SOURCE_ICONS[c.kind]} ${styles.sourceIcon}`} />,
                    detail: c.tag ?? undefined,
                    // L'hôte et le nom d'une base se cherchent aussi.
                    keywords: c.detail ? [c.detail] : undefined,
                    disabled: !c.available
                })),
        [candidates]
    );

    return (
        <SearchSelect
            value={value}
            options={options}
            onChange={onChange}
            disabled={disabled}
            aria-label='Quoi sauvegarder'
            placeholder='Choisir une source…'
            searchPlaceholder='Rechercher une base, un partage, une machine…'
            emptyText={candidates.length === 0 ? 'Aucune source dans cet espace' : 'Aucune source ne correspond'}
        />
    );
}

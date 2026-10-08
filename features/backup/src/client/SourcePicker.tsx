import { useMemo } from 'react';
import type { BackupSourceCandidate, BackupSourceKind } from '../contracts/domain';

import { SearchSelect, type SearchSelectOption } from 'deveye-sdk-client';
import { candidateKey, SOURCE_GROUPS, SOURCE_ICONS } from './format';
import styles from './style.module.css';

interface SourcePickerProps {
    /** Les catégories offertes, dans l'ordre : chacune s'affiche, même vide. */
    kinds: readonly BackupSourceKind[];
    /** `null` tant que la liste n'est pas arrivée. */
    candidates: readonly BackupSourceCandidate[] | null;
    /** La `sourceKey` choisie, `''` sans choix. */
    value: string;
    onChange: (value: string) => void;
    disabled?: boolean;
}

const compareNames = new Intl.Collator('fr', { sensitivity: 'base', numeric: true }).compare;

/** « Quoi sauvegarder » : les sources rangées par catégorie, chacune par ordre alphabétique. */
export default function SourcePicker({ kinds, candidates, value, onChange, disabled }: SourcePickerProps) {
    const options = useMemo(
        () =>
            [...(candidates ?? [])]
                .sort((a, b) => compareNames(a.name, b.name))
                .map((c): SearchSelectOption => ({
                    value: candidateKey(c),
                    label: c.name,
                    group: SOURCE_GROUPS[c.kind],
                    prefix: <span className={`icon icon-${SOURCE_ICONS[c.kind]} ${styles.sourceIcon}`} />,
                    detail: c.tag ?? undefined,
                    // L'hôte et le nom d'une base, le chemin d'un volume se cherchent aussi.
                    keywords: c.detail ? [c.detail] : undefined,
                    disabled: !c.available
                })),
        [candidates]
    );
    const groups = useMemo(() => kinds.map((kind) => SOURCE_GROUPS[kind]), [kinds]);

    return (
        <SearchSelect
            value={value}
            options={options}
            groups={groups}
            onChange={onChange}
            disabled={disabled || candidates === null}
            aria-label='Quoi sauvegarder'
            placeholder={candidates === null ? 'Chargement des sources…' : 'Choisir une source…'}
            searchPlaceholder='Rechercher une base, une adresse, un dossier, une machine…'
            emptyText='Aucune source ne correspond'
        />
    );
}

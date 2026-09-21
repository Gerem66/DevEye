import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';

import { useDismissLayer } from '@/Components/Dialog';

import styles from './style.module.css';

export interface SearchSelectOption<T extends string = string> {
    value: T;
    label: string;
    /** Un repère devant le libellé : un drapeau, un symbole. Décoratif, jamais lu. */
    prefix?: string;
    /** Une précision à droite du libellé : un code, une unité. */
    detail?: string;
    /** Ce que la recherche lit en plus du libellé et de la précision. */
    keywords?: readonly string[];
}

export interface SearchSelectProps<T extends string> {
    value: T;
    options: readonly SearchSelectOption<T>[];
    onChange: (value: T) => void;
    'aria-label': string;
    searchPlaceholder?: string;
    emptyText?: string;
    disabled?: boolean;
    className?: string;
}

const LIST_MAX_HEIGHT = 300;
const GAP = 4;

/** Minuscules et sans accents : « etats » trouve « États-Unis ». */
const fold = (text: string): string => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

interface Anchor {
    left: number;
    width: number;
    top?: number;
    bottom?: number;
    maxHeight: number;
}

/**
 * Une liste déroulante dans laquelle on cherche. Pour une liste trop longue
 * pour être parcourue des yeux (devises, unités, pays) ; en deçà d'une dizaine
 * de choix, `SelectInput` reste plus simple.
 *
 * Le panneau passe par un portail vers `<body>`, comme `Dialog` : dans le corps
 * défilant d'un dialogue il serait rogné.
 */
export function SearchSelect<T extends string>({
    value,
    options,
    onChange,
    searchPlaceholder = 'Rechercher…',
    emptyText = 'Aucun résultat',
    disabled,
    className,
    ...aria
}: SearchSelectProps<T>) {
    const id = useId();
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState('');
    const [active, setActive] = useState(0);
    const [anchor, setAnchor] = useState<Anchor | null>(null);
    const trigger = useRef<HTMLButtonElement>(null);
    const panel = useRef<HTMLDivElement>(null);
    const search = useRef<HTMLInputElement>(null);

    const selected = options.find((o) => o.value === value);
    const placed = anchor !== null;
    const haystacks = useMemo(
        () => options.map((o) => fold([o.label, o.detail ?? '', ...(o.keywords ?? [])].join(' '))),
        [options]
    );
    const matches = useMemo(() => {
        const terms = fold(query).split(/\s+/).filter(Boolean);
        return options.filter((_, index) => terms.every((term) => haystacks[index].includes(term)));
    }, [options, haystacks, query]);

    const close = (refocus: boolean): void => {
        setOpen(false);
        setQuery('');
        if (refocus) trigger.current?.focus();
    };
    const pick = (next: T): void => {
        onChange(next);
        close(true);
    };
    useDismissLayer(open, () => close(true));

    // Le panneau suit son déclencheur : la fenêtre se redimensionne, un ancêtre
    // défile (`capture` attrape aussi le corps d'un dialogue).
    useLayoutEffect(() => {
        if (!open) return;
        const place = (): void => {
            const rect = trigger.current?.getBoundingClientRect();
            if (!rect) return;
            const below = window.innerHeight - rect.bottom - GAP * 2;
            const above = rect.top - GAP * 2;
            const up = below < 200 && above > below;
            setAnchor({
                left: rect.left,
                width: rect.width,
                ...(up ? { bottom: window.innerHeight - rect.top + GAP } : { top: rect.bottom + GAP }),
                maxHeight: Math.min(LIST_MAX_HEIGHT, up ? above : below)
            });
        };
        place();
        window.addEventListener('resize', place);
        window.addEventListener('scroll', place, true);
        return () => {
            window.removeEventListener('resize', place);
            window.removeEventListener('scroll', place, true);
        };
    }, [open]);

    useEffect(() => {
        if (!open) return;
        const outside = (event: MouseEvent): void => {
            const target = event.target as Node;
            if (trigger.current?.contains(target) || panel.current?.contains(target)) return;
            close(false);
        };
        document.addEventListener('mousedown', outside);
        return () => document.removeEventListener('mousedown', outside);
        // `close` ne lit que des setters stables.
    }, [open]);

    useEffect(() => {
        if (open && placed) search.current?.focus();
    }, [open, placed]);

    // À l'ouverture, le choix courant ; à chaque frappe, le premier résultat.
    useEffect(() => {
        if (!open) return;
        const current = query === '' ? matches.findIndex((o) => o.value === value) : 0;
        setActive(Math.max(0, current));
    }, [open, query]);

    useEffect(() => {
        if (open) document.getElementById(`${id}-option-${active}`)?.scrollIntoView({ block: 'nearest' });
    }, [open, active, id, placed]);

    const onKeyDown = (event: KeyboardEvent): void => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            if (matches.length === 0) return;
            const step = event.key === 'ArrowDown' ? 1 : -1;
            setActive((current) => (current + step + matches.length) % matches.length);
        } else if (event.key === 'Enter') {
            event.preventDefault();
            // Entrée choisit dans la liste : elle ne doit pas aussi valider le dialogue qui l'entoure.
            event.stopPropagation();
            const option = matches[active];
            if (option) pick(option.value);
        } else if (event.key === 'Tab') {
            close(false);
        }
    };

    return (
        <>
            <button
                ref={trigger}
                type='button'
                className={`${styles.trigger} ${className ?? ''}`}
                disabled={disabled}
                aria-haspopup='listbox'
                aria-expanded={open}
                aria-label={`${aria['aria-label']} : ${selected?.label ?? 'aucun choix'}`}
                onClick={() => setOpen((current) => !current)}
                onKeyDown={(event) => {
                    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                        event.preventDefault();
                        setOpen(true);
                    }
                }}
            >
                {selected?.prefix && (
                    <span className={styles.prefix} aria-hidden='true'>
                        {selected.prefix}
                    </span>
                )}
                <span className={styles.label}>{selected?.label ?? '…'}</span>
                {selected?.detail && <span className={styles.detail}>{selected.detail}</span>}
                <span className={`icon icon-chevron-down ${styles.chevron}`} aria-hidden='true' />
            </button>

            {open &&
                anchor &&
                createPortal(
                    <div
                        ref={panel}
                        className={styles.panel}
                        style={{ left: anchor.left, width: anchor.width, top: anchor.top, bottom: anchor.bottom }}
                    >
                        <input
                            ref={search}
                            className={styles.search}
                            type='text'
                            role='combobox'
                            aria-label={`${aria['aria-label']} : rechercher`}
                            aria-expanded='true'
                            aria-controls={`${id}-list`}
                            aria-activedescendant={matches[active] ? `${id}-option-${active}` : undefined}
                            aria-autocomplete='list'
                            autoComplete='off'
                            spellCheck={false}
                            placeholder={searchPlaceholder}
                            value={query}
                            onChange={(event) => setQuery(event.target.value)}
                            onKeyDown={onKeyDown}
                        />
                        <ul
                            id={`${id}-list`}
                            role='listbox'
                            aria-label={aria['aria-label']}
                            className={styles.list}
                            style={{ maxHeight: anchor.maxHeight }}
                        >
                            {matches.map((option, index) => (
                                <li
                                    key={option.value}
                                    id={`${id}-option-${index}`}
                                    role='option'
                                    aria-selected={option.value === value}
                                    className={`${styles.option} ${index === active ? styles.optionActive : ''} ${
                                        option.value === value ? styles.optionSelected : ''
                                    }`}
                                    // `mousedown` et non `click` : le champ de recherche ne perd pas le focus.
                                    onMouseDown={(event) => {
                                        event.preventDefault();
                                        pick(option.value);
                                    }}
                                    onMouseEnter={() => setActive(index)}
                                >
                                    {option.prefix && (
                                        <span className={styles.prefix} aria-hidden='true'>
                                            {option.prefix}
                                        </span>
                                    )}
                                    <span className={styles.label}>{option.label}</span>
                                    {option.detail && <span className={styles.detail}>{option.detail}</span>}
                                </li>
                            ))}
                            {matches.length === 0 && <li className={styles.empty}>{emptyText}</li>}
                        </ul>
                    </div>,
                    document.body
                )}
        </>
    );
}

export default SearchSelect;

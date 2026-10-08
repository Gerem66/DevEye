import {
    Fragment,
    useEffect,
    useId,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
    type KeyboardEvent,
    type ReactNode
} from 'react';
import { createPortal } from 'react-dom';

import { useDismissLayer } from '@/Components/Dialog';
import { foldText } from '@/foldText';

import styles from './style.module.css';

export interface SearchSelectOption<T extends string = string> {
    value: T;
    label: string;
    /** Un repère devant le libellé : un drapeau, un avatar. Décoratif, jamais lu. */
    prefix?: ReactNode;
    /** Une précision à droite du libellé : un code, une unité. */
    detail?: string;
    /** Ce que la recherche lit en plus du libellé et de la précision. */
    keywords?: readonly string[];
    /** La catégorie : les options d'un même groupe se suivent sous son intitulé. */
    group?: string;
    /** Visible mais impossible à choisir ; `detail` dit pourquoi. */
    disabled?: boolean;
}

/** Une pastille sous la recherche, qui ne garde que les options passant `test`. */
export interface SearchSelectFilter<T extends string = string> {
    value: string;
    label: string;
    test: (option: SearchSelectOption<T>) => boolean;
    /** Les pastilles d'une même clé s'excluent : en activer une relâche les autres. */
    exclusive?: string;
}

interface SearchSelectCommonProps<T extends string> {
    options: readonly SearchSelectOption<T>[];
    'aria-label': string;
    /** Ce que le déclencheur affiche quand aucune option ne porte la valeur courante. */
    placeholder?: string;
    searchPlaceholder?: string;
    emptyText?: string;
    /**
     * Les groupes toujours listés, dans cet ordre, même sans option : un groupe
     * vide montre `emptyGroupText` sous son titre. Ceux qui manquent ici
     * suivent dans l'ordre d'apparition.
     */
    groups?: readonly string[];
    emptyGroupText?: string;
    /** Le champ de recherche : `'auto'` (défaut) ne l'affiche qu'à partir de huit choix. */
    searchable?: boolean | 'auto';
    /** Des pastilles sous la recherche, combinées en ET, remises à zéro à la fermeture. */
    filters?: readonly SearchSelectFilter<T>[];
    /** L'identifiant du déclencheur, pour le `htmlFor` d'un libellé. */
    id?: string;
    /** Le champ que le dialogue ouvrant doit saisir (`data-autofocus`). */
    autoFocus?: boolean;
    disabled?: boolean;
    className?: string;
}

interface SearchSelectSingleProps<T extends string> extends SearchSelectCommonProps<T> {
    multiple?: false;
    value: T;
    onChange: (value: T) => void;
}

/** Des cases à cocher : un choix bascule l'option et laisse le panneau ouvert. */
interface SearchSelectMultipleProps<T extends string> extends SearchSelectCommonProps<T> {
    multiple: true;
    value: readonly T[];
    onChange: (value: T[]) => void;
}

export type SearchSelectProps<T extends string> = SearchSelectSingleProps<T> | SearchSelectMultipleProps<T>;

const LIST_MAX_HEIGHT = 300;
const GAP = 4;
/** Le panneau d'un déclencheur étroit garde des choix lisibles, sans sortir de l'écran. */
const PANEL_MIN_WIDTH = 240;
/** En deçà, la liste se parcourt des yeux : le champ de recherche gênerait plus qu'il n'aiderait. */
const AUTO_SEARCH_MIN = 8;
const NO_GROUPS: readonly string[] = [];

/** Chaque groupe d'un seul tenant : d'abord ceux de `fixed`, puis les autres dans l'ordre où ils apparaissent. */
function byGroup<T extends string>(
    options: readonly SearchSelectOption<T>[],
    fixed: readonly string[]
): SearchSelectOption<T>[] {
    const groups = new Map<string | undefined, SearchSelectOption<T>[]>(fixed.map((g) => [g, []]));
    for (const option of options) {
        const members = groups.get(option.group);
        if (members) members.push(option);
        else groups.set(option.group, [option]);
    }
    return [...groups.values()].flat();
}

/** La prochaine option choisissable dans le sens `delta`, en bouclant ; -1 s'il n'y en a aucune. */
function nextEnabled<T extends string>(matches: readonly SearchSelectOption<T>[], from: number, delta: 1 | -1): number {
    const count = matches.length;
    for (let step = 1; step <= count; step++) {
        const index = (((from + delta * step) % count) + count) % count;
        if (!matches[index].disabled) return index;
    }
    return -1;
}

interface Anchor {
    left: number;
    width: number;
    top?: number;
    bottom?: number;
    maxHeight: number;
}

/**
 * La liste déroulante de l'app. Le champ de recherche (minuscules, sans
 * accents, les intitulés de groupe compris) n'apparaît qu'à partir de huit
 * choix, ou sur demande ; des pastilles de filtre peuvent restreindre la liste.
 *
 * Le panneau passe par un portail vers `<body>`, comme `Dialog` : dans le corps
 * défilant d'un dialogue il serait rogné.
 *
 * `multiple` en fait une liste à cocher : la valeur est un tableau, et le
 * déclencheur montre les libellés choisis.
 */
export function SearchSelect<T extends string>(props: SearchSelectProps<T>) {
    const {
        options,
        placeholder = '…',
        searchPlaceholder = 'Rechercher…',
        emptyText = 'Aucun résultat',
        groups: fixedGroups = NO_GROUPS,
        emptyGroupText = 'Aucun',
        searchable = 'auto',
        filters,
        id: triggerId,
        autoFocus,
        disabled,
        className,
        'aria-label': ariaLabel
    } = props;
    const id = useId();
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState('');
    const [active, setActive] = useState(0);
    const [activeFilters, setActiveFilters] = useState<ReadonlySet<string>>(() => new Set());
    const [anchor, setAnchor] = useState<Anchor | null>(null);
    const trigger = useRef<HTMLButtonElement>(null);
    const panel = useRef<HTMLDivElement>(null);
    const search = useRef<HTMLInputElement>(null);
    const list = useRef<HTMLUListElement>(null);

    const hasSearch = searchable === 'auto' ? options.length >= AUTO_SEARCH_MIN : searchable;
    const chips = filters ?? [];
    const chosen: readonly T[] = props.multiple ? props.value : [props.value];
    const isChosen = (value: T): boolean => chosen.includes(value);
    const selection = options.filter((o) => isChosen(o.value));
    // Le repère et la précision d'une option ne parlent que d'elle : à plusieurs, le déclencheur n'en montre aucun.
    const selected = props.multiple ? undefined : selection[0];
    const triggerLabel = selection.length > 0 ? selection.map((o) => o.label).join(', ') : null;
    const placed = anchor !== null;
    const ordered = useMemo(() => byGroup(options, fixedGroups), [options, fixedGroups]);
    const haystacks = useMemo(
        () => ordered.map((o) => foldText([o.label, o.detail ?? '', o.group ?? '', ...(o.keywords ?? [])].join(' '))),
        [ordered]
    );
    const matches = useMemo(() => {
        const terms = foldText(query).split(/\s+/).filter(Boolean);
        const kept = chips.filter((chip) => activeFilters.has(chip.value));
        return ordered.filter(
            (option, index) =>
                terms.every((term) => haystacks[index].includes(term)) && kept.every((chip) => chip.test(option))
        );
    }, [ordered, haystacks, query, chips, activeFilters]);
    const narrowed = query.trim() !== '' || activeFilters.size > 0;
    // Les résultats par groupe ; `index` reste celui de la liste aplatie, que
    // suivent le clavier et les ids. Un groupe fixe sans option garde sa place,
    // sauf pendant une recherche, où un « Aucun » sous chaque titre ne dirait rien.
    const sections = useMemo(() => {
        const out: { group: string | undefined; items: { option: SearchSelectOption<T>; index: number }[] }[] = [];
        const byName = new Map<string | undefined, (typeof out)[number]>();
        if (!narrowed) {
            for (const group of fixedGroups) {
                const section: (typeof out)[number] = { group, items: [] };
                out.push(section);
                byName.set(group, section);
            }
        }
        matches.forEach((option, index) => {
            const known = byName.get(option.group);
            if (known) known.items.push({ option, index });
            else {
                const section = { group: option.group, items: [{ option, index }] };
                out.push(section);
                byName.set(option.group, section);
            }
        });
        return out;
    }, [matches, fixedGroups, narrowed]);

    const close = (refocus: boolean): void => {
        setOpen(false);
        setQuery('');
        setActiveFilters(new Set());
        if (refocus) trigger.current?.focus();
    };
    const toggleFilter = (chip: SearchSelectFilter<T>): void => {
        setActiveFilters((current) => {
            const next = new Set(current);
            if (next.has(chip.value)) {
                next.delete(chip.value);
                return next;
            }
            if (chip.exclusive !== undefined) {
                for (const other of chips) if (other.exclusive === chip.exclusive) next.delete(other.value);
            }
            next.add(chip.value);
            return next;
        });
    };
    const pick = (next: T): void => {
        if (props.multiple) {
            props.onChange(isChosen(next) ? props.value.filter((v) => v !== next) : [...props.value, next]);
            return;
        }
        props.onChange(next);
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
            const width = Math.min(Math.max(rect.width, PANEL_MIN_WIDTH), window.innerWidth - GAP * 4);
            setAnchor({
                left: Math.max(GAP * 2, Math.min(rect.left, window.innerWidth - width - GAP * 2)),
                width,
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

    // Sans champ de recherche, c'est la liste qui prend le clavier.
    useEffect(() => {
        if (open && placed) (hasSearch ? search.current : list.current)?.focus();
    }, [open, placed, hasSearch]);

    // À l'ouverture, le choix courant ; à chaque frappe ou filtre, le premier résultat choisissable.
    useEffect(() => {
        if (!open) return;
        const current = query === '' ? matches.findIndex((o) => isChosen(o.value) && !o.disabled) : -1;
        setActive(current >= 0 ? current : nextEnabled(matches, -1, 1));
    }, [open, query, activeFilters]);

    useEffect(() => {
        if (open) document.getElementById(`${id}-option-${active}`)?.scrollIntoView({ block: 'nearest' });
    }, [open, active, id, placed]);

    const onKeyDown = (event: KeyboardEvent): void => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            if (matches.length === 0) return;
            const delta = event.key === 'ArrowDown' ? 1 : -1;
            setActive((current) => nextEnabled(matches, current, delta));
        } else if (event.key === 'Enter') {
            event.preventDefault();
            // Entrée choisit dans la liste : elle ne doit pas aussi valider le dialogue qui l'entoure.
            event.stopPropagation();
            const option = matches[active];
            if (option && !option.disabled) pick(option.value);
        } else if (event.key === 'Tab') {
            // Les pastilles suivent dans l'ordre du document : Tab y mène au lieu de fermer.
            if (chips.length === 0 || event.shiftKey) close(false);
        }
    };

    return (
        <>
            <button
                ref={trigger}
                id={triggerId}
                data-autofocus={autoFocus ? '' : undefined}
                type='button'
                className={`${styles.trigger} ${className ?? ''}`}
                disabled={disabled}
                aria-haspopup='listbox'
                aria-expanded={open}
                aria-label={`${ariaLabel} : ${
                    props.multiple && selection.length > 1
                        ? `${selection.length} choix`
                        : (triggerLabel ?? 'aucun choix')
                }`}
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
                <span className={triggerLabel !== null ? styles.label : `${styles.label} ${styles.placeholder}`}>
                    {triggerLabel ?? placeholder}
                </span>
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
                        {hasSearch && (
                            <input
                                ref={search}
                                className={styles.search}
                                type='text'
                                role='combobox'
                                aria-label={`${ariaLabel} : rechercher`}
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
                        )}
                        {chips.length > 0 && (
                            <div className={styles.filters} role='group' aria-label='Filtres'>
                                {chips.map((chip, position) => {
                                    const on = activeFilters.has(chip.value);
                                    return (
                                        <button
                                            key={chip.value}
                                            type='button'
                                            className={`${styles.chip} ${on ? styles.chipOn : ''}`}
                                            aria-pressed={on}
                                            // `mousedown` empêché : le champ de recherche garde le focus.
                                            onMouseDown={(event) => event.preventDefault()}
                                            onClick={() => toggleFilter(chip)}
                                            onKeyDown={(event) => {
                                                if (
                                                    event.key === 'Tab' &&
                                                    !event.shiftKey &&
                                                    position === chips.length - 1
                                                ) {
                                                    close(false);
                                                }
                                            }}
                                        >
                                            {chip.label}
                                        </button>
                                    );
                                })}
                            </div>
                        )}
                        <ul
                            ref={list}
                            id={`${id}-list`}
                            role='listbox'
                            aria-label={ariaLabel}
                            aria-multiselectable={props.multiple || undefined}
                            aria-activedescendant={!hasSearch && matches[active] ? `${id}-option-${active}` : undefined}
                            tabIndex={hasSearch ? undefined : -1}
                            onKeyDown={hasSearch ? undefined : onKeyDown}
                            className={styles.list}
                            style={{ maxHeight: anchor.maxHeight }}
                        >
                            {sections.map((section) => {
                                const items = section.items.map(({ option, index }) => (
                                    <li
                                        key={index}
                                        id={`${id}-option-${index}`}
                                        role='option'
                                        aria-selected={isChosen(option.value)}
                                        aria-disabled={option.disabled || undefined}
                                        className={`${styles.option} ${index === active ? styles.optionActive : ''} ${
                                            isChosen(option.value) ? styles.optionSelected : ''
                                        } ${option.disabled ? styles.optionDisabled : ''}`}
                                        // `mousedown` et non `click` : le champ de recherche ne perd pas le focus.
                                        onMouseDown={(event) => {
                                            event.preventDefault();
                                            if (!option.disabled) pick(option.value);
                                        }}
                                        onMouseEnter={() => {
                                            if (!option.disabled) setActive(index);
                                        }}
                                    >
                                        {props.multiple && (
                                            <span
                                                className={`${styles.check} ${isChosen(option.value) ? styles.checkOn : ''}`}
                                                aria-hidden='true'
                                            >
                                                <span className={`icon icon-v ${styles.checkMark}`} />
                                            </span>
                                        )}
                                        {option.prefix && (
                                            <span className={styles.prefix} aria-hidden='true'>
                                                {option.prefix}
                                            </span>
                                        )}
                                        <span className={styles.label}>{option.label}</span>
                                        {option.detail && <span className={styles.detail}>{option.detail}</span>}
                                    </li>
                                ));
                                if (section.group === undefined) return <Fragment key='ungrouped'>{items}</Fragment>;
                                return (
                                    <li
                                        key={`group:${section.group}`}
                                        role='group'
                                        aria-label={section.group}
                                        className={styles.group}
                                    >
                                        <span className={styles.groupLabel} aria-hidden='true'>
                                            {section.group}
                                        </span>
                                        {items.length > 0 ? (
                                            <ul role='presentation' className={styles.groupList}>
                                                {items}
                                            </ul>
                                        ) : (
                                            <span className={styles.groupEmpty}>{emptyGroupText}</span>
                                        )}
                                    </li>
                                );
                            })}
                            {sections.length === 0 && <li className={styles.empty}>{emptyText}</li>}
                        </ul>
                    </div>,
                    document.body
                )}
        </>
    );
}

export default SearchSelect;

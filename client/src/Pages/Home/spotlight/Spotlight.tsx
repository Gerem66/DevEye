import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import type { FeatureId, HomeLayout } from '@deveye/types';

import { useDismissLayer } from '@/Components/Dialog';
import { foldText } from '@/foldText';
import { installFeature, placedFeatureIds } from '@/stores/homeLayout';
import { closeSpotlight, useSpotlight } from '@/stores/spotlight';
import { catalogEntries, visibleFeatureCatalog, type FeatureCatalogEntry } from '../catalog';
import styles from './Spotlight.module.css';

interface SpotlightProps {
    layout: HomeLayout;
    canLayout: boolean;
    canFeature: (f: FeatureId) => boolean;
    /** Ouvre la vue : la garde de l'accueil (droits, maintenance) décide. */
    onOpen: (featureId: string) => void;
}

interface Result {
    entry: FeatureCatalogEntry;
    installed: boolean;
}

/**
 * La recherche des fonctionnalités par leur nom : celles de l'accueil d'abord,
 * puis celles qu'on peut encore y poser, installées d'un geste.
 */
export function Spotlight(props: SpotlightProps) {
    const { open, seed } = useSpotlight();
    return createPortal(
        <AnimatePresence>{open && <SpotlightPanel key='spotlight' seed={seed} {...props} />}</AnimatePresence>,
        document.body
    );
}

/** Noms qui commencent par la saisie d'abord, puis l'ordre alphabétique. */
function rank(entries: FeatureCatalogEntry[], needle: string): FeatureCatalogEntry[] {
    return entries
        .map((entry) => ({ entry, at: foldText(entry.title).indexOf(needle) }))
        .filter(({ at }) => at !== -1)
        .sort((a, b) => Number(a.at !== 0) - Number(b.at !== 0) || a.entry.title.localeCompare(b.entry.title, 'fr'))
        .map(({ entry }) => entry);
}

/** Le titre, avec le passage trouvé mis en avant. Les indices se lisent sur le texte replié. */
function highlight(title: string, needle: string): ReactNode {
    if (!needle) return title;
    let folded = '';
    const origin: number[] = [];
    let offset = 0;
    for (const char of title) {
        for (const unit of foldText(char)) {
            folded += unit;
            origin.push(offset);
        }
        offset += char.length;
    }
    const at = folded.indexOf(needle);
    if (at === -1) return title;
    const start = origin[at];
    const last = origin[at + needle.length - 1];
    const end = last + (title.codePointAt(last)! > 0xffff ? 2 : 1);
    return (
        <>
            {title.slice(0, start)}
            <mark className={styles.hit}>{title.slice(start, end)}</mark>
            {title.slice(end)}
        </>
    );
}

function SpotlightPanel({ seed, layout, canLayout, canFeature, onOpen }: SpotlightProps & { seed: string }) {
    const [query, setQuery] = useState(seed);
    const [active, setActive] = useState(0);
    const inputRef = useRef<HTMLInputElement>(null);
    const listRef = useRef<HTMLUListElement>(null);

    useDismissLayer(true, closeSpotlight);

    // La lettre qui a ouvert la barre est déjà dans le champ : la suite s'écrit après elle.
    useLayoutEffect(() => {
        const input = inputRef.current;
        if (!input) return;
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
    }, []);

    const needle = foldText(query.trim());
    const results = useMemo((): Result[] => {
        const installed = catalogEntries(placedFeatureIds(layout));
        const placed = new Set<string>(installed.map((e) => e.id));
        const ranked = rank(installed, needle).map((entry) => ({ entry, installed: true }));
        // Sans saisie, tout le catalogue noierait l'accueil : on n'y montre que ce qui y est.
        if (!needle) return ranked;
        const others = visibleFeatureCatalog().filter((e) => !placed.has(e.id) && canFeature(e.id as FeatureId));
        return [...ranked, ...rank(others, needle).map((entry) => ({ entry, installed: false }))];
    }, [layout, needle, canFeature]);

    const current = Math.min(active, results.length - 1);
    const firstOther = results.findIndex((r) => !r.installed);

    useLayoutEffect(() => {
        listRef.current?.querySelector('[data-active]')?.scrollIntoView({ block: 'nearest' });
    }, [current]);

    const pick = ({ entry, installed }: Result) => {
        if (!installed && canLayout) installFeature(entry.id);
        closeSpotlight();
        onOpen(entry.id);
    };

    const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            if (results.length === 0) return;
            const delta = e.key === 'ArrowDown' ? 1 : -1;
            setActive((current + delta + results.length) % results.length);
        } else if (e.key === 'Enter') {
            e.preventDefault();
            const result = results[current];
            if (result) pick(result);
        }
    };

    const optionId = (r: Result) => `spotlight-${r.entry.id}`;

    return (
        <div className={styles.root}>
            <motion.div
                className={styles.overlay}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15, ease: 'easeOut' }}
                onClick={closeSpotlight}
            />
            <motion.div
                className={styles.panel}
                role='dialog'
                aria-modal='true'
                aria-label='Rechercher une fonctionnalité'
                initial={{ opacity: 0, y: -12, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -12, scale: 0.98 }}
                transition={{ type: 'spring', stiffness: 420, damping: 32 }}
            >
                <div className={styles.field}>
                    <span className={`icon icon-search ${styles.fieldIcon}`} />
                    <input
                        ref={inputRef}
                        className={styles.input}
                        value={query}
                        onChange={(e) => {
                            setQuery(e.target.value);
                            setActive(0);
                        }}
                        onKeyDown={onKeyDown}
                        placeholder='Rechercher une fonctionnalité'
                        spellCheck={false}
                        autoComplete='off'
                        role='combobox'
                        aria-expanded={results.length > 0}
                        aria-controls='spotlight-results'
                        aria-activedescendant={results[current] ? optionId(results[current]) : undefined}
                    />
                </div>

                {results.length > 0 ? (
                    <ul ref={listRef} id='spotlight-results' className={styles.list} role='listbox'>
                        {results.map((result, index) => (
                            <li key={result.entry.id} role='presentation'>
                                {index === firstOther && (
                                    <div className={styles.groupTitle}>Pas encore sur l’accueil</div>
                                )}
                                <div
                                    id={optionId(result)}
                                    role='option'
                                    aria-selected={index === current}
                                    data-active={index === current ? '' : undefined}
                                    className={`${styles.row} ${result.installed ? '' : styles.rowOther}`}
                                    onMouseMove={() => setActive(index)}
                                    onClick={() => pick(result)}
                                >
                                    <span className={styles.badge}>
                                        <span className={`icon icon-${result.entry.icon}`} />
                                    </span>
                                    <span className={styles.text}>
                                        <span className={styles.title}>{highlight(result.entry.title, needle)}</span>
                                        <span className={styles.description}>{result.entry.description}</span>
                                    </span>
                                    {!result.installed &&
                                        (canLayout ? (
                                            <span className={styles.install}>
                                                <span className='icon icon-plus' />
                                                Installer
                                            </span>
                                        ) : (
                                            <span className={styles.notInstalled}>Non installée</span>
                                        ))}
                                </div>
                            </li>
                        ))}
                    </ul>
                ) : (
                    <p className={styles.empty}>
                        {needle
                            ? `Aucune fonctionnalité ne correspond à « ${query.trim()} ».`
                            : 'Aucune fonctionnalité sur cet accueil pour le moment.'}
                    </p>
                )}

                <div className={styles.footer}>
                    <span>
                        <kbd className={styles.kbd}>↑</kbd>
                        <kbd className={styles.kbd}>↓</kbd> naviguer
                    </span>
                    <span>
                        <kbd className={styles.kbd}>Entrée</kbd> ouvrir
                    </span>
                    <span>
                        <kbd className={styles.kbd}>Échap</kbd> fermer
                    </span>
                </div>
            </motion.div>
        </div>
    );
}

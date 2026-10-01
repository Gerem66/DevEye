import { Fragment, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import CopyButton from '@/Components/CopyButton';
import LoadingVeil from '@/Components/LoadingVeil';
import TextInput from '@/Components/TextInput';
import { classifyLog, type LogLineKind, type LogToken } from './classify';
import styles from './style.module.css';

export interface LogOutputProps {
    /** Le journal brut, séquences ANSI comprises : le composant nettoie. */
    text: string;
    /** Une lecture en cours : le voile, par-dessus ce qui est déjà là. */
    busy?: boolean;
    /** Recherche, compte et copie au-dessus des lignes. Défaut `true`. */
    toolbar?: boolean;
    /** Ce qui se lit quand le journal est vide. */
    emptyText?: string;
    /** Reste en bas quand du texte arrive et que le lecteur y était. Défaut `true`. */
    follow?: boolean;
    /** Borne la hauteur du corps hors d'une colonne flex (un bloc dans une fiche). */
    maxHeight?: number;
    className?: string;
    'aria-label'?: string;
}

const KIND_CLASS: Record<LogLineKind, string> = {
    step: styles.lineStep,
    error: styles.lineError,
    warning: styles.lineWarning,
    success: styles.lineSuccess,
    muted: styles.lineMuted,
    plain: ''
};

const TOKEN_CLASS: Record<LogToken['kind'], string> = {
    text: '',
    time: styles.tokTime,
    duration: styles.tokDuration,
    id: styles.tokId
};

const plural = (n: number): string => `${n.toLocaleString('fr-FR')} ligne${n > 1 ? 's' : ''}`;

/** Les occurrences de `needle` (déjà en minuscules) dans `text`, surlignées. */
function highlight(text: string, needle: string): ReactNode {
    if (!needle) return text;
    const lower = text.toLowerCase();
    const parts: ReactNode[] = [];
    let from = 0;
    for (let at = lower.indexOf(needle, from); at !== -1; at = lower.indexOf(needle, from)) {
        if (at > from) parts.push(text.slice(from, at));
        parts.push(
            <mark key={at} className={styles.mark}>
                {text.slice(at, at + needle.length)}
            </mark>
        );
        from = at + needle.length;
    }
    if (parts.length === 0) return text;
    if (from < text.length) parts.push(text.slice(from));
    return parts;
}

/**
 * Un journal brut lisible : la sortie d'un fournisseur ou d'un outil, telle
 * qu'elle arrive, nettoyée de ses codes ANSI et colorée par ce que chaque ligne
 * dit (étape, erreur, avertissement, succès), avec ses horodatages et durées
 * en retrait. La barre filtre les lignes et copie ce qui est affiché. Dans une
 * colonne flex (un `Dialog tall`), le composant prend la place qui reste.
 */
export default function LogOutput({
    text,
    busy = false,
    toolbar = true,
    emptyText = 'Journal vide.',
    follow = true,
    maxHeight,
    className,
    'aria-label': ariaLabel
}: LogOutputProps) {
    const [query, setQuery] = useState('');
    const body = useRef<HTMLDivElement>(null);
    /** Le lecteur était en bas avant la dernière arrivée : on l'y garde. */
    const atBottom = useRef(true);

    const lines = useMemo(() => classifyLog(text), [text]);
    const needle = query.trim().toLowerCase();
    const shown = useMemo(
        () => (needle ? lines.filter((line) => line.text.toLowerCase().includes(needle)) : lines),
        [lines, needle]
    );
    const copyValue = useMemo(() => shown.map((line) => line.text).join('\n'), [shown]);

    useLayoutEffect(() => {
        const el = body.current;
        if (!el || !follow || !atBottom.current) return;
        el.scrollTop = el.scrollHeight;
    }, [lines, follow]);

    const onScroll = (): void => {
        const el = body.current;
        if (el) atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
    };

    const count = shown.length === lines.length ? plural(lines.length) : `${plural(shown.length)} sur ${lines.length}`;

    return (
        <div className={`${styles.root} ${className ?? ''}`}>
            {toolbar && (
                <div className={styles.toolbar}>
                    <div className={styles.search}>
                        <TextInput
                            type='search'
                            value={query}
                            onChange={(event) => setQuery(event.target.value)}
                            placeholder='Filtrer les lignes…'
                            aria-label='Filtrer les lignes du journal'
                        />
                    </div>
                    <span className={styles.count}>{count}</span>
                    <CopyButton value={copyValue} label='Copier les lignes affichées' />
                </div>
            )}
            <div className={styles.viewport}>
                <div
                    ref={body}
                    role='log'
                    aria-label={ariaLabel}
                    className={styles.body}
                    style={maxHeight === undefined ? undefined : { maxHeight }}
                    onScroll={onScroll}
                >
                    {lines.length === 0 && !busy ? (
                        <p className={styles.empty}>{emptyText}</p>
                    ) : shown.length === 0 ? (
                        <p className={styles.empty}>Aucune ligne ne contient « {query.trim()} ».</p>
                    ) : (
                        shown.map((line, index) => (
                            <div key={index} className={`${styles.line} ${KIND_CLASS[line.kind]}`}>
                                {line.tokens.length === 0
                                    ? ' '
                                    : line.tokens.map((token, position) =>
                                          token.kind === 'text' ? (
                                              <Fragment key={position}>{highlight(token.text, needle)}</Fragment>
                                          ) : (
                                              <span key={position} className={TOKEN_CLASS[token.kind]}>
                                                  {highlight(token.text, needle)}
                                              </span>
                                          )
                                      )}
                            </div>
                        ))
                    )}
                </div>
                {busy && <LoadingVeil delayed />}
            </div>
        </div>
    );
}

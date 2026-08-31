import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
    FeatureSettingsButton,
    SegmentedControl,
    TextInput,
    useLiveSegment,
    useWorkspacePermissions
} from 'deveye-sdk-client';
import type { FeatureViewProps } from '@deveye/types/sdk/client';

import { CVE_SEARCH_QUERY_MAX } from '../contracts/commands';
import type { CveEntry, CveSeverityFilter } from '../contracts/domain';

import { api } from './api';
import CveDetail from './CveDetail';
import CveRow, { rowDomId } from './CveRow';
import { cveError, type CveError } from './errors';
import { DETAIL_AS_PAGE } from './layout';
import { SEVERITY_FILTERS } from './severity';
import { NEWS_LIMIT, refreshCveNews, useCveNews } from './store';
import styles from './style.module.css';

/**
 * Veille CVE : le fil des vulnérabilités publiées, la recherche dans le
 * catalogue du NVD, et celles que l'espace a épinglées.
 *
 * Une recherche non vide prend le dessus sur l'onglet : c'est le geste le plus
 * direct, il ne doit pas demander de changer d'onglet d'abord.
 */

/**
 * Une seule constante : la largeur qu'anime framer-motion et celle que le
 * contenu garde pendant qu'elle change. Elle comprend l'écart d'avec la liste
 * (`padding-left` de `.detailInner`), qui vit dans le panneau pour disparaître
 * avec lui plutôt que d'un coup à son démontage.
 */
const DETAIL_WIDTH = 396;
const SEARCH_DEBOUNCE_MS = 500;

type Tab = 'news' | 'favorites';

const TABS = [
    { value: 'news' as const, label: 'Actualités' },
    { value: 'favorites' as const, label: 'Épinglées' }
];

interface SearchState {
    entries: CveEntry[];
    truncated: boolean;
    remote: boolean;
    remoteError: string | null;
    loading: boolean;
    error: CveError | null;
}

const NO_SEARCH: SearchState = {
    entries: [],
    truncated: false,
    remote: false,
    remoteError: null,
    loading: false,
    error: null
};

export default function Cve(_props: FeatureViewProps) {
    const [tab, setTab] = useState<Tab>('news');
    const [severity, setSeverity] = useState<CveSeverityFilter>('all');
    const [query, setQuery] = useState('');
    const [search, setSearch] = useState<SearchState>(NO_SEARCH);
    const [favorites, setFavorites] = useState<CveEntry[]>([]);
    const [favoritesLoading, setFavoritesLoading] = useState(true);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    /** Une CVE ouverte qu'aucune liste ne porte : une téléportation, ou un résultat effacé depuis. */
    const [fetched, setFetched] = useState<CveEntry | null>(null);
    const [error, setError] = useState<CveError | null>(null);

    const news = useCveNews();
    const canWrite = useWorkspacePermissions().canFeature('cve', 'write');
    const searching = query.trim().length > 0;

    const loadFavorites = useCallback(async () => {
        try {
            const res = await api.send('cve.favorites', {});
            setFavorites(res.entries);
        } catch (e) {
            setError(cveError(e, 'Les épingles n’ont pas pu être lues.'));
        } finally {
            setFavoritesLoading(false);
        }
    }, []);

    useEffect(() => {
        void loadFavorites();
    }, [loadFavorites]);

    // La recherche part côté serveur : le catalogue local n'est qu'une partie du
    // corpus, et le NVD complète. Débattue, et gardée contre les courses.
    useEffect(() => {
        const needle = query.trim();
        if (needle.length === 0) {
            setSearch(NO_SEARCH);
            return;
        }
        let cancelled = false;
        setSearch((prev) => ({ ...prev, loading: true, error: null }));
        const timer = setTimeout(() => {
            void (async () => {
                try {
                    const res = await api.send('cve.search', { query: needle, severity, limit: NEWS_LIMIT });
                    if (cancelled) return;
                    setSearch({ ...res, loading: false, error: null });
                } catch (e) {
                    if (cancelled) return;
                    setSearch({ ...NO_SEARCH, error: cveError(e, 'La recherche a échoué.') });
                }
            })();
        }, SEARCH_DEBOUNCE_MS);
        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [query, severity]);

    const shown: readonly CveEntry[] = useMemo(() => {
        if (searching) return search.entries;
        if (tab === 'favorites') {
            return severity === 'all' ? favorites : favorites.filter((e) => e.severity === severity);
        }
        return severity === 'all' ? news.entries : news.entries.filter((e) => e.severity === severity);
    }, [searching, search.entries, tab, severity, favorites, news.entries]);

    const selected = useMemo(
        () =>
            selectedId === null
                ? null
                : (shown.find((e) => e.id === selectedId) ??
                  favorites.find((e) => e.id === selectedId) ??
                  news.entries.find((e) => e.id === selectedId) ??
                  (fetched?.id === selectedId ? fetched : null)),
        [selectedId, shown, favorites, news.entries, fetched]
    );

    // Aucune liste ne porte cette CVE : la chercher, au besoin chez le NVD.
    // C'est le chemin d'une téléportation vers un identifiant qu'on n'a jamais vu.
    useEffect(() => {
        if (selectedId === null || selected !== null) return;
        let cancelled = false;
        void (async () => {
            try {
                const res = await api.send('cve.get', { id: selectedId });
                if (!cancelled) setFetched(res.entry);
            } catch (e) {
                if (!cancelled) setError(cveError(e, 'Cette CVE n’a pas pu être lue.'));
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [selectedId, selected]);

    // Quand la fiche occupait toute la page, revenir à la liste doit rendre la
    // CVE qu'on lisait, et pas le haut du fil : elle est cachée, jamais démontée,
    // donc tout le reste de son état est déjà là.
    const lastOpened = useRef<string | null>(null);
    useEffect(() => {
        if (selectedId !== null) {
            lastOpened.current = selectedId;
            return;
        }
        const previous = lastOpened.current;
        lastOpened.current = null;
        if (previous === null || !window.matchMedia(DETAIL_AS_PAGE).matches) return;
        document.getElementById(rowDomId(previous))?.scrollIntoView({ block: 'center' });
    }, [selectedId]);

    // La CVE ouverte est le niveau profond ; la racine `view:cve` vient de l'accueil.
    const liveTarget = useLiveSegment('l1', selectedId);
    useEffect(() => {
        if (!liveTarget) return;
        setSelectedId(liveTarget.value);
    }, [liveTarget]);

    const toggleFavorite = useCallback(
        async (entry: CveEntry) => {
            setError(null);
            try {
                const res = await api.send('cve.setFavorite', { id: entry.id, favorite: !entry.isFavorite });
                // Le serveur bat le sujet, qui ne ravive que `cve.favorites` : le
                // fil et les résultats de recherche se corrigent ici, à la main.
                const patch = (list: CveEntry[]): CveEntry[] =>
                    list.map((e) => (e.id === res.entry.id ? res.entry : e));
                setSearch((prev) => ({ ...prev, entries: patch(prev.entries) }));
                setFetched((prev) => (prev?.id === res.entry.id ? res.entry : prev));
                await Promise.all([loadFavorites(), refreshCveNews()]);
            } catch (e) {
                setError(cveError(e, 'L’épingle n’a pas pu être posée.'));
            }
        },
        [loadFavorites]
    );

    const loading = searching ? search.loading : tab === 'favorites' ? favoritesLoading : news.loading;
    const banner = error ?? search.error ?? news.error;

    return (
        <div className={`${styles.root} ${selected ? styles.hasDetail : ''}`}>
            <header className={styles.head}>
                <div className={styles.headRow}>
                    <h2 className={styles.title}>Veille CVE</h2>
                    <div className={styles.searchBox}>
                        {/* La classe du module EN PLUS de la globale : un module CSS
                            hache aussi `.icon`, donc `.searchBox .icon` ne toucherait
                            jamais l'icône de l'app. */}
                        <span className={`icon icon-search ${styles.searchIcon}`} aria-hidden='true' />
                        {/* `text` et non `search` : la croix d'effacement est la
                            nôtre, et un champ de recherche en ajouterait une
                            seconde, dessinée par le moteur. */}
                        <TextInput
                            type='text'
                            role='searchbox'
                            className={styles.searchInput}
                            value={query}
                            maxLength={CVE_SEARCH_QUERY_MAX}
                            placeholder='CVE-2021-44228, log4j, apache…'
                            aria-label='Chercher une vulnérabilité'
                            onChange={(e) => setQuery(e.target.value)}
                        />
                        {searching && (
                            <button
                                type='button'
                                className={styles.clearInput}
                                title='Effacer la recherche'
                                aria-label='Effacer la recherche'
                                onClick={() => setQuery('')}
                            >
                                <span className='icon icon-x' />
                            </button>
                        )}
                    </div>
                    <FeatureSettingsButton scope={{ kind: 'feature', feature: 'cve' }} />
                </div>

                <div className={styles.filters}>
                    {searching ? (
                        <button type='button' className={styles.clearSearch} onClick={() => setQuery('')}>
                            <span className={`icon icon-x ${styles.clearIcon}`} aria-hidden='true' />
                            Résultats pour « {query.trim()} »
                        </button>
                    ) : (
                        <SegmentedControl
                            options={TABS}
                            value={tab}
                            onChange={setTab}
                            aria-label='Ce que la liste montre'
                        />
                    )}
                    <div className={styles.severityChips} role='group' aria-label='Filtrer par gravité'>
                        {SEVERITY_FILTERS.map((f) => (
                            <button
                                key={f.value}
                                type='button'
                                className={`${styles.chip} ${f.value === severity ? styles.chipActive : ''}`}
                                aria-pressed={f.value === severity}
                                onClick={() => setSeverity(f.value)}
                            >
                                {f.label}
                            </button>
                        ))}
                    </div>
                </div>

                <p className={styles.status}>{statusLine({ searching, search, news, loading, count: shown.length })}</p>
            </header>

            {banner && (
                <p className={styles.error} role='alert'>
                    <span className={`icon icon-x-circle ${styles.errorIcon}`} aria-hidden='true' />
                    <span>{banner.text}</span>
                    {banner.code && <span className={styles.errorCode}>{banner.code}</span>}
                </p>
            )}

            <div className={styles.split}>
                <div className={styles.listPane}>
                    {shown.length === 0 && !loading ? (
                        <p className={styles.empty}>{emptyLine(searching, tab, severity, news.ingestedAt)}</p>
                    ) : (
                        <ul className={styles.list}>
                            {shown.map((entry) => (
                                <CveRow
                                    key={entry.id}
                                    entry={entry}
                                    selected={entry.id === selectedId}
                                    canWrite={canWrite}
                                    onOpen={(e) => setSelectedId((cur) => (cur === e.id ? null : e.id))}
                                    onToggleFavorite={(e) => void toggleFavorite(e)}
                                />
                            ))}
                        </ul>
                    )}
                </div>

                {/* Le détail n'occupe la droite que lorsqu'on en veut un. */}
                <AnimatePresence>
                    {selected && (
                        <motion.aside
                            key='detail'
                            className={styles.detailPane}
                            initial={{ x: 24, width: 0, opacity: 0 }}
                            animate={{ x: 0, width: DETAIL_WIDTH, opacity: 1 }}
                            exit={{ x: 24, width: 0, opacity: 0 }}
                            transition={{
                                type: 'spring',
                                stiffness: 380,
                                damping: 34,
                                opacity: { type: 'tween', duration: 0.12, ease: 'easeOut' }
                            }}
                        >
                            {/* Le contenu garde sa largeur pendant que le panneau
                                perd la sienne : `overflow: hidden` le rogne au lieu
                                de le remettre en page. */}
                            <div className={styles.detailInner} style={{ width: DETAIL_WIDTH }}>
                                <CveDetail
                                    entry={selected}
                                    canWrite={canWrite}
                                    onToggleFavorite={(e) => void toggleFavorite(e)}
                                    onClose={() => setSelectedId(null)}
                                />
                            </div>
                        </motion.aside>
                    )}
                </AnimatePresence>
            </div>
        </div>
    );
}

/** Ce que la liste couvre vraiment : jamais laisser croire à une absence quand c'est le NVD qui a manqué. */
function statusLine(args: {
    searching: boolean;
    search: SearchState;
    news: { ingestedAt: number | null };
    loading: boolean;
    count: number;
}): string {
    const { searching, search, news, loading, count } = args;
    if (loading) return 'Chargement…';
    if (searching) {
        const scope = search.remoteError
            ? `catalogue local seulement (le NVD n’a pas répondu : ${search.remoteError})`
            : search.remote
              ? 'catalogue local et NVD'
              : 'catalogue local';
        return `${count} résultat${count > 1 ? 's' : ''}${search.truncated ? ' ou plus' : ''}, ${scope}.`;
    }
    if (news.ingestedAt === null) return 'Le catalogue se remplit au premier tour d’ingestion.';
    return `Catalogue à jour au ${new Date(news.ingestedAt * 1000).toLocaleString('fr-FR', {
        day: 'numeric',
        month: 'long',
        hour: '2-digit',
        minute: '2-digit'
    })}.`;
}

function emptyLine(searching: boolean, tab: Tab, severity: CveSeverityFilter, ingestedAt: number | null): string {
    if (searching) return 'Aucune vulnérabilité ne correspond.';
    if (tab === 'favorites') return 'Rien d’épinglé dans cet espace. L’étoile d’une CVE la range ici.';
    // Un fil vide avant le premier tour n'est pas une absence : le dire, sinon
    // la vue accuse le filtre de ce que l'ingestion n'a pas encore fait.
    if (ingestedAt === null) return 'Le catalogue se remplit. Le fil s’affichera dès le premier tour d’ingestion.';
    if (severity !== 'all') return 'Aucune vulnérabilité de cette gravité dans le fil.';
    return 'Le fil est vide.';
}

/** La carte de grille répond à « quoi de neuf », pas « combien en tout ». */
export function CveWidget() {
    const { entries, loading } = useCveNews();
    const week = Math.floor(Date.now() / 1000) - 7 * 86_400;
    const recent = entries.filter((e) => e.published >= week);
    const serious = recent.filter((e) => e.severity === 'critical' || e.severity === 'high');
    const latest = entries[0] ?? null;

    return (
        <div className={styles.widget}>
            <div className={styles.widgetStat}>
                <span className={`${styles.widgetValue} ${!loading && serious.length > 0 ? styles.widgetAlert : ''}`}>
                    {loading ? '—' : serious.length}
                </span>
                <span className={styles.widgetLabel}>
                    {serious.length > 1 ? 'graves cette semaine' : 'grave cette semaine'}
                </span>
            </div>
            <span className={styles.widgetFoot}>
                {loading
                    ? 'Chargement…'
                    : latest === null
                      ? 'Le catalogue se remplit'
                      : `Dernière parue : ${latest.id}`}
            </span>
        </div>
    );
}

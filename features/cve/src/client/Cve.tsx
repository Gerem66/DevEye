import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    ErrorNote,
    FeatureSettingsButton,
    SegmentedControl,
    StickyHeader,
    TextInput,
    useLiveSegment,
    useResource,
    useSubView,
    useWorkspacePermissions,
    type ErrorNoteInput
} from 'deveye-sdk-client';
import type { FeatureViewProps } from '@deveye/types/sdk/client';

import { CVE_SEARCH_QUERY_MAX, type SearchScope } from '../contracts/commands';
import type { CveEntry, CveSeverityFilter } from '../contracts/domain';
import type { Software } from '../contracts/software';

import { api } from './api';
import CveDetail from './CveDetail';
import CveRow, { rowDomId } from './CveRow';
import DetailPane from './DetailPane';
import { cveError } from './errors';
import InventoryView from './InventoryView';
import { DETAIL_AS_PAGE } from './layout';
import ObsolescenceView from './ObsolescenceView';
import { SEVERITY_FILTERS } from './severity';
import SoftwareRow from './SoftwareRow';
import SoftwareSheet from './SoftwareSheet';
import { NEWS_LIMIT, refreshCveNews, useCveNews } from './store';
import styles from './style.module.css';
import VulnView from './VulnView';

/**
 * Veille CVE : les failles qui touchent ce que l'espace fait tourner, ce qui y
 * vieillit (fins de vie, versions dépréciées ou en retard), l'inventaire que la
 * veille en dresse, les dernières CVE publiées, la recherche dans le catalogue
 * du NVD, et celles que l'espace a épinglées.
 *
 * Une recherche non vide prend le dessus sur l'onglet : c'est le geste le plus
 * direct, il ne doit pas demander de changer d'onglet d'abord. Elle cherche
 * aussi les logiciels d'endoflife.date, et leur branche quand elle porte une
 * version.
 */

const SEARCH_DEBOUNCE_MS = 500;

/** La fiche d'un logiciel porte un tableau : plus large que celle d'une CVE. */
const SOFTWARE_SHEET_WIDTH = 560;

type Tab = 'vulns' | 'obsolescence' | 'inventory' | 'latest' | 'favorites';

const counted = (label: string, n: number | null | undefined): string => (n ? `${label} ${n}` : label);

interface SearchState {
    entries: CveEntry[];
    truncated: boolean;
    remote: boolean;
    remoteError: string | null;
    scope: SearchScope;
    loading: boolean;
    error: ErrorNoteInput | null;
}

const NO_SEARCH: SearchState = {
    entries: [],
    truncated: false,
    remote: false,
    remoteError: null,
    scope: { kind: 'keyword' },
    loading: false,
    error: null
};

interface SoftwareFound {
    matches: { software: Software; releases: string[] }[];
    version: string | null;
    more: number;
}

const NO_SOFTWARE: SoftwareFound = { matches: [], version: null, more: 0 };

export default function Cve(_props: FeatureViewProps) {
    const [tab, setTab] = useState<Tab>('vulns');
    /** La fiche d'un constat ou d'un élément est ouverte : sous 1000 px, elle prend la page. */
    const [exposureDetail, setExposureDetail] = useState(false);
    const [severity, setSeverity] = useState<CveSeverityFilter>('all');
    const [query, setQuery] = useState('');
    const [search, setSearch] = useState<SearchState>(NO_SEARCH);
    const [favorites, setFavorites] = useState<CveEntry[]>([]);
    const [favoritesLoading, setFavoritesLoading] = useState(true);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [softwareFound, setSoftwareFound] = useState<SoftwareFound>(NO_SOFTWARE);
    /** Le logiciel ouvert, par son nom : une seule fiche à la fois, CVE ou logiciel. */
    const [openSoftware, setOpenSoftware] = useState<string | null>(null);
    /** Une CVE ouverte qu'aucune liste ne porte : une téléportation, ou un résultat effacé depuis. */
    const [fetched, setFetched] = useState<CveEntry | null>(null);
    const [error, setError] = useState<ErrorNoteInput | null>(null);

    const news = useCveNews();
    const canWrite = useWorkspacePermissions().canFeature('cve', 'write');
    const searching = query.trim().length > 0;
    const catalogue = searching || tab === 'latest' || tab === 'favorites';

    const counts = useResource(
        'cve.exposureCount',
        () => api.send('cve.exposureCount', {}),
        'Le décompte n’a pas pu être lu.'
    ).data;
    const tabs = useMemo(
        () => [
            { value: 'vulns' as const, label: counted('Failles', counts?.count) },
            {
                value: 'obsolescence' as const,
                label: counted('Obsolescence', counts && counts.eol + counts.deprecated + counts.outdated)
            },
            { value: 'inventory' as const, label: 'Inventaire' },
            { value: 'latest' as const, label: 'Dernières CVE' },
            { value: 'favorites' as const, label: 'Épinglées' }
        ],
        [counts]
    );

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

    // Le catalogue des fins de vie est en base : la réponse arrive avant celle des
    // CVE, qui peut attendre le NVD, et s'affiche sans elle.
    useEffect(() => {
        const needle = query.trim();
        if (needle.length === 0) {
            setSoftwareFound(NO_SOFTWARE);
            setOpenSoftware(null);
            return;
        }
        let cancelled = false;
        const timer = setTimeout(() => {
            void (async () => {
                try {
                    const res = await api.send('cve.softwareSearch', { query: needle });
                    if (!cancelled) setSoftwareFound(res);
                } catch {
                    // Les CVE répondent à côté : un catalogue muet ne fait que taire cette partie.
                    if (!cancelled) setSoftwareFound(NO_SOFTWARE);
                }
            })();
        }, SEARCH_DEBOUNCE_MS);
        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [query]);
    const software = searching ? (softwareFound.matches.find((m) => m.software.name === openSoftware) ?? null) : null;

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
    useSubView(selected ? 'entry' : software ? 'software' : null);
    useEffect(() => {
        if (!liveTarget) return;
        setSelectedId(liveTarget.value);
        setTab((t) => (t === 'favorites' ? t : 'latest'));
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
        <div
            className={`${styles.root} ${(catalogue ? selected !== null || software !== null : exposureDetail) ? styles.hasDetail : ''}`}
        >
            <StickyHeader className={styles.headBand}>
                <header className={styles.headRow}>
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
                            placeholder='CVE-2021-44228, log4j, node 18…'
                            aria-label='Chercher une vulnérabilité ou un logiciel'
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
                </header>
            </StickyHeader>

            <div className={styles.listTools}>
                <div className={styles.filters}>
                    {searching ? (
                        <button type='button' className={styles.clearSearch} onClick={() => setQuery('')}>
                            <span className={`icon icon-x ${styles.clearIcon}`} aria-hidden='true' />
                            Résultats pour « {query.trim()} »
                        </button>
                    ) : (
                        <div className={styles.tabsScroll}>
                            <SegmentedControl
                                options={tabs}
                                value={tab}
                                onChange={setTab}
                                aria-label='Ce que la liste montre'
                            />
                        </div>
                    )}
                    {catalogue && (
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
                    )}
                </div>

                {catalogue && (
                    <p className={styles.status}>
                        {statusLine({ searching, search, news, loading, count: shown.length })}
                    </p>
                )}
            </div>

            {!catalogue && tab === 'vulns' && <VulnView canWrite={canWrite} onDetailChange={setExposureDetail} />}
            {!catalogue && tab === 'obsolescence' && (
                <ObsolescenceView canWrite={canWrite} onDetailChange={setExposureDetail} />
            )}
            {!catalogue && tab === 'inventory' && (
                <InventoryView canWrite={canWrite} onDetailChange={setExposureDetail} />
            )}

            {catalogue && <ErrorNote note={banner} />}

            {catalogue && (
                <div className={styles.split}>
                    <div className={styles.listPane}>
                        <div className={styles.sections}>
                            {searching && softwareFound.matches.length > 0 && (
                                <section className={styles.section}>
                                    <h3 className={styles.sectionTitle}>Logiciels</h3>
                                    <ul className={styles.list}>
                                        {softwareFound.matches.map((m) => (
                                            <SoftwareRow
                                                key={m.software.name}
                                                software={m.software}
                                                releases={m.releases}
                                                version={softwareFound.version}
                                                selected={m.software.name === openSoftware}
                                                onOpen={() => {
                                                    setSelectedId(null);
                                                    setOpenSoftware((cur) =>
                                                        cur === m.software.name ? null : m.software.name
                                                    );
                                                }}
                                            />
                                        ))}
                                    </ul>
                                    {softwareFound.more > 0 && (
                                        <p className={styles.detailMore}>
                                            Et {softwareFound.more} autre{softwareFound.more > 1 ? 's' : ''} : précisez
                                            le nom.
                                        </p>
                                    )}
                                </section>
                            )}
                            <section className={styles.section}>
                                {searching && softwareFound.matches.length > 0 && (
                                    <h3 className={styles.sectionTitle}>
                                        {search.scope.kind === 'version' && search.scope.exact
                                            ? `Failles de ${search.scope.product} ${search.scope.version}`
                                            : 'Vulnérabilités'}
                                    </h3>
                                )}
                                {shown.length === 0 && loading && softwareFound.matches.length > 0 ? (
                                    <p className={styles.detailMore}>Recherche en cours…</p>
                                ) : shown.length === 0 && !loading ? (
                                    <p className={styles.empty}>
                                        {searching
                                            ? searchEmptyLine(search.scope, softwareFound)
                                            : emptyLine(tab, severity, news.ingestedAt)}
                                    </p>
                                ) : (
                                    <ul className={styles.list}>
                                        {shown.map((entry) => (
                                            <CveRow
                                                key={entry.id}
                                                entry={entry}
                                                selected={entry.id === selectedId}
                                                canWrite={canWrite}
                                                onOpen={(e) => {
                                                    setOpenSoftware(null);
                                                    setSelectedId((cur) => (cur === e.id ? null : e.id));
                                                }}
                                                onToggleFavorite={(e) => void toggleFavorite(e)}
                                            />
                                        ))}
                                    </ul>
                                )}
                            </section>
                        </div>
                    </div>

                    <DetailPane
                        open={selected !== null || software !== null}
                        width={software ? SOFTWARE_SHEET_WIDTH : undefined}
                    >
                        {selected && (
                            <CveDetail
                                entry={selected}
                                canWrite={canWrite}
                                onToggleFavorite={(e) => void toggleFavorite(e)}
                                onClose={() => setSelectedId(null)}
                            />
                        )}
                        {!selected && software && (
                            <SoftwareSheet
                                software={software.software}
                                releases={software.releases}
                                onClose={() => setOpenSoftware(null)}
                            />
                        )}
                    </DetailPane>
                </div>
            )}
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
    if (searching && search.scope.kind === 'version') {
        const { product, version, exact, stale } = search.scope;
        if (!exact) return `Les failles se comparent à une version exacte de ${product}, pas à une branche.`;
        const found =
            count === 0
                ? `Aucune faille connue ne touche ${product} ${version}`
                : `${count} faille${count > 1 ? 's' : ''} connue${count > 1 ? 's touchent' : ' touche'} ${product} ${version}`;
        return `${found}, d’après le catalogue local.${stale ? ` ${stale} La liste peut être incomplète.` : ''}`;
    }
    if (searching) {
        const scope = search.remoteError
            ? `catalogue local seulement (le NVD n’a pas répondu : ${search.remoteError})`
            : search.remote
              ? 'catalogue local et NVD'
              : 'catalogue local';
        return `${count} vulnérabilité${count > 1 ? 's' : ''}${search.truncated ? ' ou plus' : ''}, ${scope}.`;
    }
    if (news.ingestedAt === null) return 'Le catalogue se remplit au premier tour d’ingestion.';
    return `Catalogue à jour au ${new Date(news.ingestedAt * 1000).toLocaleString('fr-FR', {
        day: 'numeric',
        month: 'long',
        hour: '2-digit',
        minute: '2-digit'
    })}.`;
}

/** Une recherche sans CVE : rien ne correspond, ou la version demandée n'est qu'une branche. */
function searchEmptyLine(scope: SearchScope, found: SoftwareFound): string {
    if (scope.kind === 'keyword') return 'Aucune vulnérabilité ne correspond.';
    if (scope.exact) return `Aucune faille connue ne touche ${scope.product} ${scope.version}.`;
    const [first] = found.matches;
    const latest = first?.software.releases.find((r) => r.name === first.releases[0])?.latest ?? null;
    return `Précisez la version exacte pour voir ses failles${latest ? `, par exemple ${latest}` : ''}.`;
}

function emptyLine(tab: Tab, severity: CveSeverityFilter, ingestedAt: number | null): string {
    if (tab === 'favorites') return 'Rien d’épinglé dans cet espace. L’étoile d’une CVE la range ici.';
    // Un fil vide avant le premier tour n'est pas une absence : le dire, sinon
    // la vue accuse le filtre de ce que l'ingestion n'a pas encore fait.
    if (ingestedAt === null) return 'Le catalogue se remplit. Le fil s’affichera dès le premier tour d’ingestion.';
    if (severity !== 'all') return 'Aucune vulnérabilité de cette gravité dans le fil.';
    return 'Le fil est vide.';
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence } from 'framer-motion';
import {
    detectTarget,
    OSINT_KIND_LABELS,
    OSINT_PROBES_BY_KIND,
    OSINT_SLOW_PROBES,
    type OsintHistoryEntry,
    type OsintProbeId,
    type OsintTarget
} from '../contracts/domain';

import {
    ConfirmDialog,
    ensureSecrecyUnlocked,
    FeatureSettingsButton,
    humanizeError,
    invalidate,
    useResourceVersion,
    useSecrecy,
    withSecrecy,
    type ConfirmRequest
} from 'deveye-sdk-client';

import { api } from './api';
import { ProbeCard, type ProbeCardState } from './ProbeCard';
import { HistoryPanel } from './HistoryPanel';
import styles from './Osint.module.css';

/**
 * Un champ, et des cartes. `osint.lookup` rend la liste des sondes sans rien
 * sonder ; une carte squelette apparaît par sonde, et un `osint.probe` part par
 * carte, en parallèle. Chacune se remplit dès que sa réponse arrive.
 */

/** Les lentes en fin de grille : les réponses immédiates occupent le haut. */
function orderProbes(probes: readonly OsintProbeId[]): OsintProbeId[] {
    return [...probes].sort((a, b) => {
        const sa = OSINT_SLOW_PROBES.includes(a) ? 1 : 0;
        const sb = OSINT_SLOW_PROBES.includes(b) ? 1 : 0;
        return sa - sb;
    });
}

interface RunState {
    target: OsintTarget;
    probes: OsintProbeId[];
    cards: Record<string, ProbeCardState>;
}

export default function Osint(): React.ReactElement {
    const [query, setQuery] = useState('');
    const [run, setRun] = useState<RunState | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [historyOpen, setHistoryOpen] = useState(false);
    const [history, setHistory] = useState<OsintHistoryEntry[]>([]);
    /** L'action destructive en attente de confirmation, ou `null`. */
    const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const historyVersion = useResourceVersion('osint.history');

    /**
     * Le verrou de la session, depuis le store partagé : où que le mot de passe
     * ait été saisi, l'historique se relit tout seul.
     */
    const { unlocked, enabled } = useSecrecy();
    const wasUnlocked = useRef(unlocked);

    /** Identifie la recherche en cours : une réponse en retard d'une recherche
     *  abandonnée ne doit pas venir remplir les cartes de la suivante. */
    const runIdRef = useRef(0);

    // La nature se calcule à la frappe, sans aller-retour : c'est la même
    // fonction pure que le serveur ré-appliquera.
    const preview = useMemo(() => (query.trim() ? detectTarget(query) : null), [query]);

    /** Des entrées existent mais restent illisibles faute de coffre ouvert. */
    const historyLocked = enabled && !unlocked && history.some((h) => h.query === null);

    useEffect(() => {
        inputRef.current?.focus();
    }, []);

    /**
     * Sans `withSecrecy`, délibérément : ouvrir l'écran ne doit pas déclencher
     * une invite. Les entrées que le coffre ne peut pas ouvrir reviennent avec
     * `query: null`, et le déverrouillage reste un geste explicite.
     */
    const loadHistory = useCallback(async () => {
        try {
            const res = await api.send('osint.history', { limit: 30 });
            setHistory(res.entries);
        } catch {
            // L'historique est un confort : son échec ne doit pas masquer l'écran.
            setHistory([]);
        }
    }, []);

    useEffect(() => {
        void loadHistory();
    }, [loadHistory, historyVersion]);

    // Le mot de passe vient d'être saisi quelque part dans l'application : les
    // entrées jusqu'ici chiffrées deviennent lisibles, on les relit.
    useEffect(() => {
        if (unlocked === wasUnlocked.current) return;
        wasUnlocked.current = unlocked;
        void loadHistory();
    }, [unlocked, loadHistory]);

    const probeOne = useCallback((runId: number, target: OsintTarget, probe: OsintProbeId) => {
        setRun((prev) => (prev ? { ...prev, cards: { ...prev.cards, [probe]: { kind: 'pending' } } } : prev));

        api.send('osint.probe', { probe, target }, { timeoutMs: 30_000 })
            .then((res) => {
                if (runIdRef.current !== runId) return;
                setRun((prev) =>
                    prev ? { ...prev, cards: { ...prev.cards, [probe]: { kind: 'done', result: res.result } } } : prev
                );
            })
            .catch((e) => {
                if (runIdRef.current !== runId) return;
                setRun((prev) =>
                    prev
                        ? {
                              ...prev,
                              cards: {
                                  ...prev.cards,
                                  [probe]: { kind: 'failed', message: humanizeError(e, 'Sonde en échec.') }
                              }
                          }
                        : prev
                );
            });
    }, []);

    /** Monte la grille pour une cible et lance toutes ses sondes en parallèle. */
    const runProbes = useCallback(
        (runId: number, target: OsintTarget, probes: OsintProbeId[]) => {
            setRun({
                target,
                probes,
                cards: Object.fromEntries(probes.map((p) => [p, { kind: 'pending' } as ProbeCardState]))
            });
            for (const probe of probes) probeOne(runId, target, probe);
        },
        [probeOne]
    );

    /**
     * Une **nouvelle** recherche : elle passe par `osint.lookup`, donc elle est
     * enregistrée dans l'historique.
     */
    const search = useCallback(
        async (raw: string) => {
            const trimmed = raw.trim();
            if (!trimmed || busy) return;

            setBusy(true);
            setError(null);
            const runId = ++runIdRef.current;

            try {
                const res = await withSecrecy(() => api.send('osint.lookup', { query: trimmed }));
                if (runIdRef.current !== runId) return;

                runProbes(runId, res.target, orderProbes(res.probes));
                // L'historique vient de gagner une entrée : la carte d'accueil et
                // le panneau doivent la voir sans attendre l'aller-retour.
                invalidate('osint.history');
            } catch (e) {
                if (runIdRef.current !== runId) return;
                setError(humanizeError(e, "La recherche n'a pas abouti."));
                setRun(null);
            } finally {
                if (runIdRef.current === runId) setBusy(false);
            }
        },
        [busy, runProbes]
    );

    /**
     * Rejoue une entrée sans créer de doublon : aucun `osint.lookup` (c'est lui
     * qui enregistre). Cible et sondes sont redérivées localement par les mêmes
     * fonctions que le serveur.
     */
    const replay = useCallback(
        (entry: OsintHistoryEntry) => {
            if (!entry.query) return;
            const target = detectTarget(entry.query);
            setQuery(entry.query);
            setError(null);
            setHistoryOpen(false);
            runProbes(++runIdRef.current, target, orderProbes(OSINT_PROBES_BY_KIND[target.kind]));
        },
        [runProbes]
    );

    const pivot = useCallback(
        (next: string) => {
            setQuery(next);
            void search(next);
        },
        [search]
    );

    const retry = useCallback(
        (probe: OsintProbeId) => {
            if (!run) return;
            probeOne(runIdRef.current, run.target, probe);
        },
        [run, probeOne]
    );

    const clearHistory = useCallback(async () => {
        try {
            await api.send('osint.historyClear', {});
            invalidate('osint.history');
        } catch (e) {
            setError(humanizeError(e, "L'historique n'a pas pu être effacé."));
        }
    }, []);

    const removeEntry = useCallback(async (id: string) => {
        try {
            await api.send('osint.historyRemove', { id });
            invalidate('osint.history');
        } catch (e) {
            setError(humanizeError(e, "L'entrée n'a pas pu être supprimée."));
        }
    }, []);

    /** Irréversibles et silencieuses une fois faites : confirmation obligatoire. */
    const askClearHistory = useCallback(() => {
        setConfirm({
            title: 'Effacer tout l’historique ?',
            description: `${history.length} recherche(s) seront définitivement supprimées de cet espace. Les résultats déjà affichés restent à l’écran.`,
            confirmLabel: 'Tout effacer',
            onConfirm: () => void clearHistory()
        });
    }, [history.length, clearHistory]);

    const askRemoveEntry = useCallback(
        (id: string) => {
            const entry = history.find((h) => h.id === id);
            setConfirm({
                title: 'Supprimer cette recherche ?',
                // Une entrée encore chiffrée n'a pas de libellé à montrer : on ne
                // prétend pas savoir ce qu'on efface.
                description: entry?.query
                    ? `« ${entry.query} » sera retirée de l’historique. Cette action est irréversible.`
                    : 'Cette entrée sera retirée de l’historique. Cette action est irréversible.',
                confirmLabel: 'Supprimer',
                onConfirm: () => void removeEntry(id)
            });
        },
        [history, removeEntry]
    );

    /** Déverrouillage explicite, demandé depuis le panneau. Le store étant
     *  global, l'effet ci-dessus relira l'historique de lui-même. */
    const unlockHistory = useCallback(async () => {
        try {
            await ensureSecrecyUnlocked();
        } catch {
            // Invite annulée : rien à faire, les entrées restent masquées.
        }
    }, []);

    return (
        <div className={styles.root}>
            <form
                className={styles.searchBar}
                onSubmit={(e) => {
                    e.preventDefault();
                    void search(query);
                }}
            >
                <span className={`icon icon-search ${styles.searchIcon}`} aria-hidden />
                <input
                    ref={inputRef}
                    className={styles.searchInput}
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder='Domaine, IP, e-mail, numéro, nom, pseudo…'
                    spellCheck={false}
                    autoComplete='off'
                    aria-label='Cible à rechercher'
                />
                {preview && <span className={styles.kindChip}>{OSINT_KIND_LABELS[preview.kind]}</span>}
                <button type='submit' className={styles.searchGo} disabled={busy || !query.trim()}>
                    {busy ? 'Analyse…' : 'Analyser'}
                </button>
                <button
                    type='button'
                    className={styles.iconButton}
                    title='Historique des recherches'
                    aria-expanded={historyOpen}
                    onClick={() => setHistoryOpen(true)}
                >
                    <span className='icon icon-clock' aria-hidden />
                    {historyLocked && <span className={styles.iconBadge} aria-hidden />}
                </button>
                <FeatureSettingsButton scope={{ kind: 'feature', feature: 'osint' }} />
            </form>

            <HistoryPanel
                open={historyOpen}
                onClose={() => setHistoryOpen(false)}
                entries={history}
                kindLabels={OSINT_KIND_LABELS}
                onReplay={replay}
                onRemove={askRemoveEntry}
                onClear={askClearHistory}
                locked={historyLocked}
                onUnlock={() => void unlockHistory()}
            />

            <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />

            {error && <p className={styles.banner}>{error}</p>}

            <main className={styles.results}>
                {!run && !busy && (
                    <div className={styles.empty}>
                        <p className={styles.emptyTitle}>Une cible, toutes les sondes.</p>
                        <p className={styles.emptyHint}>
                            Collez n’importe quoi : DevEye reconnaît la nature de la cible et lance les vérifications
                            qui s’y appliquent. Aucune clé n’est nécessaire.
                        </p>
                        <div className={styles.examples}>
                            {['github.com', '8.8.8.8', '+33612345678', 'contact@github.com'].map((ex) => (
                                <button key={ex} type='button' className={styles.chip} onClick={() => pivot(ex)}>
                                    {ex}
                                </button>
                            ))}
                        </div>
                    </div>
                )}

                {run && (
                    <>
                        <div className={styles.targetLine}>
                            <span className={styles.kindChip}>{OSINT_KIND_LABELS[run.target.kind]}</span>
                            <span className={styles.targetValue}>{run.target.value}</span>
                        </div>
                        <div className={styles.grid}>
                            <AnimatePresence>
                                {run.probes.map((probe) => (
                                    <ProbeCard
                                        key={probe}
                                        probe={probe}
                                        state={run.cards[probe] ?? { kind: 'pending' }}
                                        onRetry={() => retry(probe)}
                                        onPivot={pivot}
                                    />
                                ))}
                            </AnimatePresence>
                        </div>
                    </>
                )}
            </main>
        </div>
    );
}

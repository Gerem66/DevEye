import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence } from 'framer-motion';
import {
    detectTarget,
    OSINT_PROBES_BY_KIND,
    OSINT_SLOW_PROBES,
    type OsintHistoryEntry,
    type OsintProbeId,
    type OsintTarget,
    type OsintTargetKind
} from 'deveye-types';

import { ws } from '@/api/ws';
import { invalidate, useResourceVersion } from '@/stores/invalidation';
import { ensureUnlocked as ensureSecrecyUnlocked, useSecrecy } from '@/stores/secrecy';

import { humanizeError, withSecrecy } from './api';
import { ProbeCard, type ProbeCardState } from './ProbeCard';
import { OsintSettings } from './OsintSettings';
import { HistoryPanel } from './HistoryPanel';
import { ConfirmDialog, type ConfirmRequest } from './ConfirmDialog';
import styles from './Osint.module.css';

/**
 * OSINT — un champ, et des cartes.
 *
 * ## Le déroulé
 *
 * 1. `osint.lookup` reconnaît la cible et rend la **liste** des sondes. C'est
 *    instantané : il ne sonde rien.
 * 2. Une carte squelette apparaît par sonde, aussitôt.
 * 3. Un `osint.probe` part **par carte**, toutes en parallèle. Chacune se
 *    remplit dès que sa réponse arrive.
 *
 * Attendre le tout dans une seule commande aurait laissé l'écran vide pendant la
 * plus lente des sondes (crt.sh, ~3 s). Là, le DNS et les pivots sont là en
 * 100 ms, et le reste se pose derrière.
 */

const KIND_LABELS: Record<OsintTargetKind, string> = {
    domain: 'Domaine',
    url: 'URL',
    ip: 'Adresse IP',
    email: 'Adresse e-mail',
    phone: 'Téléphone',
    person: 'Personne',
    username: 'Pseudo'
};

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
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [historyOpen, setHistoryOpen] = useState(false);
    const [history, setHistory] = useState<OsintHistoryEntry[]>([]);
    /** L'action destructive en attente de confirmation, ou `null`. */
    const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const historyVersion = useResourceVersion('osint.history');

    /**
     * L'état de verrou de la session, depuis le store que le widget de la
     * topbar, l'invite de mot de passe et toutes les features partagent.
     *
     * C'est la seule source de vérité : peu importe *où* le mot de passe a été
     * saisi — la pastille de la barre, une autre feature, l'invite déclenchée
     * par un déverrouillage explicite — l'historique se relit tout seul.
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
     * Charge l'historique **sans jamais réclamer le mot de passe**.
     *
     * Volontairement sans `withSecrecy` : ouvrir l'écran OSINT ne doit pas
     * déclencher une invite. Les entrées que le coffre ne peut pas ouvrir
     * reviennent avec `query: null`, le panneau les montre comme chiffrées, et
     * le déverrouillage reste un geste explicite.
     */
    const loadHistory = useCallback(async () => {
        try {
            const res = await ws.send('osint.history', { limit: 30 });
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

        ws.send('osint.probe', { probe, target }, { timeoutMs: 30_000 })
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
                const res = await withSecrecy(() => ws.send('osint.lookup', { query: trimmed }));
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
     * Rejoue une entrée d'historique : **réaffiche** ses résultats sans créer de
     * doublon.
     *
     * Aucun `osint.lookup` n'est émis — c'est lui qui enregistre. La cible est
     * redérivée localement par la fonction partagée `detectTarget`, et la liste
     * des sondes lue dans la table partagée : le serveur aurait rendu exactement
     * les mêmes. Les cartes se remplissent alors depuis son cache mémoire, donc
     * instantanément tant que l'entrée est fraîche.
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
            await ws.send('osint.historyClear', {});
            invalidate('osint.history');
        } catch (e) {
            setError(humanizeError(e, "L'historique n'a pas pu être effacé."));
        }
    }, []);

    const removeEntry = useCallback(async (id: string) => {
        try {
            await ws.send('osint.historyRemove', { id });
            invalidate('osint.history');
        } catch (e) {
            setError(humanizeError(e, "L'entrée n'a pas pu être supprimée."));
        }
    }, []);

    /**
     * Les deux suppressions sont irréversibles et **silencieuses** une fois
     * faites : rien ne se rejoue, et une recherche effacée est perdue. Elles
     * passent donc par une confirmation, comme la suppression d'un appareil.
     */
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
                {preview && <span className={styles.kindChip}>{KIND_LABELS[preview.kind]}</span>}
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
                <button
                    type='button'
                    className={styles.iconButton}
                    title='Clés des fournisseurs'
                    onClick={() => setSettingsOpen(true)}
                >
                    <span className='icon icon-key' aria-hidden />
                </button>
            </form>

            <OsintSettings open={settingsOpen} onClose={() => setSettingsOpen(false)} />

            <HistoryPanel
                open={historyOpen}
                onClose={() => setHistoryOpen(false)}
                entries={history}
                kindLabels={KIND_LABELS}
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
                            <span className={styles.kindChip}>{KIND_LABELS[run.target.kind]}</span>
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

export { OsintWidget } from './OsintWidget';

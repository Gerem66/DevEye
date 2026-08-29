import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { MinimalUser } from '@deveye/types';
import { humanizeError, invalidate, useResourceVersion } from 'deveye-sdk-client';
import type {
    GitBranch,
    GitCommit,
    GitCommitAuthor,
    GitCommitPoints,
    GitPullRequest,
    GitRelease,
    GitRepo,
    GitSyncStatus
} from '../contracts/domain';

import { api } from './api';
import { setGitPrefs, useGitPrefs } from './prefs';
import { CommitGraph } from './CommitGraph';
import { CommitDialog } from './CommitDialog';
import { PullRequestDialog } from './PullRequestDialog';
import { AuthorMapDialog } from './AuthorMapDialog';
import { CommitListDialog, ListDialog } from './ListDialog';
import { BranchRow, CommitRow, PANEL_LIMIT, PANEL_LIMIT_TALL, PullRow, ReleaseRow } from './Rows';
import styles from './style.module.css';

/** Cadence de sondage de l'avancement pendant une synchronisation. */
const POLL_MS = 700;

/**
 * Combien de temps on attend qu'une synchronisation démarre avant de renoncer à
 * l'afficher. La commande rend la main dès qu'elle a réveillé l'ordonnanceur, qui
 * n'a pas encore inscrit d'étape quand le premier sondage arrive : sans ce délai,
 * le sondage lirait « rien en cours » et s'arrêterait avant le démarrage.
 */
const START_GRACE_MS = 12_000;

/** Quel panneau a demandé son « voir tout ». */
type OpenList = 'branches' | 'releases' | 'pulls' | 'commits' | null;

interface GraphState {
    points: GitCommitPoints;
    authors: GitCommitAuthor[];
    firstCommitAt: number | null;
    lastCommitAt: number | null;
    total: number;
}

interface RepoViewProps {
    repo: GitRepo;
    members: readonly MinimalUser[];
    canWrite: boolean;
    /**
     * Une synchronisation est-elle en cours ? L'en-tête vit chez l'appelant, mais
     * c'est cette vue qui sonde : on le lui remonte plutôt que de dupliquer le
     * sondage, sans quoi ses boutons resteraient cliquables sous le voile.
     */
    onSyncingChange?: (syncing: boolean) => void;
    /**
     * Compteur que l'appelant incrémente après avoir demandé une synchronisation :
     * lui seul porte le bouton. Sans ce signal, le voile ne se poserait que sur un
     * dépôt jamais synchronisé, alors qu'un tour peut durer plusieurs minutes.
     */
    syncRequest?: number;
    /** Rendu entre l'en-tête et le contenu (les projets liés, par exemple). */
    children?: ReactNode;
}

/**
 * Le contenu d'un dépôt : graphe des commits, branches, releases, pull requests
 * et derniers commits. Partagé entre la feature Git et l'onglet Git d'un projet,
 * qui montrent la même chose du même dépôt.
 *
 * Tout vient du cache local alimenté par le service de fond : l'ouverture est
 * instantanée et ne consomme aucun quota, et « Synchroniser » ne fait que
 * réveiller l'ordonnanceur. Seule exception, le diff d'un commit, lu chez GitHub
 * à l'ouverture parce qu'il ne se met pas en cache.
 */
export function RepoView({ repo, members, canWrite, onSyncingChange, syncRequest = 0, children }: RepoViewProps) {
    const [graph, setGraph] = useState<GraphState | null>(null);
    const [branches, setBranches] = useState<GitBranch[]>([]);
    const [releases, setReleases] = useState<GitRelease[]>([]);
    const [commits, setCommits] = useState<GitCommit[]>([]);
    const [pulls, setPulls] = useState<GitPullRequest[]>([]);
    const [loaded, setLoaded] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [sync, setSync] = useState<GitSyncStatus | null>(null);
    const [openSha, setOpenSha] = useState<string | null>(null);
    const [openPull, setOpenPull] = useState<GitPullRequest | null>(null);
    const [openList, setOpenList] = useState<OpenList>(null);
    const [authorMapOpen, setAuthorMapOpen] = useState(false);

    const version = useResourceVersion('git.repo');
    const repoId = repo.id;
    const prefs = useGitPrefs();

    const load = useCallback(async () => {
        try {
            const [g, b, r, c, p] = await Promise.all([
                api.send('git.commitGraph', { repoId }),
                api.send('git.branchList', { repoId }),
                api.send('git.releaseList', { repoId }),
                api.send('git.commitList', { repoId, limit: PANEL_LIMIT_TALL }),
                api.send('git.pullRequestList', { repoId })
            ]);
            setGraph(g);
            setBranches(b.branches);
            setReleases(r.releases);
            setCommits(c.commits);
            setPulls(p.pullRequests);
            setError(null);
        } catch (e) {
            setError(humanizeError(e, 'Impossible de charger ce dépôt.'));
        } finally {
            setLoaded(true);
        }
    }, [repoId]);

    useEffect(() => {
        void load();
    }, [load, version]);

    /**
     * La vue est-elle encore montée ? Quitter arrête le sondage, qu'une vue démontée
     * poursuivrait sinon jusqu'à la fin de la synchronisation.
     */
    const alive = useRef(true);
    useEffect(() => {
        alive.current = true;
        return () => {
            alive.current = false;
        };
    }, []);

    /**
     * Sonde l'avancement tant qu'une synchronisation tourne.
     *
     * Sondage plutôt que diffusion `live` : les six étapes d'un tour feraient sinon
     * re-solliciter tout l'écran six fois d'affilée chez tous les membres, pour une
     * information qui n'intéresse que celui qui a pressé le bouton. La fin, elle,
     * re-sollicite une fois.
     *
     * Aucune limite de durée : la relecture complète d'un gros dépôt dépasse tout
     * plafond qu'on se fixerait. Le serveur est seul juge du « c'est fini », il
     * retire l'entrée d'avancement dans un `finally`, échec compris.
     */
    const poll = useCallback(async () => {
        const startBy = Date.now() + START_GRACE_MS;
        /**
         * A-t-on réellement vu tourner quelque chose ? On ne re-sollicite que si le
         * service a pu écrire, sinon chaque ouverture d'un dépôt jamais synchronisé
         * invaliderait pour rien.
         */
        let sawRunning = false;

        for (;;) {
            if (!alive.current) return;
            let status: GitSyncStatus;
            try {
                const res = await api.send('git.repoSyncStatus', { repoId });
                status = res.status;
            } catch {
                // Une coupure ne doit pas laisser le voile en place : on rend la
                // main, la vue reviendra d'elle-même à la reconnexion.
                setSync(null);
                return;
            }

            if (status.running) {
                sawRunning = true;
                setSync(status);
            } else if (sawRunning || Date.now() > startBy) {
                // Soit c'est fini, soit elle n'aura jamais démarré.
                setSync(null);
                // Le service a écrit : c'est maintenant qu'il y a du neuf à lire.
                if (sawRunning) invalidate('git.repo', 'git.list');
                return;
            } else {
                // Demandée mais pas encore prise en charge : on l'annonce plutôt
                // que de laisser l'écran muet le temps que l'ordonnanceur parte.
                setSync({
                    running: true,
                    phase: 'Démarrage…',
                    step: 0,
                    stepCount: status.stepCount,
                    startedAt: null
                });
            }

            await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        }
    }, [repoId]);

    // Remonte l'état à l'en-tête, qui porte les boutons.
    useEffect(() => {
        onSyncingChange?.(sync !== null);
    }, [sync, onSyncingChange]);

    // Le démontage rend la main : une vue fermée en pleine synchronisation ne
    // doit pas laisser les boutons de l'appelant désactivés pour toujours.
    useEffect(() => () => onSyncingChange?.(false), [onSyncingChange]);

    // Une seule boucle de sondage à la fois, même si l'on presse deux fois.
    const polling = useRef<Promise<void> | null>(null);
    const startPolling = useCallback(() => {
        if (polling.current) return;
        polling.current = poll().finally(() => {
            polling.current = null;
        });
    }, [poll]);

    /**
     * Une synchronisation lancée ailleurs (l'ajout d'un dépôt, la liaison d'un
     * projet) pose son voile ici. Conditions cumulées : jamais synchronisé et en
     * état de l'être, un dépôt sans jeton ou suspendu n'attendant rien.
     */
    useEffect(() => {
        if (repo.lastSyncAt === null && repo.enabled && repo.credentialId !== null) startPolling();
    }, [repo.lastSyncAt, repo.enabled, repo.credentialId, startPolling]);

    /**
     * Une synchronisation vient d'être demandée depuis l'en-tête. `> 0` plutôt qu'un
     * simple changement de valeur : le compteur part de zéro, l'effet ne se
     * déclenche donc qu'après une vraie pression, jamais au montage.
     */
    useEffect(() => {
        if (syncRequest > 0) startPolling();
    }, [syncRequest, startPolling]);

    const mapAuthor = async (authorRef: string, userId: number | null) => {
        try {
            await api.send('git.authorMap', { repoId, authorRef, userId });
            invalidate('git.repo');
        } catch (e) {
            setError(humanizeError(e, 'Le rattachement a échoué.'));
        }
    };

    if (!loaded) return <p className={styles.empty}>Chargement…</p>;

    /**
     * Racine du dépôt chez le fournisseur, reconstruite : les URL ne sont stockées
     * que sur les objets (commit, release, PR), et un dépôt fraîchement ajouté n'en
     * a encore aucun.
     */
    const repoUrl = `https://github.com/${repo.owner}/${repo.repo}`;

    return (
        <>
            {error && <p className={styles.error}>{error}</p>}

            {/* Le voile couvre tout ce qui est en train d'être remplacé, et lui
                seul : l'en-tête reste net et cliquable. */}
            <div className={styles.gitContent}>
                <div className={`${styles.gitStack} ${sync ? styles.gitDimmed : ''}`}>
                    <CommitGraph
                        {...(graph ?? emptyGraph)}
                        members={members}
                        groupByMember={prefs.groupAuthorsByMember}
                        onOpenCommit={(sha) => setOpenSha(sha)}
                        // Pas de garde sur le droit d'écriture : le dialogue porte
                        // aussi un réglage d'affichage personnel. C'est le
                        // rattachement lui-même qui s'y désactive.
                        onConfigure={graph && graph.authors.length > 0 ? () => setAuthorMapOpen(true) : undefined}
                    />

                    {children}

                    <div className={styles.gitCols}>
                        <Panel
                            title='Branches'
                            count={branches.length}
                            href={`${repoUrl}/branches`}
                            onSeeAll={() => setOpenList('branches')}
                            hasMore={branches.length > PANEL_LIMIT}
                        >
                            {branches.length === 0 && <p className={styles.empty}>Aucune branche.</p>}
                            <ul className={styles.gitList}>
                                {branches.slice(0, PANEL_LIMIT).map((b) => (
                                    <BranchRow key={b.id} branch={b} onOpenCommit={(sha) => setOpenSha(sha)} />
                                ))}
                            </ul>
                        </Panel>

                        <Panel
                            title='Releases'
                            count={releases.length}
                            href={`${repoUrl}/releases`}
                            onSeeAll={() => setOpenList('releases')}
                            hasMore={releases.length > PANEL_LIMIT}
                        >
                            {releases.length === 0 && <p className={styles.empty}>Aucune release.</p>}
                            <ul className={styles.gitList}>
                                {releases.slice(0, PANEL_LIMIT).map((r) => (
                                    <ReleaseRow key={r.id} release={r} />
                                ))}
                            </ul>
                        </Panel>

                        <Panel
                            title='Pull requests'
                            count={pulls.length}
                            href={`${repoUrl}/pulls`}
                            onSeeAll={() => setOpenList('pulls')}
                            hasMore={pulls.length > PANEL_LIMIT_TALL}
                        >
                            {pulls.length === 0 && <p className={styles.empty}>Aucune pull request.</p>}
                            <ul className={styles.gitList}>
                                {pulls.slice(0, PANEL_LIMIT_TALL).map((p) => (
                                    <PullRow key={p.id} pull={p} onOpen={setOpenPull} />
                                ))}
                            </ul>
                        </Panel>

                        <Panel
                            title='Derniers commits'
                            count={graph?.total ?? commits.length}
                            href={`${repoUrl}/commits`}
                            onSeeAll={() => setOpenList('commits')}
                            // La liste est bornée côté serveur à `PANEL_LIMIT_TALL` :
                            // c'est le total du graphe qui dit s'il y en a plus.
                            hasMore={(graph?.total ?? 0) > commits.length}
                            wide
                        >
                            {commits.length === 0 && <p className={styles.empty}>Aucun commit.</p>}
                            <ul className={styles.gitList}>
                                {commits.map((c) => (
                                    <CommitRow key={c.id} commit={c} onOpen={(sha) => setOpenSha(sha)} />
                                ))}
                            </ul>
                        </Panel>
                    </div>
                </div>

                {sync && <SyncOverlay status={sync} />}
            </div>

            <CommitDialog open={openSha !== null} repoId={repoId} sha={openSha} onClose={() => setOpenSha(null)} />

            <PullRequestDialog open={openPull !== null} pull={openPull} onClose={() => setOpenPull(null)} />

            <AuthorMapDialog
                open={authorMapOpen}
                authors={graph?.authors ?? []}
                members={members}
                canWrite={canWrite}
                groupByMember={prefs.groupAuthorsByMember}
                onGroupByMemberChange={(v) => setGitPrefs({ groupAuthorsByMember: v })}
                onClose={() => setAuthorMapOpen(false)}
                onMap={(authorRef, userId) => void mapAuthor(authorRef, userId)}
            />

            <ListDialog open={openList === 'branches'} title='Toutes les branches' onClose={() => setOpenList(null)}>
                <ul className={styles.gitList}>
                    {branches.map((b) => (
                        <BranchRow
                            key={b.id}
                            branch={b}
                            onOpenCommit={(sha) => {
                                setOpenList(null);
                                setOpenSha(sha);
                            }}
                        />
                    ))}
                </ul>
            </ListDialog>

            <ListDialog open={openList === 'releases'} title='Toutes les releases' onClose={() => setOpenList(null)}>
                <ul className={styles.gitList}>
                    {releases.map((r) => (
                        <ReleaseRow key={r.id} release={r} />
                    ))}
                </ul>
            </ListDialog>

            <ListDialog open={openList === 'pulls'} title='Toutes les pull requests' onClose={() => setOpenList(null)}>
                <ul className={styles.gitList}>
                    {pulls.map((p) => (
                        <PullRow
                            key={p.id}
                            pull={p}
                            onOpen={(pull) => {
                                setOpenList(null);
                                setOpenPull(pull);
                            }}
                        />
                    ))}
                </ul>
            </ListDialog>

            <CommitListDialog
                open={openList === 'commits'}
                repoId={repoId}
                onClose={() => setOpenList(null)}
                onOpenCommit={(sha) => {
                    setOpenList(null);
                    setOpenSha(sha);
                }}
            />
        </>
    );
}

/** Un graphe vide : évite un `graph &&` qui ferait sauter la mise en page. */
const emptyGraph: GraphState = {
    points: { count: 0, shas: '', committedAt: [], authorIndex: [] },
    authors: [],
    firstCommitAt: null,
    lastCommitAt: null,
    total: 0
};

interface PanelProps {
    title: string;
    count: number;
    /** La page correspondante chez le fournisseur. */
    href: string;
    /** Ouvre la liste complète — depuis le titre comme depuis le pied. */
    onSeeAll: () => void;
    /** La liste est-elle tronquée ? Sinon, « Voir tout » n'aurait rien à montrer. */
    hasMore: boolean;
    /** Occupe toute la largeur de la grille (pour les listes longues). */
    wide?: boolean;
    children: ReactNode;
}

/**
 * Une carte autour d'une liste, avec deux sorties distinctes : le titre ouvre la
 * liste complète dans l'application, le geste courant, donc la grande cible ;
 * l'icône GitHub mène chez le fournisseur, le geste rare.
 */
function Panel({ title, count, href, onSeeAll, hasMore, wide, children }: PanelProps) {
    return (
        <section className={wide ? styles.panelWide : styles.panel}>
            <header className={styles.panelHead}>
                <button type='button' className={styles.panelTitle} onClick={onSeeAll} title='Voir tout'>
                    <h3 className={styles.gitTitle}>{title}</h3>
                </button>
                <span className={styles.panelCount}>{count}</span>
                <a
                    className={styles.panelGithub}
                    href={href}
                    target='_blank'
                    rel='noreferrer'
                    title='Ouvrir sur GitHub'
                    aria-label={`${title} sur GitHub`}
                >
                    <span className='icon icon-github' />
                </a>
            </header>
            {children}
            {hasMore && (
                <button type='button' className={styles.seeAll} onClick={onSeeAll}>
                    Voir tout
                </button>
            )}
        </section>
    );
}

/**
 * Le voile de chargement, avec l'étape en cours. La barre avance par étapes
 * nommées et non par objets traités (voir `gitSyncStatusSchema`) : c'est le seul
 * comptage dont on connaisse le total d'avance.
 *
 * Son panneau est collant : sur une page plus haute que la fenêtre, un `inset: 0`
 * centrerait le texte au milieu du contenu, donc hors écran.
 */
function SyncOverlay({ status }: { status: GitSyncStatus }) {
    const ratio = status.stepCount > 0 ? Math.min(1, status.step / status.stepCount) : 0;
    return (
        <div className={styles.syncOverlay}>
            <div className={styles.syncPanel}>
                <span className={`icon icon-spinner ${styles.spinning}`} />
                <span className={styles.syncPhase}>{status.phase ?? 'Synchronisation…'}</span>
                <div className={styles.syncBar}>
                    <div className={styles.syncBarFill} style={{ width: `${Math.round(ratio * 100)}%` }} />
                </div>
                <span className={styles.hint}>
                    Étape {Math.min(status.step + 1, status.stepCount)} sur {status.stepCount}
                </span>
            </div>
        </div>
    );
}

export default RepoView;

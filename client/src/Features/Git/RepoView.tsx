import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type {
    GitBranch,
    GitCommit,
    GitCommitAuthor,
    GitCommitPoints,
    GitPullRequest,
    GitRelease,
    GitRepo,
    GitSyncStatus,
    MinimalUser
} from 'deveye-types';
import { ws } from '@/api/ws';
import { invalidate, useResourceVersion } from '@/stores/invalidation';
import { humanizeError } from '../Projects/api';
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
 * Combien de temps on attend qu'une synchronisation **démarre** avant de
 * renoncer à l'afficher.
 *
 * Sans ce délai, le voile ne s'affichait pas du tout après un « Tout
 * resynchroniser » : la commande rend la main dès qu'elle a vidé le cache et
 * réveillé l'ordonnanceur, mais celui-ci n'a pas encore inscrit l'étape en cours
 * quand le premier sondage arrive. Le sondage lisait donc « rien en cours »,
 * concluait qu'il n'y avait rien à regarder, et s'arrêtait — alors que la
 * synchronisation démarrait une fraction de seconde plus tard. Revenir sur le
 * dépôt remontait la vue et retrouvait, lui, une synchronisation bien en cours.
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
    members: MinimalUser[];
    canWrite: boolean;
    /**
     * Une synchronisation est-elle en cours ?
     *
     * L'en-tête vit chez l'appelant (`RepoDetail`, l'onglet Git d'un projet),
     * mais c'est cette vue qui sonde l'avancement. On le lui remonte plutôt que
     * de dupliquer le sondage : sans ça, « Synchroniser » et « Modifier »
     * restaient cliquables pendant que le contenu était déjà voilé.
     */
    onSyncingChange?: (syncing: boolean) => void;
    /**
     * Compteur que l'appelant incrémente après avoir demandé une
     * synchronisation.
     *
     * L'en-tête portant le bouton vit chez lui, c'est donc lui qui sait qu'une
     * synchronisation vient d'être réclamée. Sans ce signal, le voile ne
     * s'affichait que sur un dépôt **jamais** synchronisé : presser
     * « Synchroniser » sur un dépôt déjà à jour ne montrait rien du tout, alors
     * que le tour peut durer plusieurs minutes.
     */
    syncRequest?: number;
    /** Rendu entre l'en-tête et le contenu (les projets liés, par exemple). */
    children?: ReactNode;
}

/**
 * Le contenu d'un dépôt : graphe des commits, branches, releases, pull requests
 * et derniers commits.
 *
 * **Partagé** entre la feature Git (`RepoDetail`) et l'onglet Git d'un projet.
 * C'est la raison d'être du composant : les deux montrent exactement la même
 * chose du même dépôt, et une seconde implémentation aurait divergé au premier
 * ajustement.
 *
 * Tout ce qui s'affiche ici vient du **cache local** alimenté par le service de
 * fond — l'ouverture est donc instantanée et ne consomme aucun quota.
 * « Synchroniser » ne fait que réveiller l'ordonnanceur ; c'est
 * `git.repoSyncStatus` qui dit ensuite où il en est.
 *
 * Une seule exception, délibérée : le diff d'un commit (`CommitDialog`) est lu
 * chez GitHub à l'ouverture, parce qu'un diff ne se met pas en cache.
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
                ws.send('git.commitGraph', { repoId }),
                ws.send('git.branchList', { repoId }),
                ws.send('git.releaseList', { repoId }),
                ws.send('git.commitList', { repoId, limit: PANEL_LIMIT_TALL }),
                ws.send('git.pullRequestList', { repoId })
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
     * La vue est-elle encore montée ?
     *
     * Quitter la vue arrête le sondage : sans ça, une vue démontée continuerait
     * d'interroger le serveur toutes les 700 ms jusqu'à la fin de la
     * synchronisation.
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
     * Sondage plutôt que diffusion `live` : les six étapes d'un tour feraient
     * sinon re-solliciter tout l'écran six fois d'affilée chez **tous** les
     * membres de l'espace, pour une information qui n'intéresse que celui qui a
     * pressé le bouton. La fin du sondage, elle, re-sollicite une fois — et
     * c'est bien la seule chose que les autres ont besoin de voir.
     *
     * **Aucune limite de durée.** Il y en avait une — trois minutes — et elle
     * était fausse : la relecture complète d'un dépôt de plusieurs milliers de
     * commits dure plus longtemps, et la barre disparaissait alors en plein
     * travail, pour ne revenir qu'en ressortant du dépôt et en y rentrant. Le
     * serveur reste la seule autorité sur « c'est fini » : il retire l'entrée
     * d'avancement dans un `finally`, échec compris, donc la boucle s'arrête
     * toujours — et jamais avant l'heure.
     */
    const poll = useCallback(async () => {
        const startBy = Date.now() + START_GRACE_MS;
        /**
         * A-t-on réellement vu tourner quelque chose ?
         *
         * Sans ce drapeau, un sondage qui ne trouve jamais rien re-solliciterait
         * quand même — une invalidation pour rien à chaque ouverture d'un dépôt
         * jamais synchronisé. On ne re-sollicite que si le service a pu écrire.
         */
        let sawRunning = false;

        for (;;) {
            if (!alive.current) return;
            let status: GitSyncStatus;
            try {
                const res = await ws.send('git.repoSyncStatus', { repoId });
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
     * Une synchronisation lancée ailleurs — l'ajout d'un dépôt, la liaison d'un
     * projet — pose son voile ici sans que l'appelant ait à l'orchestrer.
     *
     * Conditions cumulées : jamais synchronisé **et** en état de l'être. Un dépôt
     * sans jeton ou suspendu n'attend rien, et le sonder ne ferait qu'un
     * aller-retour inutile à chaque ouverture.
     */
    useEffect(() => {
        if (repo.lastSyncAt === null && repo.enabled && repo.credentialId !== null) startPolling();
    }, [repo.lastSyncAt, repo.enabled, repo.credentialId, startPolling]);

    /**
     * Une synchronisation vient d'être demandée depuis l'en-tête.
     *
     * `> 0` plutôt qu'un simple changement de valeur : le compteur part de zéro
     * et vit chez l'appelant, qui monte et démonte avec cette vue — l'effet ne
     * se déclenche donc qu'après une vraie pression, jamais au montage.
     */
    useEffect(() => {
        if (syncRequest > 0) startPolling();
    }, [syncRequest, startPolling]);

    const mapAuthor = async (authorRef: string, userId: number | null) => {
        try {
            await ws.send('git.authorMap', { repoId, authorRef, userId });
            invalidate('git.repo');
        } catch (e) {
            setError(humanizeError(e, 'Le rattachement a échoué.'));
        }
    };

    if (!loaded) return <p className={styles.empty}>Chargement…</p>;

    /**
     * Racine du dépôt chez le fournisseur.
     *
     * Reconstruite à partir de `owner`/`repo` plutôt que lue quelque part : les
     * URL ne sont stockées que sur les objets (commit, release, PR), jamais sur
     * le dépôt lui-même, et un dépôt fraîchement ajouté n'a encore aucun objet.
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
                        // Pas de garde sur le droit d'écriture : le dialogue
                        // porte aussi un réglage d'affichage personnel, qu'un
                        // membre en lecture seule doit pouvoir atteindre. C'est
                        // le rattachement lui-même qui s'y désactive.
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
 * Une carte autour d'une liste.
 *
 * Deux sorties, et elles ne mènent pas au même endroit — c'est tout l'intérêt
 * de les avoir séparées :
 *
 * - le **titre** ouvre la liste complète *dans DevEye*. C'est le geste courant,
 *   il mérite la grande cible ;
 * - la **petite icône GitHub**, à droite des compteurs, mène chez le
 *   fournisseur. C'est le geste rare, il mérite une cible discrète.
 *
 * Auparavant le titre faisait la seconde chose, ce qui obligeait à quitter
 * l'application pour voir la seizième branche.
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
 * Le voile de chargement, avec l'étape en cours.
 *
 * La barre avance par **étapes nommées** et non par objets traités : voir
 * `gitSyncStatusSchema`. C'est le seul comptage dont on connaisse le total
 * d'avance, donc le seul qui ne mente pas.
 *
 * Le voile couvre toute la boîte, mais son panneau est **collant** : sur une
 * page plus haute que la fenêtre, un simple `inset: 0` centrait le texte au
 * milieu du contenu — c'est-à-dire hors écran. Voir `.syncPanel`.
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

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type {
    MinimalUser,
    Project,
    ProjectBranch,
    ProjectCommit,
    ProjectCommitAuthor,
    ProjectCommitPoint,
    ProjectCredential,
    ProjectPullRequest,
    ProjectRelease,
    ProjectRepo,
    ProjectSyncStatus
} from 'deveye-types';
import { Button, SelectInput } from '@/Components';
import { ws } from '@/api/ws';
import { invalidate, useResourceVersion } from '@/stores/invalidation';
import { humanizeError, withSecrecy } from '../api';
import { CommitGraph } from './CommitGraph';
import { CommitDialog } from './CommitDialog';
import { PullRequestView, PULL_STATE_LABELS } from './PullRequestView';
import { RepoDialog } from './RepoDialog';
import styles from '../style.module.css';

/** Cadence de sondage de l'avancement pendant une synchronisation. */
const POLL_MS = 700;

/**
 * Au-delà, on cesse de sonder même si le serveur dit encore « en cours ».
 *
 * Un filet, pas une horloge : sans lui, un service arrêté au mauvais moment
 * laisserait la page sonder indéfiniment.
 */
const POLL_TIMEOUT_MS = 3 * 60_000;

interface GitProps {
    project: Project;
    members: MinimalUser[];
    canWrite: boolean;
}

interface GraphState {
    points: ProjectCommitPoint[];
    authors: ProjectCommitAuthor[];
    firstCommitAt: number | null;
    lastCommitAt: number | null;
    total: number;
}

/**
 * L'onglet Git : dépôt lié, graphe des commits, branches, releases et pull
 * requests.
 *
 * Tout ce qui s'affiche ici vient du **cache local** alimenté par le service de
 * fond — l'ouverture de l'onglet est donc instantanée et ne consomme aucun
 * quota. « Synchroniser » ne fait que réveiller l'ordonnanceur ; c'est
 * `project.syncStatus` qui dit ensuite où il en est.
 *
 * Une seule exception, et elle est délibérée : le diff d'un commit
 * (`CommitDialog`) est lu chez GitHub à l'ouverture, parce qu'un diff ne se met
 * pas en cache.
 */
export function Git({ project, members, canWrite }: GitProps) {
    const [repo, setRepo] = useState<ProjectRepo | null>(null);
    const [credentials, setCredentials] = useState<ProjectCredential[]>([]);
    const [graph, setGraph] = useState<GraphState | null>(null);
    const [branches, setBranches] = useState<ProjectBranch[]>([]);
    const [releases, setReleases] = useState<ProjectRelease[]>([]);
    const [commits, setCommits] = useState<ProjectCommit[]>([]);
    const [pulls, setPulls] = useState<ProjectPullRequest[]>([]);
    const [loaded, setLoaded] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [dialogOpen, setDialogOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    const [sync, setSync] = useState<ProjectSyncStatus | null>(null);
    const [openSha, setOpenSha] = useState<string | null>(null);
    const [openPull, setOpenPull] = useState<ProjectPullRequest | null>(null);

    const version = useResourceVersion('project.board');
    const guarded = project.securityTier === 'guarded';

    const load = useCallback(async () => {
        try {
            const [repoRes, creds] = await Promise.all([
                withSecrecy(() => ws.send('project.repoGet', { projectId: project.id })),
                ws.send('project.credentialList', {})
            ]);
            setRepo(repoRes.repo);
            setCredentials(creds.credentials);

            if (repoRes.repo) {
                const [g, b, r, c, p] = await Promise.all([
                    withSecrecy(() => ws.send('project.commitGraph', { projectId: project.id })),
                    withSecrecy(() => ws.send('project.branchList', { projectId: project.id })),
                    withSecrecy(() => ws.send('project.releaseList', { projectId: project.id })),
                    withSecrecy(() => ws.send('project.commitList', { projectId: project.id, limit: 15 })),
                    withSecrecy(() => ws.send('project.pullRequestList', { projectId: project.id }))
                ]);
                setGraph(g);
                setBranches(b.branches);
                setReleases(r.releases);
                setCommits(c.commits);
                setPulls(p.pullRequests);
            }
            setError(null);
        } catch (e) {
            setError(humanizeError(e, 'Impossible de charger l’intégration git.'));
        } finally {
            setLoaded(true);
        }
    }, [project.id]);

    useEffect(() => {
        void load();
    }, [load, version]);

    /**
     * Sonde l'avancement tant qu'une synchronisation tourne.
     *
     * Sondage plutôt que diffusion `live` : les six étapes d'un tour
     * feraient sinon re-solliciter tout le tableau six fois d'affilée chez
     * **tous** les membres de l'espace, pour une information qui n'intéresse que
     * celui qui a pressé le bouton. La fin du sondage, elle, re-sollicite une
     * fois — et c'est bien la seule chose que les autres ont besoin de voir.
     */
    const alive = useRef(true);
    useEffect(() => {
        alive.current = true;
        // Quitter l'onglet arrête le sondage : sans ça, une vue démontée
        // continuerait d'interroger le serveur toutes les 700 ms jusqu'à la fin
        // de la synchronisation.
        return () => {
            alive.current = false;
        };
    }, []);

    const poll = useCallback(async () => {
        const until = Date.now() + POLL_TIMEOUT_MS;
        for (;;) {
            if (!alive.current) return;
            let status: ProjectSyncStatus;
            try {
                const res = await ws.send('project.syncStatus', { projectId: project.id });
                status = res.status;
            } catch {
                // Une coupure ne doit pas laisser le voile en place : on rend la
                // main, la vue reviendra d'elle-même à la reconnexion.
                setSync(null);
                return;
            }
            if (!status.running || Date.now() > until) {
                setSync(null);
                // Le service a écrit : c'est maintenant qu'il y a du neuf à lire.
                invalidate('project.board');
                return;
            }
            setSync(status);
            await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        }
    }, [project.id]);

    // Une seule boucle de sondage à la fois, même si l'on presse deux fois.
    const polling = useRef<Promise<void> | null>(null);
    const startPolling = useCallback(() => {
        if (polling.current) return;
        polling.current = poll().finally(() => {
            polling.current = null;
        });
    }, [poll]);

    const syncNow = async () => {
        setBusy(true);
        try {
            await ws.send('project.repoSyncNow', { projectId: project.id });
            setError(null);
            // Étape zéro affichée tout de suite : sans elle, le voile
            // n'apparaîtrait qu'au premier sondage, sept dixièmes plus tard.
            setSync({ running: true, phase: 'Dépôt', step: 0, stepCount: 6, startedAt: null });
            startPolling();
        } catch (e) {
            setError(humanizeError(e, 'La synchronisation n’a pas pu être lancée.'));
        } finally {
            setBusy(false);
        }
    };

    const unlink = async () => {
        setBusy(true);
        try {
            await withSecrecy(() => ws.send('project.repoUnlink', { projectId: project.id }));
            setDialogOpen(false);
            invalidate('project.board');
        } catch (e) {
            setError(humanizeError(e, 'Le déliement a échoué.'));
        } finally {
            setBusy(false);
        }
    };

    const mapAuthor = async (authorRef: string, userId: number | null) => {
        try {
            await ws.send('project.authorMap', { projectId: project.id, authorRef, userId });
            invalidate('project.board');
        } catch (e) {
            setError(humanizeError(e, 'Le rattachement a échoué.'));
        }
    };

    if (guarded) {
        return (
            <p className={styles.empty}>
                Ce projet est confidentiel : il ne peut pas être synchronisé avec un dépôt, car la synchronisation
                tourne sans session et n’a pas accès à sa clé.
            </p>
        );
    }

    if (!loaded) return <p className={styles.empty}>Chargement…</p>;

    // Une PR ouverte prend tout l'onglet : voir `PullRequestView`.
    if (openPull) return <PullRequestView pull={openPull} onBack={() => setOpenPull(null)} />;

    return (
        <div className={styles.git}>
            {error && <p className={styles.error}>{error}</p>}

            {!repo && (
                <div className={styles.gitEmpty}>
                    <p className={styles.empty}>Aucun dépôt lié à ce projet.</p>
                    {canWrite && (
                        <Button icon='add' onClick={() => setDialogOpen(true)}>
                            Lier un dépôt
                        </Button>
                    )}
                </div>
            )}

            {repo && (
                <>
                    <header className={styles.repoHead}>
                        <div className={styles.repoIdent}>
                            <p className={styles.repoName}>
                                <span className='icon icon-branch' /> {repo.owner}/{repo.repo}
                            </p>
                            <p className={styles.repoMeta}>
                                {repo.defaultBranch && <span>branche {repo.defaultBranch}</span>}
                                {repo.lastSyncAt !== null && (
                                    <span>
                                        {' '}
                                        · synchronisé {new Date(repo.lastSyncAt * 1000).toLocaleString('fr-FR')}
                                    </span>
                                )}
                                {repo.credentialId === null && (
                                    <span className={styles.overdue}> · jeton retiré, synchronisation arrêtée</span>
                                )}
                            </p>
                            {repo.lastSyncError && <p className={styles.error}>{repo.lastSyncError}</p>}
                        </div>
                        {canWrite && (
                            <div className={styles.actions}>
                                <Button
                                    variant='secondary'
                                    icon='refresh'
                                    onClick={() => void syncNow()}
                                    disabled={busy || sync !== null}
                                >
                                    Synchroniser
                                </Button>
                                {/* « Délier » n'est plus ici : c'est une action
                                    destructrice, elle vit dans « Modifier ». */}
                                <Button variant='secondary' icon='edit' onClick={() => setDialogOpen(true)}>
                                    Modifier
                                </Button>
                            </div>
                        )}
                    </header>

                    {/* Le voile couvre tout ce qui est en train d'être remplacé,
                        et lui seul : l'en-tête reste net et cliquable. */}
                    <div className={styles.gitContent}>
                        <div className={`${styles.gitStack} ${sync ? styles.gitDimmed : ''}`}>
                            <CommitGraph {...(graph ?? emptyGraph)} onOpenCommit={(sha) => setOpenSha(sha)} />

                            {/* Rattacher un auteur git à un membre : c'est ce qui donne
                                au graphe la couleur de présence de la personne. */}
                            {canWrite && graph && graph.authors.length > 0 && (
                                <details className={styles.authorMap}>
                                    <summary>Rattacher les auteurs aux membres</summary>
                                    <ul className={styles.authorList}>
                                        {graph.authors.map((author) => (
                                            <li key={author.authorRef}>
                                                <span className={styles.authorName}>
                                                    {author.name || 'Auteur inconnu'}
                                                    <span className={styles.hint}>{author.email}</span>
                                                </span>
                                                <SelectInput
                                                    className={styles.authorSelect}
                                                    value={author.userId === null ? '' : String(author.userId)}
                                                    onChange={(e) =>
                                                        void mapAuthor(
                                                            author.authorRef,
                                                            e.target.value ? Number(e.target.value) : null
                                                        )
                                                    }
                                                >
                                                    <option value=''>Non rattaché</option>
                                                    {members.map((m) => (
                                                        <option key={m.id} value={m.id}>
                                                            {m.username}
                                                        </option>
                                                    ))}
                                                </SelectInput>
                                            </li>
                                        ))}
                                    </ul>
                                </details>
                            )}

                            <div className={styles.gitCols}>
                                <Panel title='Branches' count={branches.length}>
                                    {branches.length === 0 && <p className={styles.empty}>Aucune branche.</p>}
                                    <ul className={styles.gitList}>
                                        {branches.map((b) => (
                                            <li key={b.id}>
                                                <span className='icon icon-branch' />
                                                <span className={styles.gitItemName}>{b.name}</span>
                                                {b.isDefault && <span className={styles.defaultTag}>principale</span>}
                                                <BranchDrift branch={b} />
                                                {b.headSha && (
                                                    <code className={styles.sha}>{b.headSha.slice(0, 7)}</code>
                                                )}
                                            </li>
                                        ))}
                                    </ul>
                                </Panel>

                                <Panel title='Releases' count={releases.length}>
                                    {releases.length === 0 && <p className={styles.empty}>Aucune release.</p>}
                                    <ul className={styles.gitList}>
                                        {releases.slice(0, 10).map((r) => (
                                            <li key={r.id}>
                                                <span className='icon icon-star' />
                                                <span className={styles.gitItemName}>{r.name || r.tag}</span>
                                                {r.isPrerelease && <span className={styles.preTag}>pré-version</span>}
                                                <span className={styles.gitDate}>
                                                    {new Date(r.publishedAt * 1000).toLocaleDateString('fr-FR')}
                                                </span>
                                            </li>
                                        ))}
                                    </ul>
                                </Panel>

                                <Panel title='Pull requests' count={pulls.length}>
                                    {pulls.length === 0 && <p className={styles.empty}>Aucune pull request.</p>}
                                    <ul className={styles.gitList}>
                                        {pulls.slice(0, 12).map((p) => (
                                            <li key={p.id}>
                                                <button
                                                    type='button'
                                                    className={styles.gitRowButton}
                                                    onClick={() => setOpenPull(p)}
                                                >
                                                    <span className={styles.pullState} data-state={p.state}>
                                                        {PULL_STATE_LABELS[p.state]}
                                                    </span>
                                                    <span className={styles.gitItemName}>
                                                        {p.title || 'Sans titre'}
                                                    </span>
                                                    <span className={styles.gitDate}>#{p.number}</span>
                                                </button>
                                            </li>
                                        ))}
                                    </ul>
                                </Panel>

                                <Panel title='Derniers commits' count={graph?.total ?? commits.length} wide>
                                    {commits.length === 0 && <p className={styles.empty}>Aucun commit.</p>}
                                    <ul className={styles.gitList}>
                                        {commits.map((c) => (
                                            <li key={c.id}>
                                                <button
                                                    type='button'
                                                    className={styles.gitRowButton}
                                                    onClick={() => setOpenSha(c.sha)}
                                                    title='Voir les modifications'
                                                >
                                                    <code className={styles.sha}>{c.sha.slice(0, 7)}</code>
                                                    <span className={styles.gitItemName}>{firstLine(c.message)}</span>
                                                    {c.parentCount > 1 && <span className={styles.preTag}>fusion</span>}
                                                    <span className={styles.gitDate}>
                                                        {c.authorName} ·{' '}
                                                        {new Date(c.committedAt * 1000).toLocaleDateString('fr-FR')}
                                                    </span>
                                                </button>
                                            </li>
                                        ))}
                                    </ul>
                                </Panel>
                            </div>
                        </div>

                        {sync && <SyncOverlay status={sync} />}
                    </div>
                </>
            )}

            <RepoDialog
                open={dialogOpen}
                repo={repo}
                credentials={credentials}
                onClose={() => setDialogOpen(false)}
                onSaved={() => {
                    setDialogOpen(false);
                    invalidate('project.board');
                    // Une liaison déclenche une première lecture côté serveur :
                    // autant montrer qu'elle tourne.
                    setSync({ running: true, phase: 'Dépôt', step: 0, stepCount: 6, startedAt: null });
                    startPolling();
                }}
                onUnlink={canWrite && repo ? () => void unlink() : undefined}
                projectId={project.id}
            />

            <CommitDialog
                open={openSha !== null}
                projectId={project.id}
                sha={openSha}
                onClose={() => setOpenSha(null)}
            />
        </div>
    );
}

/** Un graphe vide : évite un `graph &&` qui ferait sauter la mise en page. */
const emptyGraph: GraphState = { points: [], authors: [], firstCommitAt: null, lastCommitAt: null, total: 0 };

interface PanelProps {
    title: string;
    count: number;
    /** Occupe toute la largeur de la grille (pour les listes longues). */
    wide?: boolean;
    children: ReactNode;
}

/**
 * Une carte autour d'une liste.
 *
 * Sans elle, les quatre listes s'étalaient sur toute la largeur et ne se
 * distinguaient plus les unes des autres qu'à leur titre. Un contour discret et
 * une grille suffisent à leur rendre un contour — inutile d'aller plus loin.
 */
function Panel({ title, count, wide, children }: PanelProps) {
    return (
        <section className={wide ? styles.panelWide : styles.panel}>
            <header className={styles.panelHead}>
                <h3 className={styles.gitTitle}>{title}</h3>
                <span className={styles.panelCount}>{count}</span>
            </header>
            {children}
        </section>
    );
}

/** Avance et retard d'une branche sur la principale, quand on les connaît. */
function BranchDrift({ branch }: { branch: ProjectBranch }) {
    if (branch.isDefault) return null;
    if (branch.aheadCount === null && branch.behindCount === null) return null;
    return (
        <span className={styles.drift} title='Commits d’avance et de retard sur la branche principale'>
            {branch.aheadCount !== null && branch.aheadCount > 0 && (
                <span className={styles.driftAhead}>↑{branch.aheadCount}</span>
            )}
            {branch.behindCount !== null && branch.behindCount > 0 && (
                <span className={styles.driftBehind}>↓{branch.behindCount}</span>
            )}
            {branch.aheadCount === 0 && branch.behindCount === 0 && <span className={styles.driftSync}>à jour</span>}
        </span>
    );
}

/**
 * Le voile de chargement, avec l'étape en cours.
 *
 * La barre avance par **étapes nommées** et non par objets traités : voir
 * `projectSyncStatusSchema`. C'est le seul comptage dont on connaisse le total
 * d'avance, donc le seul qui ne mente pas.
 */
function SyncOverlay({ status }: { status: ProjectSyncStatus }) {
    const ratio = status.stepCount > 0 ? Math.min(1, status.step / status.stepCount) : 0;
    return (
        <div className={styles.syncOverlay}>
            <span className={`icon icon-spinner ${styles.spinning}`} />
            <span className={styles.syncPhase}>{status.phase ?? 'Synchronisation…'}</span>
            <div className={styles.syncBar}>
                <div className={styles.syncBarFill} style={{ width: `${Math.round(ratio * 100)}%` }} />
            </div>
            <span className={styles.hint}>
                Étape {Math.min(status.step + 1, status.stepCount)} sur {status.stepCount}
            </span>
        </div>
    );
}

/** Un message de commit tient sur plusieurs lignes ; la liste n'en montre qu'une. */
function firstLine(message: string): string {
    const line = message.split('\n')[0].trim();
    return line || '(sans message)';
}

export default Git;

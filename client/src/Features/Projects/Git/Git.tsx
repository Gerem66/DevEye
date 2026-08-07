import { useCallback, useEffect, useState } from 'react';
import type {
    MinimalUser,
    Project,
    ProjectBranch,
    ProjectCommit,
    ProjectCommitAuthor,
    ProjectCommitPoint,
    ProjectCredential,
    ProjectRelease,
    ProjectRepo
} from 'deveye-types';
import { Button, SelectInput } from '@/Components';
import { ws } from '@/api/ws';
import { invalidate, useResourceVersion } from '@/stores/invalidation';
import { humanizeError, withSecrecy } from '../api';
import { CommitGraph } from './CommitGraph';
import { RepoDialog } from './RepoDialog';
import styles from '../style.module.css';

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
 * L'onglet Git : dépôt lié, graphe des commits, branches et releases.
 *
 * Tout ce qui s'affiche ici vient du **cache local** alimenté par le service de
 * fond, jamais d'un appel direct à GitHub : l'ouverture de l'onglet est donc
 * instantanée et ne consomme aucun quota. « Synchroniser » ne fait que réveiller
 * l'ordonnanceur.
 */
export function Git({ project, members, canWrite }: GitProps) {
    const [repo, setRepo] = useState<ProjectRepo | null>(null);
    const [credentials, setCredentials] = useState<ProjectCredential[]>([]);
    const [graph, setGraph] = useState<GraphState | null>(null);
    const [branches, setBranches] = useState<ProjectBranch[]>([]);
    const [releases, setReleases] = useState<ProjectRelease[]>([]);
    const [commits, setCommits] = useState<ProjectCommit[]>([]);
    const [loaded, setLoaded] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [dialogOpen, setDialogOpen] = useState(false);
    const [busy, setBusy] = useState(false);

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
                const [g, b, r, c] = await Promise.all([
                    withSecrecy(() => ws.send('project.commitGraph', { projectId: project.id })),
                    withSecrecy(() => ws.send('project.branchList', { projectId: project.id })),
                    withSecrecy(() => ws.send('project.releaseList', { projectId: project.id })),
                    withSecrecy(() => ws.send('project.commitList', { projectId: project.id, limit: 15 }))
                ]);
                setGraph(g);
                setBranches(b.branches);
                setReleases(r.releases);
                setCommits(c.commits);
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

    const syncNow = async () => {
        setBusy(true);
        try {
            await ws.send('project.repoSyncNow', { projectId: project.id });
            // La synchronisation est asynchrone : le service diffusera quand il
            // aura écrit. On ne re-sollicite donc pas tout de suite.
            setError(null);
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
                        <div>
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
                                    disabled={busy}
                                >
                                    Synchroniser
                                </Button>
                                <Button variant='secondary' icon='edit' onClick={() => setDialogOpen(true)}>
                                    Modifier
                                </Button>
                                <Button variant='danger' onClick={() => void unlink()} disabled={busy}>
                                    Délier
                                </Button>
                            </div>
                        )}
                    </header>

                    {graph && <CommitGraph {...graph} />}

                    {/* Rattacher un auteur git à un membre : c'est ce qui donne au
                        graphe la couleur de présence de la personne. */}
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
                        <section>
                            <h3 className={styles.gitTitle}>Branches</h3>
                            {branches.length === 0 && <p className={styles.empty}>Aucune branche.</p>}
                            <ul className={styles.gitList}>
                                {branches.map((b) => (
                                    <li key={b.id}>
                                        <span className='icon icon-branch' />
                                        <span className={styles.gitItemName}>{b.name}</span>
                                        {b.isDefault && <span className={styles.defaultTag}>défaut</span>}
                                        {b.headSha && <code className={styles.sha}>{b.headSha.slice(0, 7)}</code>}
                                    </li>
                                ))}
                            </ul>
                        </section>

                        <section>
                            <h3 className={styles.gitTitle}>Releases</h3>
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
                        </section>
                    </div>

                    <section>
                        <h3 className={styles.gitTitle}>Derniers commits</h3>
                        <ul className={styles.gitList}>
                            {commits.map((c) => (
                                <li key={c.id}>
                                    <code className={styles.sha}>{c.sha.slice(0, 7)}</code>
                                    <span className={styles.gitItemName}>{firstLine(c.message)}</span>
                                    {c.parentCount > 1 && <span className={styles.preTag}>fusion</span>}
                                    <span className={styles.gitDate}>
                                        {c.authorName} · {new Date(c.committedAt * 1000).toLocaleDateString('fr-FR')}
                                    </span>
                                </li>
                            ))}
                        </ul>
                    </section>
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
                }}
                projectId={project.id}
            />
        </div>
    );
}

/** Un message de commit tient sur plusieurs lignes ; la liste n'en montre qu'une. */
function firstLine(message: string): string {
    const line = message.split('\n')[0].trim();
    return line || '(sans message)';
}

export default Git;

import { useCallback, useEffect, useState } from 'react';
import type { GitRepo, MinimalUser, Project } from 'deveye-types';
import { Button } from '@/Components';
import { ws } from '@/api/ws';
import { invalidate, useResourceVersion } from '@/stores/invalidation';
import { useWorkspacePermissions } from '@/stores/workspace';
import { RepoView } from '@/Features/Git/RepoView';
import gitStyles from '@/Features/Git/style.module.css';
import { humanizeError } from '../api';
import { LinkRepoDialog } from './LinkRepoDialog';
import styles from '../style.module.css';

interface GitProps {
    project: Project;
    members: MinimalUser[];
    canWrite: boolean;
}

/**
 * L'onglet Git d'un projet : le dépôt qu'il pointe.
 *
 * Enveloppe mince, et c'est tout l'intérêt. **Le dépôt n'appartient pas au
 * projet** : il vit dans la feature Git, avec son cache, sa synchronisation et
 * ses jetons, et plusieurs projets peuvent viser le même. Cet onglet ne possède
 * donc qu'un pointeur (`project.repoGet` / `repoLink` / `repoUnlink`) et délègue
 * tout l'affichage à `RepoView`, exactement le même composant que la feature
 * Git — un dépôt n'a pas à se présenter autrement selon la porte par laquelle
 * on entre.
 *
 * Corollaire à connaître : lire ce dépôt relève du droit `git`, pas de
 * `projects`. Un membre qui a l'un sans l'autre voit le projet mais pas son
 * dépôt, et l'écran le dit.
 */
export function Git({ project, members, canWrite }: GitProps) {
    const permissions = useWorkspacePermissions();
    const canReadGit = permissions.canFeature('git');
    const canWriteGit = permissions.canFeature('git', 'write');

    const [repoId, setRepoId] = useState<number | null>(null);
    const [repo, setRepo] = useState<GitRepo | null>(null);
    const [loaded, setLoaded] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [dialogOpen, setDialogOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    // Remonté par `RepoView`, qui sonde l'avancement : tant qu'une
    // synchronisation tourne, l'en-tête n'a rien à proposer.
    const [syncing, setSyncing] = useState(false);
    const onSyncingChange = useCallback((v: boolean) => setSyncing(v), []);
    // Pendant du signal ci-dessus : l'en-tête dit « on vient de demander », et
    // `RepoView` se met à sonder — y compris sur un dépôt déjà synchronisé.
    const [syncRequest, setSyncRequest] = useState(0);

    const boardVersion = useResourceVersion('project.board');
    const gitVersion = useResourceVersion('git.repo');
    const guarded = project.securityTier === 'guarded';

    const load = useCallback(async () => {
        if (guarded) {
            setLoaded(true);
            return;
        }
        try {
            const link = await ws.send('project.repoGet', { projectId: project.id });
            setRepoId(link.repoId);
            // Le détail du dépôt relève de la feature Git : sans le droit, on
            // s'arrête au pointeur plutôt que d'encaisser un refus.
            setRepo(
                link.repoId !== null && canReadGit ? (await ws.send('git.repoGet', { repoId: link.repoId })).repo : null
            );
            setError(null);
        } catch (e) {
            setError(humanizeError(e, 'Impossible de charger le dépôt lié.'));
        } finally {
            setLoaded(true);
        }
    }, [project.id, guarded, canReadGit]);

    useEffect(() => {
        void load();
    }, [load, boardVersion, gitVersion]);

    const unlink = async () => {
        setBusy(true);
        try {
            await ws.send('project.repoUnlink', { projectId: project.id });
            setDialogOpen(false);
            invalidate('project.board', 'git.list');
        } catch (e) {
            setError(humanizeError(e, 'Le déliement a échoué.'));
        } finally {
            setBusy(false);
        }
    };

    if (guarded) {
        return (
            <p className={styles.empty}>
                Ce projet est confidentiel : il ne peut pas être relié à un dépôt. La liaison serait une ligne en clair,
                et la synchronisation tourne sans session.
            </p>
        );
    }

    if (!loaded) return <p className={styles.empty}>Chargement…</p>;

    return (
        <div className={gitStyles.git}>
            {error && <p className={styles.error}>{error}</p>}

            {repoId === null && (
                <div className={gitStyles.gitEmpty}>
                    <p className={styles.empty}>Aucun dépôt relié à ce projet.</p>
                    {canWrite && canWriteGit && (
                        <Button icon='add' onClick={() => setDialogOpen(true)}>
                            Relier un dépôt
                        </Button>
                    )}
                </div>
            )}

            {/* Le pointeur existe mais le dépôt n'est pas lisible : c'est un
                manque de droit, pas une erreur. Le dire plutôt que d'afficher
                un écran vide qui se lirait comme un bug. */}
            {repoId !== null && !canReadGit && (
                <p className={styles.empty}>
                    Ce projet est relié à un dépôt, mais votre rôle n’ouvre pas la feature Git.
                </p>
            )}

            {repo && (
                <>
                    <header className={gitStyles.repoHead}>
                        <div className={gitStyles.repoIdent}>
                            <p className={gitStyles.repoName}>
                                <span className='icon icon-branch' /> {repo.owner}/{repo.repo}
                            </p>
                            <p className={gitStyles.repoMeta}>
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
                                {repo.projectCount > 1 && (
                                    <span>
                                        {' '}
                                        · partagé avec {repo.projectCount - 1} autre
                                        {repo.projectCount > 2 ? 's' : ''} projet{repo.projectCount > 2 ? 's' : ''}
                                    </span>
                                )}
                            </p>
                            {repo.lastSyncError && <p className={styles.error}>{repo.lastSyncError}</p>}
                        </div>
                        {canWrite && canWriteGit && (
                            <div className={styles.actions}>
                                <Button
                                    variant='secondary'
                                    icon='refresh'
                                    onClick={() => {
                                        setSyncRequest((n) => n + 1);
                                        void ws.send('git.repoSyncNow', { repoId: repo.id });
                                    }}
                                    disabled={busy || syncing}
                                >
                                    {syncing ? 'Synchronisation…' : 'Synchroniser'}
                                </Button>
                                {/* « Délier » n'est pas ici : c'est une action
                                    destructrice, elle vit dans « Modifier ». */}
                                <Button
                                    variant='secondary'
                                    icon='edit'
                                    onClick={() => setDialogOpen(true)}
                                    disabled={busy || syncing}
                                >
                                    Modifier
                                </Button>
                            </div>
                        )}
                    </header>

                    <RepoView
                        repo={repo}
                        members={members}
                        canWrite={canWrite && canWriteGit}
                        onSyncingChange={onSyncingChange}
                        syncRequest={syncRequest}
                    />
                </>
            )}

            <LinkRepoDialog
                open={dialogOpen}
                projectId={project.id}
                linkedRepoId={repoId}
                onClose={() => setDialogOpen(false)}
                onSaved={() => {
                    setDialogOpen(false);
                    invalidate('project.board', 'git.list', 'git.count');
                }}
                onUnlink={canWrite && canWriteGit && repoId !== null ? () => void unlink() : undefined}
            />
        </div>
    );
}

export default Git;

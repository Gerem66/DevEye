import { useCallback, useEffect, useState } from 'react';
import type { GitCredential, GitRepo, MinimalUser, Project } from 'deveye-types';
import { Button, Dialog } from '@/Components';
import { ws } from '@/api/ws';
import { invalidate, useResourceVersion } from '@/stores/invalidation';
import { startTeleport } from '@/stores/live';
import { getActiveWorkspaceId, useWorkspacePermissions } from '@/stores/workspace';
import { RepoView } from '@/Features/Git/RepoView';
import { RepoDialog } from '@/Features/Git/RepoDialog';
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
 * L'onglet Git d'un projet : les dépôts qu'il pointe.
 *
 * Enveloppe mince, et c'est tout l'intérêt. **Le dépôt n'appartient pas au
 * projet** : il vit dans la feature Git, avec son cache, sa synchronisation et
 * ses jetons, et plusieurs projets peuvent viser le même. Cet onglet ne possède
 * donc qu'un pointeur (`project.repoList` / `repoLink` / `repoUnlink`) et délègue
 * tout l'affichage à `RepoView`, exactement le même composant que la feature
 * Git — un dépôt n'a pas à se présenter autrement selon la porte par laquelle
 * on entre.
 *
 * **Plusieurs dépôts**, depuis la migration 069 : un projet réel se compose
 * souvent d'un client, d'un serveur et de contrats partagés. Au-delà du premier,
 * chaque dépôt reçoit un cadre discret — sans lui, deux graphes et huit panneaux
 * s'enchaîneraient sans qu'on sache où l'un finit et où l'autre commence.
 *
 * Corollaire à connaître : lire ces dépôts relève du droit `git`, pas de
 * `projects`. Un membre qui a l'un sans l'autre voit le projet mais pas ses
 * dépôts, et l'écran le dit.
 */
export function Git({ project, members, canWrite }: GitProps) {
    const permissions = useWorkspacePermissions();
    const canReadGit = permissions.canFeature('git');
    const canWriteGit = permissions.canFeature('git', 'write');

    const [repoIds, setRepoIds] = useState<number[]>([]);
    const [repos, setRepos] = useState<GitRepo[]>([]);
    const [loaded, setLoaded] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [linkOpen, setLinkOpen] = useState(false);
    const [unlinking, setUnlinking] = useState<GitRepo | null>(null);
    const [busy, setBusy] = useState(false);

    const boardVersion = useResourceVersion('project.board');
    const gitVersion = useResourceVersion('git.repo');
    const guarded = project.securityTier === 'guarded';

    const load = useCallback(async () => {
        if (guarded) {
            setLoaded(true);
            return;
        }
        try {
            const link = await ws.send('project.repoList', { projectId: project.id });
            setRepoIds(link.repoIds);
            // Le détail d'un dépôt relève de la feature Git : sans le droit, on
            // s'arrête aux pointeurs plutôt que d'encaisser un refus.
            setRepos(
                canReadGit
                    ? (await Promise.all(link.repoIds.map((id) => ws.send('git.repoGet', { repoId: id })))).map(
                          (r) => r.repo
                      )
                    : []
            );
            setError(null);
        } catch (e) {
            setError(humanizeError(e, 'Impossible de charger les dépôts liés.'));
        } finally {
            setLoaded(true);
        }
    }, [project.id, guarded, canReadGit]);

    useEffect(() => {
        void load();
    }, [load, boardVersion, gitVersion]);

    const unlink = async (repoId: number) => {
        setBusy(true);
        try {
            await ws.send('project.repoUnlink', { projectId: project.id, repoId });
            setUnlinking(null);
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

            {repoIds.length === 0 && (
                <div className={gitStyles.gitEmpty}>
                    <p className={styles.empty}>Aucun dépôt relié à ce projet.</p>
                </div>
            )}

            {/* Le pointeur existe mais le dépôt n'est pas lisible : c'est un
                manque de droit, pas une erreur. Le dire plutôt que d'afficher
                un écran vide qui se lirait comme un bug. */}
            {repoIds.length > 0 && !canReadGit && (
                <p className={styles.empty}>
                    Ce projet est relié à {repoIds.length} dépôt{repoIds.length > 1 ? 's' : ''}, mais votre rôle n’ouvre
                    pas la feature Git.
                </p>
            )}

            {repos.map((repo) => (
                <RepoBlock
                    key={repo.id}
                    repo={repo}
                    members={members}
                    canWrite={canWrite}
                    canWriteGit={canWriteGit}
                    onUnlink={() => setUnlinking(repo)}
                />
            ))}

            {/* Toujours en bas, même quand un dépôt est déjà relié : on peut en
                ajouter autant qu'on veut, et c'est le geste suivant naturel une
                fois qu'on a fini de lire ce qui précède. */}
            {canWrite && canWriteGit && (
                <div className={gitStyles.addRow}>
                    <Button icon='add' onClick={() => setLinkOpen(true)}>
                        Ajouter un dépôt
                    </Button>
                </div>
            )}

            <LinkRepoDialog
                open={linkOpen}
                projectId={project.id}
                linkedRepoIds={repoIds}
                onClose={() => setLinkOpen(false)}
                onSaved={() => {
                    setLinkOpen(false);
                    invalidate('project.board', 'git.list', 'git.count');
                }}
            />

            <Dialog
                open={unlinking !== null}
                onClose={() => setUnlinking(null)}
                title='Délier ce dépôt ?'
                width={460}
                footer={
                    <>
                        <Button variant='secondary' onClick={() => setUnlinking(null)} disabled={busy}>
                            Annuler
                        </Button>
                        <Button variant='danger' disabled={busy} onClick={() => unlinking && void unlink(unlinking.id)}>
                            Délier
                        </Button>
                    </>
                }
            >
                <p className={styles.hint}>
                    {unlinking && (
                        <>
                            <strong>
                                {unlinking.owner}/{unlinking.repo}
                            </strong>{' '}
                            quitte ce projet. Le dépôt lui-même, son historique et les autres projets qui l’utilisent ne
                            sont pas touchés.
                        </>
                    )}
                </p>
            </Dialog>
        </div>
    );
}

interface RepoBlockProps {
    repo: GitRepo;
    members: MinimalUser[];
    canWrite: boolean;
    canWriteGit: boolean;
    onUnlink: () => void;
}

/** Un dépôt du projet : son en-tête, et le contenu partagé avec la feature Git. */
function RepoBlock({ repo, members, canWrite, canWriteGit, onUnlink }: RepoBlockProps) {
    // `RepoView` sonde l'avancement ; l'en-tête, lui, porte les boutons. Tant
    // qu'une synchronisation tourne, ni « Synchroniser » ni « Modifier » n'ont
    // de sens : le contenu est déjà voilé et va être remplacé.
    const [syncing, setSyncing] = useState(false);
    const onSyncingChange = useCallback((v: boolean) => setSyncing(v), []);
    const [syncRequest, setSyncRequest] = useState(0);
    const [dialogOpen, setDialogOpen] = useState(false);
    /** Les jetons de l'espace, lus seulement quand le dialogue s'ouvre. */
    const [credentials, setCredentials] = useState<GitCredential[]>([]);

    useEffect(() => {
        if (!dialogOpen) return;
        void ws.send('git.credentialList', {}).then((res) => setCredentials(res.credentials));
    }, [dialogOpen]);

    // Toujours encadré, y compris sur un dépôt unique.
    //
    // Le cadre ne servait qu'à *séparer* deux blocs, d'où la règle précédente
    // qui l'omettait quand il n'y avait rien à séparer. Mais il fait aussi
    // autre chose : il dit où finit ce que l'onglet montre. Sans lui, un dépôt
    // seul se confondait avec le fond de la popup, et l'onglet ne ressemblait
    // plus aux autres du même projet.
    return (
        <section className={gitStyles.repoBlockFramed}>
            <header className={gitStyles.repoHead}>
                <div className={gitStyles.repoIdent}>
                    {/*
                     * Le nom mène au dépôt dans sa feature. Le sens qui manquait :
                     * Git sait déjà mener aux projets d'un dépôt, l'onglet d'un
                     * projet ne savait pas mener au dépôt. Par la téléportation,
                     * comme partout — un chemin `view:git l1:repo:7` dit « ouvre
                     * la feature, et dedans, ce dépôt-là », garde d'accès
                     * comprise.
                     */}
                    <button
                        type='button'
                        className={gitStyles.repoNameLink}
                        title={`Ouvrir ${repo.owner}/${repo.repo} dans « Git »`}
                        onClick={() => startTeleport(getActiveWorkspaceId() ?? 0, ['view:git', `l1:repo:${repo.id}`])}
                    >
                        <span className='icon icon-branch' aria-hidden='true' /> {repo.owner}/{repo.repo}
                        <span className={`icon icon-arrow ${gitStyles.repoNameArrow}`} aria-hidden='true' />
                    </button>
                    <p className={gitStyles.repoMeta}>
                        {repo.defaultBranch && <span>branche {repo.defaultBranch}</span>}
                        {repo.lastSyncAt !== null && (
                            <span> · synchronisé {new Date(repo.lastSyncAt * 1000).toLocaleString('fr-FR')}</span>
                        )}
                        {repo.credentialId === null && (
                            <span className={gitStyles.overdue}> · jeton retiré, synchronisation arrêtée</span>
                        )}
                        {repo.projectCount > 1 && (
                            <span>
                                {' '}
                                · partagé avec {repo.projectCount - 1} autre{repo.projectCount > 2 ? 's' : ''} projet
                                {repo.projectCount > 2 ? 's' : ''}
                            </span>
                        )}
                    </p>
                    {repo.lastSyncError && <p className={gitStyles.error}>{repo.lastSyncError}</p>}
                </div>
                {canWrite && canWriteGit && (
                    <div className={gitStyles.actions}>
                        <Button
                            variant='secondary'
                            icon='refresh'
                            onClick={() => {
                                setSyncRequest((n) => n + 1);
                                void ws.send('git.repoSyncNow', { repoId: repo.id });
                            }}
                            disabled={syncing}
                        >
                            {syncing ? 'Synchronisation…' : 'Synchroniser'}
                        </Button>
                        <Button variant='secondary' icon='edit' onClick={() => setDialogOpen(true)} disabled={syncing}>
                            Modifier
                        </Button>
                        {/* Destructeur, donc à part et confirmé : il ne doit pas
                            côtoyer « Synchroniser », qu'on presse souvent. */}
                        <Button variant='ghost' onClick={onUnlink} disabled={syncing}>
                            Délier
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

            {/* Le vrai dialogue de la feature Git, pas une copie : régler un
                dépôt depuis un projet ou depuis sa feature doit être le même
                geste, et une seconde implémentation divergerait au premier
                ajustement. */}
            <RepoDialog
                open={dialogOpen}
                repo={repo}
                credentials={credentials}
                onClose={() => setDialogOpen(false)}
                onSaved={() => {
                    setDialogOpen(false);
                    invalidate('git.list', 'git.repo', 'git.count');
                }}
            />
        </section>
    );
}

export default Git;

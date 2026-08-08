import { useCallback, useState } from 'react';
import type { GitRepo, GitRepoUsage, MinimalUser } from 'deveye-types';
import { Button } from '@/Components';
import { STATUS_LABELS } from '../Projects/api';
import { RepoView } from './RepoView';
import styles from './style.module.css';

interface RepoDetailProps {
    repo: GitRepo;
    usage: GitRepoUsage[];
    members: MinimalUser[];
    canWrite: boolean;
    busy: boolean;
    onBack: () => void;
    onEdit: () => void;
    onSyncNow: () => void;
    /** Ouvre un projet qui utilise ce dépôt, dans la feature Projets. */
    onOpenProject: (projectId: number) => void;
}

/**
 * Un dépôt ouvert : son en-tête, ses projets, et son contenu.
 *
 * Le contenu est `RepoView`, partagé mot pour mot avec l'onglet Git d'un
 * projet — c'est le même dépôt, il n'y a aucune raison qu'il se présente
 * autrement selon la porte par laquelle on entre.
 */
export function RepoDetail({
    repo,
    usage,
    members,
    canWrite,
    busy,
    onBack,
    onEdit,
    onSyncNow,
    onOpenProject
}: RepoDetailProps) {
    // `RepoView` sonde l'avancement ; l'en-tête, lui, porte les boutons. Tant
    // qu'une synchronisation tourne, ni « Synchroniser » ni « Modifier » n'ont
    // de sens : le contenu est déjà voilé et va être remplacé.
    const [syncing, setSyncing] = useState(false);
    const onSyncingChange = useCallback((v: boolean) => setSyncing(v), []);
    /**
     * Chaque pression sur « Synchroniser » incrémente ce compteur, que
     * `RepoView` observe pour se mettre à sonder. C'est le pendant du signal
     * ci-dessus : l'en-tête sait qu'on a demandé, la vue sait où ça en est.
     */
    const [syncRequest, setSyncRequest] = useState(0);

    return (
        <div className={styles.root}>
            <header className={styles.header}>
                <div className={styles.detailHead}>
                    <Button variant='ghost' icon='arrow-left' onClick={onBack}>
                        Dépôts
                    </Button>
                    <div className={styles.repoIdent}>
                        <p className={styles.repoName}>
                            <span className='icon icon-branch' /> {repo.owner}/{repo.repo}
                        </p>
                        <p className={styles.repoMeta}>
                            {repo.defaultBranch && <span>branche {repo.defaultBranch}</span>}
                            {repo.lastSyncAt !== null && (
                                <span> · synchronisé {new Date(repo.lastSyncAt * 1000).toLocaleString('fr-FR')}</span>
                            )}
                            {repo.credentialId === null && (
                                <span className={styles.overdue}> · jeton retiré, synchronisation arrêtée</span>
                            )}
                            {repo.credentialId !== null && !repo.enabled && (
                                <span className={styles.overdue}> · synchronisation suspendue</span>
                            )}
                        </p>
                        {repo.lastSyncError && <p className={styles.error}>{repo.lastSyncError}</p>}
                    </div>
                </div>
                {canWrite && (
                    <div className={styles.actions}>
                        <Button
                            variant='secondary'
                            icon='refresh'
                            onClick={() => {
                                setSyncRequest((n) => n + 1);
                                onSyncNow();
                            }}
                            disabled={busy || syncing}
                        >
                            {syncing ? 'Synchronisation…' : 'Synchroniser'}
                        </Button>
                        <Button variant='secondary' icon='edit' onClick={onEdit} disabled={busy || syncing}>
                            Modifier
                        </Button>
                    </div>
                )}
            </header>

            <RepoView
                repo={repo}
                members={members}
                canWrite={canWrite}
                onSyncingChange={onSyncingChange}
                syncRequest={syncRequest}
            >
                {/*
                 * Les projets qui s'en servent, sous le graphe.
                 *
                 * C'est le second sens de l'interconnexion : depuis un projet on
                 * atteint son dépôt, et depuis un dépôt on retrouve d'un clic
                 * tous les projets qui l'utilisent. Masqué quand il n'y en a
                 * aucun — un panneau vide n'apprend rien.
                 */}
                {usage.length > 0 && (
                    <section className={styles.usage}>
                        <h3 className={styles.gitTitle}>
                            {usage.length} projet{usage.length > 1 ? 's' : ''}
                        </h3>
                        <ul className={styles.usageList}>
                            {usage.map((u) => (
                                <li key={u.projectId}>
                                    <button
                                        type='button'
                                        className={styles.usageItem}
                                        onClick={() => onOpenProject(u.projectId)}
                                    >
                                        <span className='icon icon-projects' />
                                        <span className={styles.gitItemName}>{u.title}</span>
                                        <span className={styles.status} data-status={u.status}>
                                            {STATUS_LABELS[u.status]}
                                        </span>
                                    </button>
                                </li>
                            ))}
                        </ul>
                    </section>
                )}
            </RepoView>
        </div>
    );
}

export default RepoDetail;

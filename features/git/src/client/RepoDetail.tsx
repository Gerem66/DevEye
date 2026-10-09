import { useCallback, useState } from 'react';
import type { MinimalUser } from '@deveye/types';
import { Button, FeatureSettingsButton, PlanPausedBadge, StatusBadge, StickyHeader } from 'deveye-sdk-client';
import type { GitRepo, GitRepoUsage } from '../contracts/domain';

import { PROJECT_STATUS_LABELS } from '@deveye/types';
import { RepoView } from './RepoView';
import styles from './style.module.css';

interface RepoDetailProps {
    repo: GitRepo;
    usage: GitRepoUsage[];
    members: readonly MinimalUser[];
    canWrite: boolean;
    busy: boolean;
    onBack: () => void;
    onSyncNow: () => void;
    /** Ouvre un projet qui utilise ce dépôt, dans la feature Projets. */
    onOpenProject: (projectId: number) => void;
}

/**
 * Un dépôt ouvert : son en-tête, ses projets, et son contenu. Ce contenu est
 * `RepoView`, partagé mot pour mot avec l'onglet Git d'un projet : c'est le même
 * dépôt, quelle que soit la porte par laquelle on entre.
 */
export function RepoDetail({
    repo,
    usage,
    members,
    canWrite,
    busy,
    onBack,
    onSyncNow,
    onOpenProject
}: RepoDetailProps) {
    // `RepoView` sonde l'avancement ; l'en-tête, lui, porte les boutons, qu'une
    // synchronisation en cours désactive : le contenu va être remplacé.
    const [syncing, setSyncing] = useState(false);
    const onSyncingChange = useCallback((v: boolean) => setSyncing(v), []);
    /** Chaque pression sur « Synchroniser » l'incrémente ; `RepoView` s'y remet à sonder. */
    const [syncRequest, setSyncRequest] = useState(0);

    return (
        <div className={styles.root}>
            <StickyHeader>
                <header className={styles.header}>
                    <div className={styles.detailHead}>
                        <Button variant='ghost' icon='arrow-left' onClick={onBack}>
                            Dépôts
                        </Button>
                        <div className={styles.repoIdent}>
                            <p className={styles.repoName}>
                                <span className='icon icon-branch' /> {repo.owner}/{repo.repo}
                                {repo.foreign && (
                                    <span title='Ce dépôt appartient à un autre espace qui le partage ici'>
                                        {' '}
                                        <StatusBadge tone='accent'>partagé</StatusBadge>
                                    </span>
                                )}
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
                                {repo.credentialId !== null && !repo.enabled && (
                                    <span className={styles.overdue}> · synchronisation suspendue</span>
                                )}
                                {repo.planPaused && (
                                    <>
                                        {' '}
                                        <PlanPausedBadge />
                                    </>
                                )}
                            </p>
                        </div>
                    </div>
                    <div className={styles.actions}>
                        {canWrite && (
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
                        )}
                        {/* Les réglages de ce dépôt, son jeton et sa suppression
                        compris (onglet Général). Le bouton se garde de lui-même,
                        sans section accessible il ne s'affiche pas. Supprimé ou
                        déplacé depuis la coquille, le dépôt n'est plus ici : la
                        fiche revient à la liste. */}
                        <FeatureSettingsButton
                            scope={{
                                kind: 'item',
                                feature: 'git',
                                itemId: String(repo.id),
                                itemLabel: `${repo.owner}/${repo.repo}`
                            }}
                            onGone={onBack}
                        />
                    </div>
                    {repo.lastSyncError && <p className={styles.error}>{repo.lastSyncError}</p>}
                </header>
            </StickyHeader>

            <RepoView
                repo={repo}
                members={members}
                canWrite={canWrite}
                onSyncingChange={onSyncingChange}
                syncRequest={syncRequest}
            >
                {/* L'autre sens de la liaison : depuis un dépôt, les projets qui
                    l'utilisent. Masqué quand il n'y en a aucun. */}
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
                                            {PROJECT_STATUS_LABELS[u.status]}
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

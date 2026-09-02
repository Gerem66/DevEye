import { useCallback, useState } from 'react';
import { Button, FeatureSettingsButton, openFeature, useResource, useWorkspaceMembers } from 'deveye-sdk-client';
import type { GitClientProvider } from '@deveye/types/sdk/client';

import { api } from './api';
import { RepoDialog } from './RepoDialog';
import { RepoView } from './RepoView';
import styles from './style.module.css';

/**
 * Ce que le module offre aux écrans de l'app (`GIT_CLIENT_PROVIDER`) : l'onglet
 * « Git » d'un projet compose la liste des dépôts de l'espace, un dépôt relié
 * montré en entier, et le dialogue d'ajout, sans importer le module.
 *
 * `LinkedRepo` est autonome : l'hôte ne lui tend qu'un identifiant et ne connaît
 * ni la forme d'un dépôt, ni ses commandes.
 */

interface LinkedRepoProps {
    repoId: number;
    canWrite: boolean;
    onUnlink: () => void;
}

/** Un dépôt du projet : son en-tête, et le contenu partagé avec la feature Git. */
function LinkedRepo({ repoId, canWrite, onUnlink }: LinkedRepoProps) {
    const members = useWorkspaceMembers();
    const { data, error } = useResource(
        'git.repo',
        () => api.send('git.repoGet', { repoId }),
        'Impossible de charger ce dépôt.',
        [repoId]
    );
    // `RepoView` sonde l'avancement ; l'en-tête, lui, porte les boutons, qu'une
    // synchronisation en cours désactive : le contenu va être remplacé.
    const [syncing, setSyncing] = useState(false);
    const onSyncingChange = useCallback((v: boolean) => setSyncing(v), []);
    const [syncRequest, setSyncRequest] = useState(0);

    if (!data) return <p className={error ? styles.error : styles.hint}>{error ?? 'Chargement…'}</p>;
    const { repo } = data;

    // Toujours encadré, même sur un dépôt unique : le cadre dit où finit ce que
    // l'onglet montre, sans quoi il se confond avec le fond de la popup.
    return (
        <section className={styles.repoBlockFramed}>
            <header className={styles.repoHead}>
                <div className={styles.repoIdent}>
                    {/* Un intitulé, et rien de plus : un titre qui navigue ne
                        s'annonce pas ; le geste est un bouton de la barre. */}
                    <p className={styles.repoName}>
                        <span className='icon icon-branch' aria-hidden='true' /> {repo.owner}/{repo.repo}
                    </p>
                    <p className={styles.repoMeta}>
                        {repo.defaultBranch && <span>branche {repo.defaultBranch}</span>}
                        {repo.lastSyncAt !== null && (
                            <span> · synchronisé {new Date(repo.lastSyncAt * 1000).toLocaleString('fr-FR')}</span>
                        )}
                        {repo.credentialId === null && (
                            <span className={styles.overdue}> · jeton retiré, synchronisation arrêtée</span>
                        )}
                        {repo.projectCount > 1 && (
                            <span>
                                {' '}
                                · partagé avec {repo.projectCount - 1} autre{repo.projectCount > 2 ? 's' : ''} projet
                                {repo.projectCount > 2 ? 's' : ''}
                            </span>
                        )}
                    </p>
                    {repo.lastSyncError && <p className={styles.error}>{repo.lastSyncError}</p>}
                </div>
                <div className={styles.actions}>
                    {canWrite && (
                        <Button
                            variant='secondary'
                            icon='refresh'
                            onClick={() => {
                                setSyncRequest((n) => n + 1);
                                void api.send('git.repoSyncNow', { repoId: repo.id });
                            }}
                            disabled={syncing}
                        >
                            {syncing ? 'Synchronisation…' : 'Synchroniser'}
                        </Button>
                    )}
                    {/* Les réglages du dépôt, les mêmes que sur sa fiche : son
                        jeton et sa suppression y vivent (onglet Général). */}
                    <FeatureSettingsButton
                        scope={{
                            kind: 'item',
                            feature: 'git',
                            itemId: String(repo.id),
                            itemLabel: `${repo.owner}/${repo.repo}`
                        }}
                    />

                    {/* Par la téléportation, garde d'accès comprise, et offert même
                        sans droit d'écriture : c'est une navigation. `openFeature`
                        écrit le chemin ; le module ne l'écrit jamais lui-même. */}
                    <Button variant='secondary' icon='chevrons-right' onClick={() => openFeature('git', repo.id)}>
                        Ouvrir Git
                    </Button>

                    {/* Destructeur, donc en bout de barre, loin de « Synchroniser ».
                        Confirmation et déliement sont à l'hôte, qui seul tient
                        le pointeur. */}
                    {canWrite && (
                        <Button variant='ghost' onClick={onUnlink} disabled={syncing}>
                            Délier
                        </Button>
                    )}
                </div>
            </header>

            <RepoView
                repo={repo}
                members={members}
                canWrite={canWrite}
                onSyncingChange={onSyncingChange}
                syncRequest={syncRequest}
            />
        </section>
    );
}

interface LinkedRepoDialogProps {
    open: boolean;
    onClose: () => void;
    onSaved: (repoId: number) => void;
}

/**
 * Le dialogue d'ajout de la feature, pas une copie : Projets relie ce qui vient
 * d'être ajouté. Un dépôt relié se règle par le bouton commun de `LinkedRepo`.
 */
function LinkedRepoDialog({ open, onClose, onSaved }: LinkedRepoDialogProps) {
    return <RepoDialog open={open} onClose={onClose} onSaved={onSaved} />;
}

export const clientProvider: GitClientProvider = {
    listRepos: async () =>
        (await api.send('git.repoList', {})).repos.map((r) => ({
            id: r.id,
            owner: r.owner,
            repo: r.repo,
            foreign: r.foreign
        })),
    LinkedRepo,
    RepoDialog: LinkedRepoDialog
};

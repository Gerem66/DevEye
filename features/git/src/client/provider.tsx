import { useCallback, useState } from 'react';
import { Button, invalidate, openFeature, useResource, useWorkspaceMembers } from 'deveye-sdk-client';
import type { GitClientProvider } from '@deveye/types/sdk/client';

import { api } from './api';
import { RepoDialog } from './RepoDialog';
import { RepoView } from './RepoView';
import styles from './style.module.css';

/**
 * Ce que le module offre aux écrans de l'app (`GIT_CLIENT_PROVIDER`) :
 * l'onglet « Git » d'un projet compose la liste des dépôts de l'espace, un
 * dépôt relié montré en entier, et le dialogue d'ajout, sans importer le
 * module.
 *
 * `LinkedRepo` est autonome, et c'est la différence avec l'ancien bloc que
 * Projets écrivait lui-même (`RepoBlock`, dans l'onglet) : l'hôte ne lui tend
 * qu'un identifiant, et le bloc charge son dépôt, suit les invalidations de
 * la feature et l'avancement de sa synchronisation, et porte son propre
 * dialogue de réglage. L'hôte ne connaît ni la forme d'un dépôt, ni ses
 * commandes.
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
    // `RepoView` sonde l'avancement ; l'en-tête, lui, porte les boutons. Tant
    // qu'une synchronisation tourne, ni « Synchroniser » ni « Modifier » n'ont
    // de sens : le contenu est déjà voilé et va être remplacé.
    const [syncing, setSyncing] = useState(false);
    const onSyncingChange = useCallback((v: boolean) => setSyncing(v), []);
    const [syncRequest, setSyncRequest] = useState(0);
    const [dialogOpen, setDialogOpen] = useState(false);

    if (!data) return <p className={error ? styles.error : styles.hint}>{error ?? 'Chargement…'}</p>;
    const { repo } = data;

    // Toujours encadré, y compris sur un dépôt unique.
    //
    // Le cadre ne servait qu'à *séparer* deux blocs, d'où la règle précédente
    // qui l'omettait quand il n'y avait rien à séparer. Mais il fait aussi
    // autre chose : il dit où finit ce que l'onglet montre. Sans lui, un dépôt
    // seul se confondait avec le fond de la popup, et l'onglet ne ressemblait
    // plus aux autres du même projet.
    return (
        <section className={styles.repoBlockFramed}>
            <header className={styles.repoHead}>
                <div className={styles.repoIdent}>
                    {/* Un intitulé, et rien de plus. Il menait au dépôt, mais
                        un titre qui navigue ne s'annonce pas : rien ne le
                        distinguait d'un texte, et il fallait le survoler pour
                        s'en apercevoir. Le geste est devenu un bouton de la
                        barre, comme dans les deux autres onglets. */}
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
                    {/* `!repo.foreign`, comme dans la fiche de la feature : le
                        jeton d'un dépôt se choisit parmi les clés de SON
                        espace, le serveur le refuse, l'écran ne le propose
                        donc pas. Synchroniser, lui, reste permis. */}
                    {canWrite && !repo.foreign && (
                        <Button variant='secondary' icon='edit' onClick={() => setDialogOpen(true)} disabled={syncing}>
                            Modifier
                        </Button>
                    )}

                    {/* Par la téléportation, comme partout : le chemin
                        `view:git l1:7` dit « ouvre la feature, et dedans,
                        ce dépôt-là », garde d'accès comprise. Offert même sans
                        droit d'écriture : c'est une navigation. `openFeature`
                        écrit le chemin ; le module ne l'écrit jamais lui-même. */}
                    <Button variant='secondary' icon='chevrons-right' onClick={() => openFeature('git', repo.id)}>
                        Ouvrir Git
                    </Button>

                    {/* Destructeur, donc en bout de barre et confirmé : il ne
                        doit pas côtoyer « Synchroniser », qu'on presse souvent.
                        La confirmation et le déliement sont à l'hôte, qui seul
                        tient le pointeur. */}
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

            {/* Le vrai dialogue de la feature Git, pas une copie : régler un
                dépôt depuis un projet ou depuis sa feature doit être le même
                geste, et une seconde implémentation divergerait au premier
                ajustement. */}
            <RepoDialog
                open={dialogOpen}
                repo={repo}
                onClose={() => setDialogOpen(false)}
                onSaved={() => {
                    setDialogOpen(false);
                    invalidate('git.list', 'git.repo', 'git.count');
                }}
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
 * Le dialogue de la feature, en mode ajout seulement : c'est le seul cas de
 * Projets, qui relie ce qui vient d'être ajouté. La modification passe par
 * `LinkedRepo`, qui tient le dépôt chargé.
 */
function LinkedRepoDialog({ open, onClose, onSaved }: LinkedRepoDialogProps) {
    return <RepoDialog open={open} repo={null} onClose={onClose} onSaved={onSaved} />;
}

export const clientProvider: GitClientProvider = {
    listRepos: async () =>
        (await api.send('git.repoList', {})).repos.map((r) => ({ id: r.id, owner: r.owner, repo: r.repo })),
    LinkedRepo,
    RepoDialog: LinkedRepoDialog
};

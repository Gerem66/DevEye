import { useCallback, useEffect, useState } from 'react';
import {
    Button,
    Dialog,
    humanizeError,
    invalidate,
    moduleClientProvider,
    useResourceVersion,
    useWorkspacePermissions,
    WsError
} from 'deveye-sdk-client';
import { api } from '../api';
import type { Project, ProjectLinkLabel } from '../../contracts/domain';
import { GIT_CLIENT_PROVIDER } from '@deveye/types/sdk';
import type { GitClientProvider, GitLinkedCandidate } from '@deveye/types/sdk/client';
import { LinkRepoDialog } from './LinkRepoDialog';
import { ForeignLinks } from '../ForeignLinks';
import styles from '../style.module.css';

interface GitProps {
    project: Project;
    canWrite: boolean;
}

/**
 * L'onglet Git d'un projet : les dépôts qu'il pointe. Le dépôt n'appartient pas
 * au projet, qui n'en tient qu'un pointeur ; tout l'affichage vient du bloc du
 * module (`GIT_CLIENT_PROVIDER`), le même contenu que la feature Git, sans que
 * cet écran importe le module. Un projet en pointe plusieurs (client, serveur,
 * contrats), chacun dans un cadre qui le sépare du suivant.
 *
 * Lire ces dépôts relève du droit `git`, pas de `projects` : sans lui, ou sans
 * le module, les dépôts se listent en identifiants nus.
 */
export function Git({ project, canWrite }: GitProps) {
    const permissions = useWorkspacePermissions();
    const provider = moduleClientProvider<GitClientProvider>(GIT_CLIENT_PROVIDER);
    const canReadGit = permissions.canFeature('git');
    const canWriteGit = permissions.canFeature('git', 'write');

    const [repoIds, setRepoIds] = useState<number[]>([]);
    /** Les dépôts nommés par le serveur : ce qu'un projet projeté en montre. */
    const [labels, setLabels] = useState<readonly ProjectLinkLabel[]>([]);
    /** Les dépôts de l'espace, pour nommer celui qu'on délie. */
    const [candidates, setCandidates] = useState<readonly GitLinkedCandidate[]>([]);
    const [loaded, setLoaded] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [linkOpen, setLinkOpen] = useState(false);
    /** Le dépôt qu'on s'apprête à délier ; `null` = aucune confirmation ouverte. */
    const [unlinking, setUnlinking] = useState<number | null>(null);

    const boardVersion = useResourceVersion('projects.board');
    const listVersion = useResourceVersion('git.list');
    const guarded = project.securityTier === 'guarded';
    const foreign = project.foreign;

    const load = useCallback(async () => {
        if (guarded) {
            setLoaded(true);
            return;
        }
        try {
            const link = await api.send('projects.repoList', { projectId: project.id });
            setRepoIds(link.repoIds);
            setLabels(link.labels);
            setError(null);
        } catch (e) {
            setError(humanizeError(e, 'Impossible de charger les dépôts liés.'));
        } finally {
            setLoaded(true);
        }
    }, [project.id, guarded]);

    useEffect(() => {
        void load();
    }, [load, boardVersion]);

    // Le catalogue, pour nommer le dépôt qu'on délie. Le détail relève de la
    // feature Git : sans le droit (ou sans le module), on s'arrête aux
    // pointeurs plutôt que d'encaisser un refus, qui n'est pas une erreur à
    // afficher.
    useEffect(() => {
        if (guarded || foreign || !canReadGit || !provider) {
            setCandidates([]);
            return;
        }
        let alive = true;
        void (async () => {
            try {
                const listed = await provider.listRepos();
                if (alive) setCandidates(listed);
            } catch (e) {
                if (alive) setCandidates([]);
                if (!(e instanceof WsError && e.code === 'forbidden')) {
                    setError(humanizeError(e, 'Impossible de charger les dépôts de l’espace.'));
                }
            }
        })();
        return () => {
            alive = false;
        };
    }, [guarded, foreign, canReadGit, provider, listVersion]);

    const unlink = async (repoId: number) => {
        setBusy(true);
        try {
            await api.send('projects.repoUnlink', { projectId: project.id, repoId });
            setUnlinking(null);
            invalidate('projects.board', 'git.list');
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

    // Projeté depuis un autre espace : les dépôts se nomment, sans le bloc du
    // module ni ses gestes (voir `ForeignLinks`).
    if (foreign) {
        return (
            <div className={styles.linkedRepos}>
                {error && <p className={styles.error}>{error}</p>}
                {!provider && <p className={styles.hint}>Le module Git n’est pas installé.</p>}
                <ForeignLinks labels={labels} empty='Aucun dépôt relié à ce projet.' />
            </div>
        );
    }

    const unlinkingCandidate = unlinking === null ? null : (candidates.find((c) => c.id === unlinking) ?? null);
    const unlinkingName = unlinkingCandidate ? `${unlinkingCandidate.owner}/${unlinkingCandidate.repo}` : null;

    return (
        <div className={styles.linkedRepos}>
            {error && <p className={styles.error}>{error}</p>}
            {!provider && <p className={styles.hint}>Le module Git n’est pas installé.</p>}

            {repoIds.length === 0 && <p className={styles.empty}>Aucun dépôt relié à ce projet.</p>}

            {/* Le pointeur existe mais le dépôt n'est pas lisible : c'est un
                manque de droit, pas une erreur. Le dire plutôt que d'afficher
                un écran vide qui se lirait comme un bug. */}
            {repoIds.length > 0 && !canReadGit && (
                <p className={styles.empty}>
                    Ce projet est relié à {repoIds.length} dépôt{repoIds.length > 1 ? 's' : ''}, mais votre rôle n’ouvre
                    pas la feature Git.
                </p>
            )}

            {canReadGit &&
                repoIds.map((id) =>
                    provider ? (
                        <provider.LinkedRepo
                            key={id}
                            repoId={id}
                            canWrite={canWrite && canWriteGit}
                            onUnlink={() => setUnlinking(id)}
                        />
                    ) : (
                        // Sans le module, le serveur ne rend qu'un identifiant
                        // nu : la ligne reste là, avec son « Délier », plutôt
                        // que de disparaître.
                        <div key={id} className={styles.linkedBare}>
                            <span className={styles.hint}>Dépôt #{id}</span>
                            {canWrite && canWriteGit && (
                                <Button variant='ghost' icon='x' onClick={() => setUnlinking(id)} disabled={busy}>
                                    Délier
                                </Button>
                            )}
                        </div>
                    )
                )}

            {/* Toujours en bas, même quand un dépôt est déjà relié : on peut en
                ajouter autant qu'on veut, et c'est le geste suivant naturel une
                fois qu'on a fini de lire ce qui précède. */}
            {canWrite && canWriteGit && provider && (
                <div className={styles.addRow}>
                    <Button icon='add' onClick={() => setLinkOpen(true)}>
                        Ajouter un dépôt
                    </Button>
                </div>
            )}

            {canWrite && !canWriteGit && (
                <span className={styles.hintCentered}>
                    Votre rôle ne permet pas de modifier les dépôts de cet espace.
                </span>
            )}

            <LinkRepoDialog
                open={linkOpen}
                projectId={project.id}
                linkedRepoIds={repoIds}
                onClose={() => setLinkOpen(false)}
                onSaved={() => {
                    setLinkOpen(false);
                    invalidate('projects.board', 'git.list', 'git.count');
                }}
            />

            <Dialog
                open={unlinking !== null}
                onClose={() => setUnlinking(null)}
                title='Délier ce dépôt ?'
                width={460}
                onSubmit={() => unlinking !== null && void unlink(unlinking)}
                footer={
                    <>
                        <Button variant='secondary' onClick={() => setUnlinking(null)} disabled={busy}>
                            Annuler
                        </Button>
                        <Button
                            variant='danger'
                            disabled={busy}
                            onClick={() => unlinking !== null && void unlink(unlinking)}
                        >
                            Délier
                        </Button>
                    </>
                }
            >
                <p className={styles.hint}>
                    <strong>{unlinkingName ?? 'Ce dépôt'}</strong> quitte ce projet. Le dépôt lui-même, son historique
                    et les autres projets qui l’utilisent ne sont pas touchés.
                </p>
            </Dialog>
        </div>
    );
}

export default Git;

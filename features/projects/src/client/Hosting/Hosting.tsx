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
import { HOSTING_CLIENT_PROVIDER } from '@deveye/types/sdk';
import type { HostingClientProvider, HostingLinkedCandidate } from '@deveye/types/sdk/client';
import { LinkPackDialog } from './LinkPackDialog';
import { ForeignLinks } from '../ForeignLinks';
import styles from '../style.module.css';

interface HostingProps {
    project: Project;
    canWrite: boolean;
}

/**
 * L'onglet « Dossiers » d'un projet : les dossiers d'Hébergement qu'il
 * rattache. Le dossier n'appartient pas au projet, qui n'en tient qu'un
 * pointeur ; l'affichage vient du bloc du module (`HOSTING_CLIENT_PROVIDER`),
 * module privé que cet écran n'importe pas.
 *
 * Lire un dossier relève du droit `x-hosting`, pas de `projects` : sans lui, ou
 * sans le module, les dossiers se listent en identifiants nus.
 */
export function Hosting({ project, canWrite }: HostingProps) {
    const permissions = useWorkspacePermissions();
    const provider = moduleClientProvider<HostingClientProvider>(HOSTING_CLIENT_PROVIDER);
    const canReadHosting = permissions.canFeature('x-hosting');
    const canWriteHosting = permissions.canFeature('x-hosting', 'write');

    const [linkedIds, setLinkedIds] = useState<number[]>([]);
    /** Les dossiers nommés par le serveur : ce qu'un projet projeté en montre. */
    const [labels, setLabels] = useState<readonly ProjectLinkLabel[]>([]);
    /** Les dossiers de l'espace, pour nommer celui qu'on délie. */
    const [candidates, setCandidates] = useState<readonly HostingLinkedCandidate[]>([]);
    const [loaded, setLoaded] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [linkOpen, setLinkOpen] = useState(false);
    /** Le dossier qu'on s'apprête à délier ; `null` = aucune confirmation ouverte. */
    const [unlinking, setUnlinking] = useState<number | null>(null);

    const boardVersion = useResourceVersion('projects.board');
    const listVersion = useResourceVersion('x-hosting.list');
    const guarded = project.securityTier === 'guarded';
    const foreign = project.foreign;

    const load = useCallback(async () => {
        if (guarded) {
            setLoaded(true);
            return;
        }
        try {
            const res = await api.send('projects.hostingList', { projectId: project.id });
            setLinkedIds(res.packIds);
            setLabels(res.labels);
            setError(null);
        } catch (e) {
            setError(humanizeError(e, 'Impossible de charger les dossiers liés.'));
        } finally {
            setLoaded(true);
        }
    }, [project.id, guarded]);

    useEffect(() => {
        void load();
    }, [load, boardVersion]);

    // Le catalogue, pour nommer le dossier qu'on délie. Sans le droit (ou sans
    // le module), on s'arrête aux pointeurs plutôt que d'encaisser un refus.
    useEffect(() => {
        if (guarded || foreign || !canReadHosting || !provider) {
            setCandidates([]);
            return;
        }
        let alive = true;
        void (async () => {
            try {
                const listed = await provider.listPacks();
                if (alive) setCandidates(listed);
            } catch (e) {
                if (alive) setCandidates([]);
                if (!(e instanceof WsError && e.code === 'forbidden')) {
                    setError(humanizeError(e, 'Impossible de charger les dossiers de l’espace.'));
                }
            }
        })();
        return () => {
            alive = false;
        };
    }, [guarded, foreign, canReadHosting, provider, listVersion]);

    const unlink = async (packId: number) => {
        setBusy(true);
        try {
            await api.send('projects.hostingUnlink', { projectId: project.id, packId });
            setUnlinking(null);
            invalidate('projects.board', 'x-hosting.list');
        } catch (e) {
            setError(humanizeError(e, 'Le déliement a échoué.'));
        } finally {
            setBusy(false);
        }
    };

    if (guarded) {
        return (
            <p className={styles.empty}>
                Ce projet est confidentiel : il ne peut pas être relié à un dossier. Les dossiers vivent sous la clé de
                l’espace, et leurs adresses les servent sans session.
            </p>
        );
    }

    if (!loaded) return <p className={styles.empty}>Chargement…</p>;

    // Projeté depuis un autre espace : les dossiers se nomment, sans le bloc du
    // module ni ses gestes (voir `ForeignLinks`).
    if (foreign) {
        return (
            <div className={styles.linkedSites}>
                {error && <p className={styles.error}>{error}</p>}
                {!provider && <p className={styles.hint}>Le module Hébergement n’est pas installé.</p>}
                <ForeignLinks labels={labels} empty='Aucun dossier relié à ce projet.' />
            </div>
        );
    }

    const unlinkingName = unlinking === null ? null : (candidates.find((c) => c.id === unlinking)?.name ?? null);

    return (
        <div className={styles.linkedSites}>
            {error && <p className={styles.error}>{error}</p>}
            {!provider && <p className={styles.hint}>Le module Hébergement n’est pas installé.</p>}

            {linkedIds.length === 0 && <p className={styles.empty}>Aucun dossier relié à ce projet.</p>}

            {linkedIds.length > 0 && !canReadHosting && (
                <p className={styles.empty}>
                    Ce projet rattache {linkedIds.length} dossier{linkedIds.length > 1 ? 's' : ''}, mais votre rôle
                    n’ouvre pas la feature « Hébergement ».
                </p>
            )}

            {canReadHosting &&
                linkedIds.map((id) =>
                    provider ? (
                        <provider.LinkedPack
                            key={id}
                            packId={id}
                            canWrite={canWrite && canWriteHosting}
                            onUnlink={() => setUnlinking(id)}
                        />
                    ) : (
                        // Sans le module, le serveur ne rend qu'un identifiant
                        // nu : la ligne reste là, avec son « Délier », plutôt
                        // que de disparaître.
                        <div key={id} className={styles.linkedBare}>
                            <span className={styles.hint}>Dossier #{id}</span>
                            {canWrite && (
                                <Button variant='ghost' icon='x' onClick={() => setUnlinking(id)} disabled={busy}>
                                    Délier
                                </Button>
                            )}
                        </div>
                    )
                )}

            {canWrite && canWriteHosting && provider && (
                <div className={styles.addRow}>
                    <Button icon='add' onClick={() => setLinkOpen(true)}>
                        Ajouter un dossier
                    </Button>
                </div>
            )}

            {canWrite && !canWriteHosting && (
                <span className={styles.hintCentered}>
                    Votre rôle ne permet pas de modifier les dossiers de cet espace.
                </span>
            )}

            <LinkPackDialog
                open={linkOpen}
                projectId={project.id}
                linkedIds={linkedIds}
                onClose={() => setLinkOpen(false)}
                onSaved={() => {
                    setLinkOpen(false);
                    invalidate('projects.board', 'x-hosting.list', 'x-hosting.count');
                }}
            />

            <Dialog
                open={unlinking !== null}
                onClose={() => setUnlinking(null)}
                title='Délier ce dossier ?'
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
                    <strong>{unlinkingName ?? 'Ce dossier'}</strong> quitte ce projet. Le dossier, ses fichiers, ses
                    adresses et les autres projets qui le rattachent ne sont pas touchés.
                </p>
            </Dialog>
        </div>
    );
}

export default Hosting;

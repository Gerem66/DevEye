import { useCallback, useEffect, useState } from 'react';
import {
    Button,
    Dialog,
    ErrorNote,
    errorNote,
    invalidate,
    moduleClientProvider,
    useResourceVersion,
    useWorkspacePermissions,
    WsError,
    type ErrorNoteInput
} from 'deveye-sdk-client';
import { api } from '../api';
import type { Project, ProjectLinkLabel } from '../../contracts/domain';
import { APPSTORES_CLIENT_PROVIDER } from '@deveye/types/sdk';
import type { AppStoresClientProvider, AppStoresLinkedCandidate } from '@deveye/types/sdk/client';
import { LinkAppDialog } from './LinkAppDialog';
import { ForeignLinks } from '../ForeignLinks';
import styles from '../style.module.css';

interface AppStoresProps {
    project: Project;
    canWrite: boolean;
}

/**
 * L'onglet « Stores » d'un projet : les apps qu'il rattache. L'app n'appartient
 * pas au projet, qui n'en tient qu'un pointeur ; l'affichage vient du bloc du
 * module (`APPSTORES_CLIENT_PROVIDER`).
 *
 * Lire une app relève du droit `appstores`, pas de `projects` : sans lui, ou
 * sans le module, les apps se listent en identifiants nus.
 */
export function AppStores({ project, canWrite }: AppStoresProps) {
    const permissions = useWorkspacePermissions();
    const provider = moduleClientProvider<AppStoresClientProvider>(APPSTORES_CLIENT_PROVIDER);
    const canReadApps = permissions.canFeature('appstores');
    const canWriteApps = permissions.canFeature('appstores', 'write');

    const [linkedIds, setLinkedIds] = useState<number[]>([]);
    /** Les apps nommées par le serveur : ce qu'un projet projeté en montre. */
    const [labels, setLabels] = useState<readonly ProjectLinkLabel[]>([]);
    /** Les apps de l'espace, pour nommer celle qu'on délie. */
    const [candidates, setCandidates] = useState<readonly AppStoresLinkedCandidate[]>([]);
    const [loaded, setLoaded] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<ErrorNoteInput | null>(null);
    const [linkOpen, setLinkOpen] = useState(false);
    /** L'app qu'on s'apprête à délier ; `null` = aucune confirmation ouverte. */
    const [unlinking, setUnlinking] = useState<number | null>(null);
    /** L'échec du déliement, dit dans la confirmation qui reste ouverte. */
    const [unlinkError, setUnlinkError] = useState<ErrorNoteInput | null>(null);

    const boardVersion = useResourceVersion('projects.board');
    const listVersion = useResourceVersion('appstores.list');
    const guarded = project.securityTier === 'guarded';
    const foreign = project.foreign;

    const load = useCallback(async () => {
        if (guarded) {
            setLoaded(true);
            return;
        }
        try {
            const res = await api.send('projects.appstoresList', { projectId: project.id });
            setLinkedIds(res.appIds);
            setLabels(res.labels);
            setError(null);
        } catch (e) {
            setError(errorNote(e, 'Impossible de charger les apps liées.'));
        } finally {
            setLoaded(true);
        }
    }, [project.id, guarded]);

    useEffect(() => {
        void load();
    }, [load, boardVersion]);

    // Le catalogue, pour nommer l'app qu'on délie. Sans le droit (ou sans le
    // module), on s'arrête aux pointeurs plutôt que d'encaisser un refus.
    useEffect(() => {
        if (guarded || foreign || !canReadApps || !provider) {
            setCandidates([]);
            return;
        }
        let alive = true;
        void (async () => {
            try {
                const listed = await provider.listApps();
                if (alive) setCandidates(listed);
            } catch (e) {
                if (alive) setCandidates([]);
                if (!(e instanceof WsError && e.code === 'forbidden')) {
                    setError(errorNote(e, 'Impossible de charger les apps de l’espace.'));
                }
            }
        })();
        return () => {
            alive = false;
        };
    }, [guarded, foreign, canReadApps, provider, listVersion]);

    const unlink = async (appId: number) => {
        setBusy(true);
        setUnlinkError(null);
        try {
            await api.send('projects.appstoresUnlink', { projectId: project.id, appId });
            setUnlinking(null);
            invalidate('projects.board', 'appstores.list');
        } catch (e) {
            setUnlinkError(errorNote(e, 'Le déliement a échoué.'));
        } finally {
            setBusy(false);
        }
    };

    const closeUnlink = () => {
        setUnlinking(null);
        setUnlinkError(null);
    };

    if (guarded) {
        return (
            <p className={styles.empty}>
                Ce projet est confidentiel : il ne peut pas être relié à une app. Les apps vivent sous la clé de
                l’espace, et leur synchronisation tourne sans session.
            </p>
        );
    }

    if (!loaded) return <p className={styles.empty}>Chargement…</p>;

    // Projeté depuis un autre espace : les apps se nomment, sans le bloc du
    // module ni ses gestes (voir `ForeignLinks`).
    if (foreign) {
        return (
            <div className={styles.linkedSites}>
                <ErrorNote note={error} />
                {!provider && <p className={styles.hint}>Le module Stores n’est pas installé.</p>}
                <ForeignLinks labels={labels} empty='Aucune app reliée à ce projet.' />
            </div>
        );
    }

    const unlinkingName = unlinking === null ? null : (candidates.find((c) => c.id === unlinking)?.name ?? null);

    return (
        <div className={styles.linkedSites}>
            <ErrorNote note={error} />
            {!provider && <p className={styles.hint}>Le module Stores n’est pas installé.</p>}

            {linkedIds.length === 0 && <p className={styles.empty}>Aucune app reliée à ce projet.</p>}

            {linkedIds.length > 0 && !canReadApps && (
                <p className={styles.empty}>
                    Ce projet rattache {linkedIds.length} app{linkedIds.length > 1 ? 's' : ''}, mais votre rôle n’ouvre
                    pas la feature « Stores ».
                </p>
            )}

            {canReadApps &&
                linkedIds.map((id) =>
                    provider ? (
                        <provider.LinkedApp
                            key={id}
                            appId={id}
                            canWrite={canWrite && canWriteApps}
                            onUnlink={() => setUnlinking(id)}
                        />
                    ) : (
                        // Sans le module, le serveur ne rend qu'un identifiant
                        // nu : la ligne reste là, avec son « Délier », plutôt
                        // que de disparaître.
                        <div key={id} className={styles.linkedBare}>
                            <span className={styles.hint}>App #{id}</span>
                            {canWrite && (
                                <Button variant='ghost' icon='x' onClick={() => setUnlinking(id)} disabled={busy}>
                                    Délier
                                </Button>
                            )}
                        </div>
                    )
                )}

            {canWrite && canWriteApps && provider && (
                <div className={styles.addRow}>
                    <Button icon='add' onClick={() => setLinkOpen(true)}>
                        Ajouter une app
                    </Button>
                </div>
            )}

            {canWrite && !canWriteApps && (
                <span className={styles.hintCentered}>
                    Votre rôle ne permet pas de modifier les apps de cet espace.
                </span>
            )}

            <LinkAppDialog
                open={linkOpen}
                projectId={project.id}
                linkedIds={linkedIds}
                onClose={() => setLinkOpen(false)}
                onSaved={() => {
                    setLinkOpen(false);
                    invalidate('projects.board', 'appstores.list', 'appstores.count');
                }}
            />

            <Dialog
                open={unlinking !== null}
                onClose={closeUnlink}
                title='Délier cette app ?'
                width={460}
                onSubmit={() => unlinking !== null && void unlink(unlinking)}
                footer={
                    <>
                        <Button variant='secondary' onClick={closeUnlink} disabled={busy}>
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
                    <strong>{unlinkingName ?? 'Cette app'}</strong> quitte ce projet. L’app, ses chiffres, ses avis et
                    les autres projets qui la rattachent ne sont pas touchés.
                </p>
                <ErrorNote note={unlinkError} />
            </Dialog>
        </div>
    );
}

export default AppStores;

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
import type { Project } from '../../contracts/domain';
import { DATABASE_CLIENT_PROVIDER } from '@deveye/types/sdk';
import type { DatabaseClientProvider, DatabaseLinkedCandidate } from '@deveye/types/sdk/client';
import { LinkDatabaseDialog } from './LinkDatabaseDialog';
import styles from '../style.module.css';

interface DatabasesProps {
    project: Project;
    canWrite: boolean;
}

/**
 * L'onglet « Bases de données » d'un projet : celles qu'il pointe.
 *
 * Enveloppe mince, exactement comme l'onglet Git. **La base n'appartient pas au
 * projet** : elle vit dans sa feature, avec ses alertes et son relevé, et
 * plusieurs projets peuvent viser la même. Cet onglet ne possède qu'un pointeur
 * (`projects.databaseList` / `databaseLink` / `databaseUnlink`) et délègue tout
 * l'affichage au module Bases de données, par son contrat client
 * (`DATABASE_CLIENT_PROVIDER`) : cet écran n'importe pas le module.
 *
 * Le contenu est rendu **ici**, et non derrière un renvoi vers la feature : une
 * base reliée à un projet se consulte depuis le projet, sinon la liaison ne sert
 * qu'à ranger. Chaque base reçoit un cadre discret, sans lequel deux jeux de
 * statistiques, d'alertes et de tables s'enchaîneraient sans qu'on sache où
 * l'un finit ; c'est le bloc du module (`LinkedDatabase`), qui charge sa base
 * lui-même et suit les invalidations de la feature.
 *
 * Corollaire à connaître : lire une base relève du droit `database`, pas de
 * `projects`. Un membre qui a l'un sans l'autre voit qu'il y a des bases
 * rattachées sans pouvoir les ouvrir, et l'écran le dit. Module absent : même
 * lecture, des identifiants nus, et une phrase qui le dit.
 */
export function Databases({ project, canWrite }: DatabasesProps) {
    const permissions = useWorkspacePermissions();
    const provider = moduleClientProvider<DatabaseClientProvider>(DATABASE_CLIENT_PROVIDER);
    const canReadDb = permissions.canFeature('database');
    const canWriteDb = permissions.canFeature('database', 'write');

    const [linkedIds, setLinkedIds] = useState<number[]>([]);
    /** Les bases de l'espace, pour nommer celle qu'on délie. */
    const [candidates, setCandidates] = useState<readonly DatabaseLinkedCandidate[]>([]);
    const [loaded, setLoaded] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [linkOpen, setLinkOpen] = useState(false);
    /** La base qu'on s'apprête à délier ; `null` = aucune confirmation ouverte. */
    const [unlinking, setUnlinking] = useState<number | null>(null);

    const boardVersion = useResourceVersion('projects.board');
    const listVersion = useResourceVersion('database.list');
    const guarded = project.securityTier === 'guarded';

    const load = useCallback(async () => {
        if (guarded) {
            setLoaded(true);
            return;
        }
        try {
            const res = await api.send('projects.databaseList', { projectId: project.id });
            setLinkedIds(res.databaseIds);
            setError(null);
        } catch (e) {
            setError(humanizeError(e, 'Impossible de charger les bases liées.'));
        } finally {
            setLoaded(true);
        }
    }, [project.id, guarded]);

    useEffect(() => {
        void load();
    }, [load, boardVersion]);

    // Le catalogue, pour nommer la base qu'on délie. Le détail relève de la
    // feature Bases : sans le droit (ou sans le module), on s'arrête aux
    // pointeurs plutôt que d'encaisser un refus, qui n'est pas une erreur à
    // afficher.
    useEffect(() => {
        if (guarded || !canReadDb || !provider) {
            setCandidates([]);
            return;
        }
        let alive = true;
        void (async () => {
            try {
                const listed = await provider.listDatabases();
                if (alive) setCandidates(listed);
            } catch (e) {
                if (alive) setCandidates([]);
                if (!(e instanceof WsError && e.code === 'forbidden')) {
                    setError(humanizeError(e, 'Impossible de charger les bases de l’espace.'));
                }
            }
        })();
        return () => {
            alive = false;
        };
    }, [guarded, canReadDb, provider, listVersion]);

    const unlink = async (databaseId: number) => {
        setBusy(true);
        try {
            await api.send('projects.databaseUnlink', { projectId: project.id, databaseId });
            setUnlinking(null);
            invalidate('projects.board', 'database.list');
        } catch (e) {
            setError(humanizeError(e, 'Le déliement a échoué.'));
        } finally {
            setBusy(false);
        }
    };

    if (guarded) {
        return (
            <p className={styles.empty}>
                Ce projet est confidentiel : il ne peut pas être relié à une base de données. Les bases vivent sous la
                clé de l’espace, et leur relevé tourne sans session.
            </p>
        );
    }

    if (!loaded) return <p className={styles.empty}>Chargement…</p>;

    const unlinkingName = unlinking === null ? null : (candidates.find((c) => c.id === unlinking)?.name ?? null);

    return (
        <div className={styles.linkedDatabases}>
            {error && <p className={styles.error}>{error}</p>}
            {!provider && <p className={styles.hint}>Le module Bases de données n’est pas installé.</p>}

            {linkedIds.length === 0 && <p className={styles.empty}>Aucune base reliée à ce projet.</p>}

            {linkedIds.length > 0 && !canReadDb && (
                <p className={styles.empty}>
                    Ce projet est relié à {linkedIds.length} base{linkedIds.length > 1 ? 's' : ''}, mais votre rôle
                    n’ouvre pas la feature « Bases de données ».
                </p>
            )}

            {canReadDb &&
                linkedIds.map((id) =>
                    provider ? (
                        <provider.LinkedDatabase
                            key={id}
                            databaseId={id}
                            canWrite={canWrite && canWriteDb}
                            onUnlink={() => setUnlinking(id)}
                        />
                    ) : (
                        // Sans le module, le serveur ne rend qu'un identifiant
                        // nu : la ligne reste là, avec son « Délier », plutôt
                        // que de disparaître.
                        <div key={id} className={styles.linkedBare}>
                            <span className={styles.hint}>Base #{id}</span>
                            {canWrite && canWriteDb && (
                                <Button variant='ghost' icon='x' onClick={() => setUnlinking(id)} disabled={busy}>
                                    Délier
                                </Button>
                            )}
                        </div>
                    )
                )}

            {/* Toujours en bas, même quand une base est déjà reliée : on peut en
                ajouter autant qu'on veut. */}
            {canWrite && canWriteDb && provider && (
                <div className={styles.addRow}>
                    <Button icon='add' onClick={() => setLinkOpen(true)}>
                        Ajouter une base
                    </Button>
                </div>
            )}

            {canWrite && !canWriteDb && (
                <span className={styles.hintCentered}>
                    Votre rôle ne permet pas de modifier les bases de données de cet espace.
                </span>
            )}

            <LinkDatabaseDialog
                open={linkOpen}
                projectId={project.id}
                linkedIds={linkedIds}
                onClose={() => setLinkOpen(false)}
                onSaved={() => {
                    setLinkOpen(false);
                    invalidate('projects.board', 'database.list', 'database.count');
                }}
            />

            <Dialog
                open={unlinking !== null}
                onClose={() => setUnlinking(null)}
                title='Délier cette base ?'
                width={460}
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
                    <strong>{unlinkingName ?? 'Cette base'}</strong> quitte ce projet. La base elle-même, ses alertes et
                    les autres projets qui l’utilisent ne sont pas touchés.
                </p>
            </Dialog>
        </div>
    );
}

export default Databases;

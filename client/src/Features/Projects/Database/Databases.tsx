import { useCallback, useEffect, useState } from 'react';
import type { Database, DatabaseAlert, DatabaseProbe, Project } from 'deveye-types';
import { Button, Dialog } from '@/Components';
import { ws } from '@/api/ws';
import { invalidate, useResourceVersion } from '@/stores/invalidation';
import { useWorkspacePermissions } from '@/stores/workspace';
import { DatabaseDialog } from '@/Features/Database/DatabaseDialog';
import { DatabaseHeader } from '@/Features/Database/DatabaseHeader';
import { DatabaseView } from '@/Features/Database/DatabaseView';
import dbStyles from '@/Features/Database/style.module.css';
import { humanizeError } from '../api';
import { LinkDatabaseDialog } from './LinkDatabaseDialog';
import styles from '../style.module.css';

interface DatabasesProps {
    project: Project;
    canWrite: boolean;
}

/** Ce qu'une base ouverte dans cet onglet porte avec elle. */
interface Linked {
    database: Database;
    alerts: DatabaseAlert[];
}

/**
 * L'onglet « Bases de données » d'un projet : celles qu'il pointe.
 *
 * Enveloppe mince, exactement comme l'onglet Git. **La base n'appartient pas au
 * projet** : elle vit dans sa feature, avec ses alertes et son relevé, et
 * plusieurs projets peuvent viser la même. Cet onglet ne possède qu'un pointeur
 * (`project.databaseList` / `databaseLink` / `databaseUnlink`) et délègue tout
 * l'affichage à `DatabaseView`, le composant de la feature.
 *
 * Le contenu est rendu **ici**, et non derrière un renvoi vers la feature : une
 * base reliée à un projet se consulte depuis le projet, sinon la liaison ne sert
 * qu'à ranger. Au-delà de la première, chaque base reçoit un cadre discret —
 * sans lui, deux jeux de statistiques, d'alertes et de tables s'enchaîneraient
 * sans qu'on sache où l'un finit.
 *
 * Corollaire à connaître : lire une base relève du droit `database`, pas de
 * `projects`. Un membre qui a l'un sans l'autre voit qu'il y a des bases
 * rattachées sans pouvoir les ouvrir, et l'écran le dit.
 */
export function Databases({ project, canWrite }: DatabasesProps) {
    const permissions = useWorkspacePermissions();
    const canReadDb = permissions.canFeature('database');
    const canWriteDb = permissions.canFeature('database', 'write');

    const [linkedIds, setLinkedIds] = useState<number[]>([]);
    const [linked, setLinked] = useState<Linked[]>([]);
    const [loaded, setLoaded] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [linkOpen, setLinkOpen] = useState(false);
    const [unlinking, setUnlinking] = useState<Database | null>(null);

    const boardVersion = useResourceVersion('project.board');
    const dbVersion = useResourceVersion('database.detail');
    const guarded = project.securityTier === 'guarded';

    const load = useCallback(async () => {
        if (guarded) {
            setLoaded(true);
            return;
        }
        try {
            const res = await ws.send('project.databaseList', { projectId: project.id });
            setLinkedIds(res.databaseIds);
            // Le détail relève de la feature Bases : sans le droit, on s'arrête
            // aux pointeurs plutôt que d'encaisser un refus.
            setLinked(
                canReadDb
                    ? (await Promise.all(res.databaseIds.map((id) => ws.send('database.get', { databaseId: id })))).map(
                          (r) => ({ database: r.database, alerts: r.alerts })
                      )
                    : []
            );
            setError(null);
        } catch (e) {
            setError(humanizeError(e, 'Impossible de charger les bases liées.'));
        } finally {
            setLoaded(true);
        }
    }, [project.id, guarded, canReadDb]);

    useEffect(() => {
        void load();
    }, [load, boardVersion, dbVersion]);

    const unlink = async (databaseId: number) => {
        setBusy(true);
        try {
            await ws.send('project.databaseUnlink', { projectId: project.id, databaseId });
            setUnlinking(null);
            invalidate('project.board', 'database.list');
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

    return (
        <div className={dbStyles.root}>
            {error && <p className={styles.error}>{error}</p>}

            {linkedIds.length === 0 && <p className={styles.empty}>Aucune base reliée à ce projet.</p>}

            {linkedIds.length > 0 && !canReadDb && (
                <p className={styles.empty}>
                    Ce projet est relié à {linkedIds.length} base{linkedIds.length > 1 ? 's' : ''}, mais votre rôle
                    n’ouvre pas la feature « Bases de données ».
                </p>
            )}

            {linked.map((item) => (
                <DatabaseBlock
                    key={item.database.id}
                    database={item.database}
                    alerts={item.alerts}
                    canWrite={canWrite && canWriteDb}
                    // Le cadre n'apparaît qu'à partir de deux : sur une base
                    // unique il n'aurait rien à séparer.
                    framed={linked.length > 1}
                    onUnlink={() => setUnlinking(item.database)}
                />
            ))}

            {/* Toujours en bas, même quand une base est déjà reliée : on peut en
                ajouter autant qu'on veut. */}
            {canWrite && canWriteDb && (
                <div className={dbStyles.addRow}>
                    <Button icon='add' onClick={() => setLinkOpen(true)}>
                        Ajouter une base
                    </Button>
                </div>
            )}

            {canWrite && !canWriteDb && (
                <span className={dbStyles.hint}>
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
                    invalidate('project.board', 'database.list', 'database.count');
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
                        <Button variant='danger' disabled={busy} onClick={() => unlinking && void unlink(unlinking.id)}>
                            Délier
                        </Button>
                    </>
                }
            >
                <p className={styles.hint}>
                    {unlinking && (
                        <>
                            <strong>{unlinking.name}</strong> quitte ce projet. La base elle-même, ses alertes et les
                            autres projets qui l’utilisent ne sont pas touchés.
                        </>
                    )}
                </p>
            </Dialog>
        </div>
    );
}

interface DatabaseBlockProps {
    database: Database;
    alerts: DatabaseAlert[];
    canWrite: boolean;
    framed: boolean;
    onUnlink: () => void;
}

/** Une base du projet : son en-tête, et le contenu partagé avec la feature. */
function DatabaseBlock({ database, alerts, canWrite, framed, onUnlink }: DatabaseBlockProps) {
    const [probe, setProbe] = useState<DatabaseProbe | null>(null);
    const [busy, setBusy] = useState(false);
    const [dialogOpen, setDialogOpen] = useState(false);

    const test = async () => {
        setBusy(true);
        setProbe(null);
        try {
            const res = await ws.send('database.test', { databaseId: database.id });
            setProbe(res.probe);
        } finally {
            setBusy(false);
        }
    };

    const inspect = async () => {
        setBusy(true);
        setProbe(null);
        try {
            const res = await ws.send('database.inspect', { databaseId: database.id });
            setProbe(res.probe);
            invalidate('database.list', 'database.detail', 'database.count');
        } finally {
            setBusy(false);
        }
    };

    const removeAlert = async (alertId: number) => {
        await ws.send('database.alertRemove', { alertId });
        invalidate('database.detail', 'database.list');
    };

    return (
        <section className={framed ? dbStyles.linkedBlockFramed : dbStyles.linkedBlock}>
            <DatabaseHeader
                database={database}
                canWrite={canWrite}
                busy={busy}
                onTest={() => void test()}
                onInspect={() => void inspect()}
                onEdit={() => setDialogOpen(true)}
                after={
                    // Destructeur, donc à part et confirmé : il ne doit pas
                    // côtoyer « Tester », qu'on presse souvent.
                    <Button variant='ghost' onClick={onUnlink} disabled={busy}>
                        Délier
                    </Button>
                }
            />

            <DatabaseView
                database={database}
                alerts={alerts}
                canWrite={canWrite}
                probe={probe}
                onAlertsChanged={() => invalidate('database.detail', 'database.list')}
                onRemoveAlert={(alertId) => void removeAlert(alertId)}
            />

            {/* Le vrai formulaire de la feature, pas une copie : régler une base
                depuis un projet ou depuis sa feature doit être le même geste. */}
            <DatabaseDialog
                open={dialogOpen}
                database={database}
                onClose={() => setDialogOpen(false)}
                onSaved={() => {
                    setDialogOpen(false);
                    invalidate('database.list', 'database.detail', 'database.count');
                }}
            />
        </section>
    );
}

export default Databases;

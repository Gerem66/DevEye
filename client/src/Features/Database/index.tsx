import { useCallback, useEffect, useRef, useState } from 'react';
import type { Database, DatabaseAlert, DatabaseProbe, DatabaseUsage } from 'deveye-types';
import { Button, NotificationsDialog } from '@/Components';
import { ws } from '@/api/ws';
import { invalidate, useResourceVersion } from '@/stores/invalidation';
import { useWorkspacePermissions } from '@/stores/workspace';
import { startTeleport } from '@/stores/live';
import { useLiveSegment } from '@/live/useLiveSegment';
import { useLiveOutlines } from '@/live/useLiveOutline';
import type { FeatureProps } from '@/Features/types';
import { humanizeError } from '../Projects/api';
import DatabaseDetail from './DatabaseDetail';
import DatabaseDialog from './DatabaseDialog';
import DatabaseList from './DatabaseList';
import styles from './style.module.css';

/**
 * Bases de données — celles de l'espace actif.
 *
 * Feature de premier rang, et non un onglet des Projets : une base appartient à
 * l'espace, plusieurs projets peuvent s'en servir, et certaines ne servent aucun
 * projet. Un projet ne fait qu'y **pointer**. C'est exactement la forme de la
 * feature Git, et pour les mêmes raisons.
 *
 * **Rien ne se connecte à l'ouverture.** La liste et la fiche lisent le dernier
 * relevé enregistré ; joindre un serveur demande un geste — « Tester »,
 * « Relever », « Charger les tables ». Le relevé périodique existe, mais il est
 * éteint par défaut et s'active base par base.
 *
 * Rien ici n'est chiffré à l'étage gardé : les bases vivent sous la clé de
 * l'espace, donc cette feature ne demande jamais de mot de passe.
 */
export function FeatureDatabase({ workspace }: FeatureProps) {
    const permissions = useWorkspacePermissions();
    const canWrite = permissions.canFeature('database', 'write');

    const [databases, setDatabases] = useState<Database[] | null>(null);
    const [error, setError] = useState<string | null>(null);

    /** La base ouverte ; `null` = on est sur la liste. */
    const [openedId, setOpenedId] = useState<number | null>(null);
    const [opened, setOpened] = useState<{
        database: Database;
        usage: DatabaseUsage[];
        alerts: DatabaseAlert[];
    } | null>(null);
    /** Le dernier essai de connexion, propre à la vue ouverte. */
    const [probe, setProbe] = useState<DatabaseProbe | null>(null);

    /** Un essai de connexion est en cours — distinct de `busy`, qui grise tout. */
    const [testing, setTesting] = useState(false);

    const [dialog, setDialog] = useState<{ database: Database | null } | null>(null);
    const [busy, setBusy] = useState(false);
    const [notificationsOpen, setNotificationsOpen] = useState(false);

    const listVersion = useResourceVersion('database.list');
    const detailVersion = useResourceVersion('database.detail');

    /** Un glisser-déposer est en cours : la liste ne doit pas bouger dessous. */
    const dragging = useRef(false);
    const pendingReload = useRef(false);

    // Présence : « qui regarde quelle base ». Un seul déclarant par niveau —
    // ce composant possède `l1`, et rien d'autre dans la feature n'y touche.
    const l1Target = useLiveSegment('l1', openedId === null ? null : `db:${openedId}`);
    const outlineFor = useLiveOutlines('l1');

    /**
     * Appliquer ce qu'une téléportation demande à ce niveau.
     *
     * Le hook déclarait le niveau sans jamais **suivre** la cible : rejoindre
     * quelqu'un — ou venir de l'onglet d'un projet — ouvrait donc la feature et
     * s'arrêtait sur la liste, la base visée restant à trouver à la main.
     *
     * La cible est rendue tant qu'elle n'est pas atteinte, jamais consommée : on
     * peut donc attendre que la liste soit chargée pour vérifier que la base
     * existe, et l'ignorer sans rien avoir à acquitter si elle a disparu.
     */
    useEffect(() => {
        if (!l1Target) return;
        if (l1Target.value === null) {
            setOpenedId(null);
            return;
        }
        const id = Number(l1Target.value.replace(/^db:/, ''));
        if (!Number.isInteger(id) || !databases?.some((d) => d.id === id)) return;
        setOpenedId(id);
    }, [l1Target, databases]);

    const reload = useCallback(async () => {
        try {
            const res = await ws.send('database.list', {});
            setDatabases(res.databases);
            setError(null);
        } catch (e) {
            setError(humanizeError(e, 'Impossible de charger les bases.'));
        }
    }, []);

    useEffect(() => {
        // Une relecture réordonne la liste sous le pointeur : jamais pendant un
        // glissé. Elle est retenue et rejouée au relâchement.
        if (dragging.current) {
            pendingReload.current = true;
            return;
        }
        void reload();
    }, [reload, workspace.id, listVersion]);

    const onDragStateChange = useCallback(
        (active: boolean) => {
            dragging.current = active;
            if (!active && pendingReload.current) {
                pendingReload.current = false;
                void reload();
            }
        },
        [reload]
    );

    const reorder = useCallback(
        (ids: number[]) => {
            // On range d'abord localement, pour que la carte reste là où on l'a
            // lâchée sans aller-retour, puis on persiste.
            setDatabases((prev) => {
                if (!prev) return prev;
                const byId = new Map(prev.map((d) => [d.id, d]));
                return ids.flatMap((id) => byId.get(id) ?? []);
            });
            ws.send('database.reorder', { ids }).catch(() => {
                setError('Réorganisation impossible.');
                void reload();
            });
        },
        [reload]
    );

    const loadOpened = useCallback(async (databaseId: number) => {
        try {
            const res = await ws.send('database.get', { databaseId });
            setOpened({ database: res.database, usage: res.usage, alerts: res.alerts });
            setError(null);
        } catch (e) {
            setError(humanizeError(e, 'Impossible d’ouvrir cette base.'));
            setOpenedId(null);
            setOpened(null);
        }
    }, []);

    useEffect(() => {
        if (openedId === null) {
            setOpened(null);
            setProbe(null);
            return;
        }
        void loadOpened(openedId);
    }, [openedId, loadOpened, detailVersion]);

    /** Essaie la connexion, sans rien enregistrer. */
    const test = async (databaseId: number) => {
        setBusy(true);
        setTesting(true);
        setProbe(null);
        try {
            const res = await ws.send('database.test', { databaseId });
            setProbe(res.probe);
        } catch (e) {
            setError(humanizeError(e, 'Le test n’a pas pu être lancé.'));
        } finally {
            setTesting(false);
            setBusy(false);
        }
    };

    /**
     * Relève l'inventaire — le même chemin que l'ordonnanceur, alertes comprises.
     *
     * **Ne touche pas à `probe`** : le résultat d'un relevé s'écrit dans le
     * bandeau « État / Temps de réponse / … » juste en dessous, et le redire en
     * une phrase au-dessus ne ferait que doubler la même information. La phrase
     * de connexion est réservée aux essais, qui n'ont, eux, aucun autre endroit
     * où s'afficher.
     */
    const inspect = async (databaseId: number) => {
        setBusy(true);
        try {
            await ws.send('database.inspect', { databaseId });
            invalidate('database.list', 'database.detail', 'database.count');
        } catch (e) {
            setError(humanizeError(e, 'Le relevé n’a pas pu être fait.'));
        } finally {
            setBusy(false);
        }
    };

    const remove = async (databaseId: number) => {
        setBusy(true);
        try {
            await ws.send('database.remove', { databaseId });
            setDialog(null);
            setOpenedId(null);
            invalidate('database.list', 'database.count', 'project.board');
        } catch (e) {
            setError(humanizeError(e, 'La suppression a échoué.'));
        } finally {
            setBusy(false);
        }
    };

    const removeAlert = async (alertId: number) => {
        try {
            await ws.send('database.alertRemove', { alertId });
            invalidate('database.detail', 'database.list');
        } catch (e) {
            setError(humanizeError(e, 'La suppression de l’alerte a échoué.'));
        }
    };

    /**
     * Ouvre un projet qui utilise cette base, dans la feature Projets.
     *
     * Par la **téléportation**, comme la feature Git : un chemin
     * `view:projects l1:project:12` dit exactement « ouvre Projets, et dedans,
     * ce projet-là », et l'accueil sait déjà l'appliquer, garde d'accès comprise.
     */
    const openProject = (projectId: number) => {
        startTeleport(workspace.id, ['view:projects', `l1:project:${projectId}`]);
    };

    if (opened) {
        return (
            <>
                <DatabaseDetail
                    database={opened.database}
                    usage={opened.usage}
                    alerts={opened.alerts}
                    canWrite={canWrite}
                    busy={busy}
                    testing={testing}
                    probe={probe}
                    onBack={() => setOpenedId(null)}
                    onEdit={() => setDialog({ database: opened.database })}
                    onTest={() => void test(opened.database.id)}
                    onInspect={() => void inspect(opened.database.id)}
                    onAlertsChanged={() => invalidate('database.detail', 'database.list')}
                    onRemoveAlert={(alertId) => void removeAlert(alertId)}
                    onOpenProject={openProject}
                />
                <DatabaseDialog
                    open={dialog !== null}
                    database={dialog?.database ?? null}
                    onClose={() => setDialog(null)}
                    onSaved={() => {
                        setDialog(null);
                        invalidate('database.list', 'database.detail', 'database.count');
                    }}
                    onRemove={canWrite ? () => void remove(opened.database.id) : undefined}
                />
            </>
        );
    }

    return (
        <div className={styles.root}>
            <header className={styles.header}>
                <div>
                    <h2 className={styles.heading}>Bases de données</h2>
                    {databases && (
                        <p className={styles.subheading}>
                            {databases.length} base{databases.length > 1 ? 's' : ''} ·{' '}
                            {databases.filter((d) => d.monitorEnabled).length} surveillée
                            {databases.filter((d) => d.monitorEnabled).length > 1 ? 's' : ''}
                        </p>
                    )}
                </div>
                {canWrite && (
                    <div className={styles.actions}>
                        {/* Réglage d'espace, pas d'une base : les alertes de
                            toutes les bases partent sur les mêmes canaux, d'où
                            sa place en tête de la feature. */}
                        <Button variant='secondary' icon='mail' onClick={() => setNotificationsOpen(true)}>
                            Notifications
                        </Button>
                        <Button icon='add' onClick={() => setDialog({ database: null })}>
                            Ajouter une base
                        </Button>
                    </div>
                )}
            </header>

            {error && <p className={styles.error}>{error}</p>}

            {databases === null && <p className={styles.hint}>Chargement…</p>}

            {databases?.length === 0 && (
                <p className={styles.hint}>
                    Aucune base pour l’instant.
                    {canWrite &&
                        ' Ajoutez-en une pour la tester, en explorer les tables, et — si vous le voulez — la surveiller.'}
                </p>
            )}

            {databases && databases.length > 0 && (
                <DatabaseList
                    databases={databases}
                    outlineFor={outlineFor}
                    canWrite={canWrite}
                    onOpen={setOpenedId}
                    onReorder={reorder}
                    onDragStateChange={onDragStateChange}
                />
            )}

            <DatabaseDialog
                open={dialog !== null}
                database={dialog?.database ?? null}
                onClose={() => setDialog(null)}
                onSaved={(databaseId) => {
                    setDialog(null);
                    invalidate('database.list', 'database.count');
                    // Une base qu'on vient d'ajouter s'ouvre : c'est ce qu'on
                    // voulait faire, et son premier test est à un clic.
                    setOpenedId(databaseId);
                }}
                onRemove={canWrite && dialog?.database ? () => void remove(dialog.database!.id) : undefined}
            />

            <NotificationsDialog
                open={notificationsOpen}
                onClose={() => setNotificationsOpen(false)}
                feature='database'
                title='Notifications des bases de données'
                description='Les siennes depuis la migration 085 : elles empruntaient les canaux d’Uptime, et un seuil SQL franchi arrivait donc sur le salon désigné pour la disponibilité. Vos réglages y ont été repris à l’identique.'
                when='Envoyées aux transitions d’une alerte, dans les deux sens — franchie, puis retour à la normale. Une alerte n’est évaluée que si la surveillance est active sur sa base : posée sur une base au repos, elle est inerte.'
            />
        </div>
    );
}

export default FeatureDatabase;

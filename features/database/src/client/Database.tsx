import { useCallback, useEffect, useRef, useState } from 'react';
import {
    Button,
    FeatureSettingsButton,
    humanizeError,
    invalidate,
    openFeature,
    useActiveWorkspace,
    useLiveItemTarget,
    useLiveOutlines,
    useResourceVersion,
    useWorkspacePermissions
} from 'deveye-sdk-client';
import type { FeatureViewProps } from '@deveye/types/sdk/client';
import type { Database, DatabaseAlert, DatabaseProbe, DatabaseUsage } from '../contracts/domain';

import { api } from './api';
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
 *
 * Depuis le rapatriement, l'espace vient de `useActiveWorkspace()` et non
 * d'une prop : la vue d'un module ne reçoit que `closeFeature`.
 */
export function FeatureDatabase(_props: FeatureViewProps) {
    const permissions = useWorkspacePermissions();
    const canWrite = permissions.canFeature('database', 'write');
    const workspaceId = useActiveWorkspace()?.id ?? null;

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

    const listVersion = useResourceVersion('database.list');
    const detailVersion = useResourceVersion('database.detail');

    /** Un glisser-déposer est en cours : la liste ne doit pas bouger dessous. */
    const dragging = useRef(false);
    const pendingReload = useRef(false);

    /**
     * Présence : « qui regarde quelle base ». Un seul déclarant par niveau —
     * ce composant possède `l1`, et rien d'autre dans la feature n'y touche.
     *
     * Le même hook applique ce qu'une téléportation demande à ce niveau :
     * rejoindre quelqu'un, ou venir de l'onglet d'un projet, ouvre la feature
     * ET la base visée, au lieu de s'arrêter sur la liste. La cible est rendue
     * tant qu'elle n'est pas atteinte, jamais consommée : on attend donc que la
     * liste soit chargée (`ready`) pour vérifier que la base existe, et on
     * l'ignore sans rien avoir à acquitter si elle a disparu. Le segment est
     * l'identifiant nu de la base, comme pour toute fiche d'élément.
     */
    useLiveItemTarget('l1', openedId === null ? null : String(openedId), databases !== null, (value) => {
        if (value === null) {
            setOpenedId(null);
            return;
        }
        const id = Number(value);
        if (!Number.isInteger(id) || !databases?.some((d) => d.id === id)) return;
        setOpenedId(id);
    });
    const outlineFor = useLiveOutlines('l1');

    const reload = useCallback(async () => {
        try {
            const res = await api.send('database.list', {});
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
    }, [reload, workspaceId, listVersion]);

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
            api.send('database.reorder', { ids }).catch(() => {
                setError('Réorganisation impossible.');
                void reload();
            });
        },
        [reload]
    );

    const loadOpened = useCallback(async (databaseId: number) => {
        try {
            const res = await api.send('database.get', { databaseId });
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
            const res = await api.send('database.test', { databaseId });
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
            await api.send('database.inspect', { databaseId });
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
            await api.send('database.remove', { databaseId });
            setDialog(null);
            setOpenedId(null);
            invalidate('database.list', 'database.count', 'projects.board');
        } catch (e) {
            setError(humanizeError(e, 'La suppression a échoué.'));
        } finally {
            setBusy(false);
        }
    };

    /**
     * Ouvre un projet qui utilise cette base, dans la feature Projets.
     *
     * Par la **téléportation**, comme la feature Git : `openFeature` écrit le
     * chemin `view:projects l1:12`, qui dit exactement « ouvre Projets, et
     * dedans, ce projet-là », et l'accueil sait déjà l'appliquer, garde d'accès
     * comprise. Le module n'écrit jamais le chemin lui-même.
     */
    const openProject = (projectId: number) => {
        openFeature('projects', projectId);
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
                <div className={styles.actions}>
                    {/* Réglage d'espace, pas d'une base : les alertes de
                        toutes les bases partent sur les mêmes canaux, d'où
                        sa place en tête de la feature. Hors du `canWrite` :
                        le bouton se garde de lui-même (aucune section
                        accessible ⇒ il ne s'affiche pas), et un lecteur a le
                        droit de voir où partent les alertes, comme dans les
                        autres features. */}
                    <FeatureSettingsButton scope={{ kind: 'feature', feature: 'database' }} />
                    {canWrite && (
                        <Button icon='add' onClick={() => setDialog({ database: null })}>
                            Ajouter une base
                        </Button>
                    )}
                </div>
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
        </div>
    );
}

export default FeatureDatabase;

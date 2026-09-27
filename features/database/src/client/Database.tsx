import { useCallback, useEffect, useRef, useState } from 'react';
import {
    Button,
    FeatureSettingsButton,
    humanizeError,
    invalidate,
    openFeature,
    PlanPausedNotice,
    useActiveWorkspace,
    useLiveItemTarget,
    useLiveOutlines,
    useResourceVersion,
    useSubView,
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
 * Les bases de données de l'espace actif. Rien ne se connecte à l'ouverture :
 * la liste et la fiche lisent le dernier relevé, joindre un serveur demande un
 * geste. Rien n'est chiffré à l'étage gardé : jamais d'invite de mot de passe.
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
    const [probe, setProbe] = useState<DatabaseProbe | null>(null);

    /** Un essai de connexion est en cours ; distinct de `busy`, qui grise tout. */
    const [testing, setTesting] = useState(false);

    const [addOpen, setAddOpen] = useState(false);
    const [busy, setBusy] = useState(false);

    const listVersion = useResourceVersion('database.list');
    const detailVersion = useResourceVersion('database.detail');

    /** Un glisser-déposer est en cours : la liste ne doit pas bouger dessous. */
    const dragging = useRef(false);
    const pendingReload = useRef(false);

    /**
     * Présence et téléportation au niveau `l1` (ce composant en est le seul
     * déclarant). La cible est rendue tant qu'elle n'est pas atteinte : on
     * attend la liste pour vérifier que la base existe, et on l'ignore sinon.
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
    useSubView(opened ? 'database' : null);

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
        // Jamais de relecture pendant un glissé : elle est rejouée au relâchement.
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
            // Rangé localement d'abord, pour que la carte reste où on l'a lâchée.
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

    // Ne touche pas à `probe` : le résultat d'un relevé s'écrit dans le
    // bandeau d'état, la phrase de connexion est réservée aux essais.
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

    const openProject = (projectId: number) => {
        openFeature('projects', projectId);
    };

    if (opened) {
        return (
            <DatabaseDetail
                database={opened.database}
                usage={opened.usage}
                alerts={opened.alerts}
                canWrite={canWrite}
                busy={busy}
                testing={testing}
                probe={probe}
                onBack={() => setOpenedId(null)}
                onTest={() => void test(opened.database.id)}
                onInspect={() => void inspect(opened.database.id)}
                onOpenProject={openProject}
            />
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
                    {/* Hors du `canWrite` : le bouton se garde lui-même, et un
                        lecteur a le droit de voir où partent les alertes. */}
                    <FeatureSettingsButton scope={{ kind: 'feature', feature: 'database' }} />
                    {canWrite && (
                        <Button icon='add' onClick={() => setAddOpen(true)}>
                            Ajouter une base
                        </Button>
                    )}
                </div>
            </header>

            {error && <p className={styles.error}>{error}</p>}

            {databases && (
                <PlanPausedNotice
                    count={databases.filter((d) => d.planPaused).length}
                    one='base de données'
                    many='bases de données'
                />
            )}

            {databases === null && <p className={styles.hint}>Chargement…</p>}

            {databases?.length === 0 && (
                <p className={styles.hint}>
                    Aucune base pour l’instant.
                    {canWrite &&
                        ' Ajoutez-en une pour la tester, en explorer les tables, et, si vous le voulez, la surveiller.'}
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
                open={addOpen}
                onClose={() => setAddOpen(false)}
                onSaved={(databaseId) => {
                    setAddOpen(false);
                    invalidate('database.list', 'database.count');
                    // Une base qu'on vient d'ajouter s'ouvre.
                    setOpenedId(databaseId);
                }}
            />
        </div>
    );
}

export default FeatureDatabase;

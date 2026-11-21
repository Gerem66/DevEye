import { useCallback, useEffect, useRef, useState } from 'react';
import {
    Button,
    errorNote,
    ErrorNote,
    FeatureSettingsButton,
    invalidate,
    NotificationsNotice,
    openFeature,
    PlanPausedNotice,
    StickyHeader,
    useActiveWorkspace,
    useLiveItemTarget,
    useLiveOutlines,
    useLiveSegment,
    useResourceVersion,
    useSubView,
    useWorkspacePermissions,
    type ErrorNoteInput
} from 'deveye-sdk-client';
import type { FeatureViewProps } from '@deveye/types/sdk/client';
import type { Database, DatabaseAlert, DatabaseKpi, DatabaseUsage } from '../contracts/domain';

import { api } from './api';
import DatabaseDetail, { type DatabaseTab } from './DatabaseDetail';
import DatabaseDialog from './DatabaseDialog';
import DatabaseList from './DatabaseList';
import styles from './style.module.css';

/**
 * Les bases de données de l'espace actif. La liste lit le dernier relevé sans
 * joindre aucun serveur ; c'est la fiche d'une base qui la relève
 * (`DatabaseOverview`). Rien n'est chiffré à l'étage gardé : jamais d'invite
 * de mot de passe.
 */
export function FeatureDatabase(_props: FeatureViewProps) {
    const permissions = useWorkspacePermissions();
    const canWrite = permissions.canFeature('database', 'write');
    const workspaceId = useActiveWorkspace()?.id ?? null;

    const [databases, setDatabases] = useState<Database[] | null>(null);
    const [error, setError] = useState<ErrorNoteInput | null>(null);

    /** La base ouverte ; `null` = on est sur la liste. */
    const [openedId, setOpenedId] = useState<number | null>(null);
    const [opened, setOpened] = useState<{
        database: Database;
        usage: DatabaseUsage[];
        alerts: DatabaseAlert[];
        kpis: DatabaseKpi[];
    } | null>(null);
    /** L'onglet de la fiche, tenu ici pour qu'il vaille d'une base à l'autre. */
    const [tab, setTab] = useState<DatabaseTab>('overview');

    const [addOpen, setAddOpen] = useState(false);

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
    // `l2` : l'onglet de la fiche ; `DatabaseDetail` en entoure les onglets.
    useLiveSegment('l2', opened ? tab : null);
    useSubView(opened ? 'database' : null);

    const reload = useCallback(async () => {
        try {
            const res = await api.send('database.list', {});
            setDatabases(res.databases);
            setError(null);
        } catch (e) {
            setError(errorNote(e, 'Impossible de charger les bases.'));
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
            // Relue d'abord : son succès efface l'erreur affichée.
            api.send('database.reorder', { ids }).catch((e: unknown) => {
                void reload().then(() => setError(errorNote(e, 'Réorganisation impossible.')));
            });
        },
        [reload]
    );

    const loadOpened = useCallback(async (databaseId: number) => {
        try {
            const res = await api.send('database.get', { databaseId });
            setOpened({ database: res.database, usage: res.usage, alerts: res.alerts, kpis: res.kpis });
            setError(null);
        } catch (e) {
            setError(errorNote(e, 'Impossible d’ouvrir cette base.'));
            setOpenedId(null);
            setOpened(null);
        }
    }, []);

    useEffect(() => {
        if (openedId === null) {
            setOpened(null);
            return;
        }
        void loadOpened(openedId);
    }, [openedId, loadOpened, detailVersion]);

    const openProject = (projectId: number) => {
        openFeature('projects', projectId);
    };

    if (opened) {
        return (
            <DatabaseDetail
                database={opened.database}
                usage={opened.usage}
                alerts={opened.alerts}
                kpis={opened.kpis}
                // Le droit sur CETTE base, surcharge comprise : la fiche la relève d'elle-même.
                canWrite={permissions.canFeature('database', 'write', String(opened.database.id))}
                tab={tab}
                onTab={setTab}
                onBack={() => setOpenedId(null)}
                onOpenProject={openProject}
            />
        );
    }

    return (
        <div className={styles.root}>
            <StickyHeader>
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
            </StickyHeader>

            <ErrorNote note={error} />

            {databases && (
                <PlanPausedNotice
                    count={databases.filter((d) => d.planPaused).length}
                    one='base de données'
                    many='bases de données'
                />
            )}
            {databases?.some((d) => d.alertCount > 0) && (
                <NotificationsNotice scope={{ kind: 'feature', feature: 'database' }} />
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

import { Button, ErrorNote, openFeature, useResource, useWorkspacePermissions } from 'deveye-sdk-client';
import type { DatabaseClientProvider, SdkTileSummary } from '@deveye/types/sdk/client';

import { api } from './api';
import { DatabaseDialog } from './DatabaseDialog';
import { DatabaseHeader } from './DatabaseHeader';
import { DatabaseOverview } from './DatabaseOverview';
import { TableExplorer } from './TableExplorer';
import { ENGINE_LABELS, formatBytes, STATUS_META } from './format';
import styles from './style.module.css';

/**
 * Ce que le module offre à l'onglet « Bases de données » d'un projet
 * (`DATABASE_CLIENT_PROVIDER`). `LinkedDatabase` est autonome : l'hôte ne lui
 * tend qu'un identifiant et ne connaît ni la forme d'une base, ni ses commandes.
 */

interface LinkedDatabaseProps {
    databaseId: number;
    canWrite: boolean;
    onUnlink: () => void;
}

/** Une base du projet, en entier : son en-tête, son état, puis ses tables. */
function LinkedDatabase({ databaseId, canWrite, onUnlink }: LinkedDatabaseProps) {
    // Le droit sur CETTE base, surcharge comprise : la fiche la relève d'elle-même.
    const writable = useWorkspacePermissions().canFeature('database', 'write', String(databaseId)) && canWrite;
    const { data, error: loadError } = useResource(
        'database.detail',
        () => api.send('database.get', { databaseId }),
        'Impossible de charger cette base.',
        [databaseId]
    );

    if (!data) return loadError ? <ErrorNote note={loadError} /> : <p className={styles.hint}>Chargement…</p>;
    const { database, alerts, kpis } = data;

    // Le cadre dit où finit ce que l'onglet montre.
    return (
        <section className={styles.linkedBlock}>
            <DatabaseHeader
                database={database}
                onOpenInFeature={() => openFeature('database', database.id)}
                after={
                    // La confirmation et le déliement sont à l'hôte, qui
                    // seul tient le pointeur.
                    <Button variant='ghost' onClick={onUnlink}>
                        Délier
                    </Button>
                }
            />

            <DatabaseOverview database={database} alerts={alerts} kpis={kpis} canWrite={writable} />
            <TableExplorer database={database} canWrite={writable} />
        </section>
    );
}

interface LinkedDatabaseDialogProps {
    open: boolean;
    onClose: () => void;
    onSaved: (databaseId: number) => void;
}

/**
 * Le dialogue d'ajout de la feature, pas une copie : Projets relie ce qui vient
 * d'être ajouté. Une base reliée se règle par le bouton commun de `LinkedDatabase`.
 */
function LinkedDatabaseDialog({ open, onClose, onSaved }: LinkedDatabaseDialogProps) {
    return <DatabaseDialog open={open} onClose={onClose} onSaved={onSaved} />;
}

/**
 * Une base résumée pour une tuile de tableau de bord : son état, sa taille et ce
 * qui alerte. Tout vient de `database.list`, un aller-retour pour toutes les
 * bases d'un projet.
 */
function summarize(databaseIds: readonly number[]): Promise<readonly SdkTileSummary[]> {
    return api.send('database.list', {}).then(({ databases }) =>
        databaseIds.map((id): SdkTileSummary => {
            const database = databases.find((d) => d.id === id);
            if (!database) {
                return { itemId: id, title: `Base #${id}`, metrics: [], unavailable: 'Cette base n’est plus ici.' };
            }
            if (database.planPaused) {
                return {
                    itemId: id,
                    title: database.name,
                    metrics: [],
                    unavailable: 'Au-delà de l’offre : son relevé est en pause.'
                };
            }
            if (!database.monitorEnabled) {
                return {
                    itemId: id,
                    title: database.name,
                    metrics: [],
                    unavailable: 'Son relevé périodique est éteint : rien n’est mesuré.'
                };
            }
            const meta = STATUS_META[database.status];
            return {
                itemId: id,
                title: database.name,
                metrics: [
                    {
                        key: 'status',
                        label: 'État',
                        value: meta.label,
                        tone: meta.tone === 'online' ? 'good' : meta.tone === 'danger' ? 'bad' : 'neutral'
                    },
                    { key: 'size', label: 'Taille', value: formatBytes(database.sizeBytes) },
                    {
                        key: 'alerts',
                        label: 'Alertes',
                        value: database.firingCount > 0 ? `${database.firingCount} franchie(s)` : 'aucune',
                        tone: database.firingCount > 0 ? 'bad' : 'neutral'
                    }
                ]
            };
        })
    );
}

export const clientProvider: DatabaseClientProvider = {
    summarize,
    listDatabases: async () =>
        (await api.send('database.list', {})).databases.map((d) => ({
            id: d.id,
            name: d.name,
            engineLabel: ENGINE_LABELS[d.engine],
            projectCount: d.projectCount,
            foreign: d.foreign
        })),
    LinkedDatabase,
    DatabaseDialog: LinkedDatabaseDialog
};

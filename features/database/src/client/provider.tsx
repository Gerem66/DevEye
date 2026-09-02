import { useState } from 'react';
import { Button, humanizeError, invalidate, openFeature, useResource } from 'deveye-sdk-client';
import type { DatabaseClientProvider } from '@deveye/types/sdk/client';
import type { DatabaseProbe } from '../contracts/domain';

import { api } from './api';
import { DatabaseDialog } from './DatabaseDialog';
import { DatabaseHeader } from './DatabaseHeader';
import { DatabaseView } from './DatabaseView';
import { ENGINE_LABELS } from './format';
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

/** Une base du projet : son en-tête, et le contenu partagé avec la feature. */
function LinkedDatabase({ databaseId, canWrite, onUnlink }: LinkedDatabaseProps) {
    const { data, error: loadError } = useResource(
        'database.detail',
        () => api.send('database.get', { databaseId }),
        'Impossible de charger cette base.',
        [databaseId]
    );
    const [probe, setProbe] = useState<DatabaseProbe | null>(null);
    const [testing, setTesting] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    /** L'explorateur occupe tout : l'en-tête et les voisins s'effacent. */
    const [expanded, setExpanded] = useState(false);

    if (!data) return <p className={loadError ? styles.error : styles.hint}>{loadError ?? 'Chargement…'}</p>;
    const { database, alerts } = data;

    const test = async () => {
        setBusy(true);
        setTesting(true);
        setProbe(null);
        setError(null);
        try {
            const res = await api.send('database.test', { databaseId: database.id });
            setProbe(res.probe);
        } catch (e) {
            setError(humanizeError(e, 'Le test n’a pas pu être lancé.'));
        } finally {
            setTesting(false);
            setBusy(false);
        }
    };

    // Relever n'écrit rien dans `probe` : son résultat est le bandeau d'état.
    const inspect = async () => {
        setBusy(true);
        setError(null);
        try {
            await api.send('database.inspect', { databaseId: database.id });
            invalidate('database.list', 'database.detail', 'database.count');
        } catch (e) {
            setError(humanizeError(e, 'Le relevé n’a pas pu être fait.'));
        } finally {
            setBusy(false);
        }
    };

    // Toujours encadré, sauf en plein écran : le cadre dit où finit ce que
    // l'onglet montre.
    return (
        <section className={expanded ? styles.linkedBlock : styles.linkedBlockFramed}>
            {!expanded && (
                <DatabaseHeader
                    database={database}
                    canWrite={canWrite}
                    busy={busy}
                    onTest={() => void test()}
                    onInspect={() => void inspect()}
                    onOpenInFeature={() => openFeature('database', database.id)}
                    after={
                        // La confirmation et le déliement sont à l'hôte, qui
                        // seul tient le pointeur.
                        <Button variant='ghost' onClick={onUnlink} disabled={busy}>
                            Délier
                        </Button>
                    }
                />
            )}

            {error && <p className={styles.error}>{error}</p>}

            <DatabaseView
                database={database}
                alerts={alerts}
                canWrite={canWrite}
                testing={testing}
                probe={probe}
                onExpandChange={setExpanded}
            />
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

export const clientProvider: DatabaseClientProvider = {
    listDatabases: async () =>
        (await api.send('database.list', {})).databases.map((d) => ({
            id: d.id,
            name: d.name,
            engineLabel: ENGINE_LABELS[d.engine],
            projectCount: d.projectCount
        })),
    LinkedDatabase,
    DatabaseDialog: LinkedDatabaseDialog
};

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
 * Ce que le module offre aux écrans de l'app (`DATABASE_CLIENT_PROVIDER`) :
 * l'onglet « Bases de données » d'un projet compose la liste des bases de
 * l'espace, une base reliée montrée en entier, et le dialogue de création,
 * sans importer le module.
 *
 * `LinkedDatabase` est autonome, et c'est la différence avec l'ancien bloc
 * que Projets écrivait lui-même : l'hôte ne lui tend qu'un identifiant, et
 * le bloc charge sa base, suit les invalidations de la feature et gère son
 * mode agrandi. L'hôte ne connaît ni la forme d'une base, ni ses commandes.
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
    const [dialogOpen, setDialogOpen] = useState(false);
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

    /**
     * Relever n'écrit rien à l'écran : son résultat est le bandeau d'état, juste
     * en dessous. La phrase de connexion appartient aux essais seuls.
     */
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

    // Toujours encadré, y compris sur une base unique : le cadre ne fait pas
    // que séparer deux blocs, il dit où finit ce que l'onglet montre. Seul
    // l'explorateur en plein écran le retire, parce qu'il prend toute la place
    // et qu'un cadre autour n'aurait plus rien à délimiter.
    return (
        <section className={expanded ? styles.linkedBlock : styles.linkedBlockFramed}>
            {!expanded && (
                <DatabaseHeader
                    database={database}
                    canWrite={canWrite}
                    busy={busy}
                    onTest={() => void test()}
                    onInspect={() => void inspect()}
                    onEdit={() => setDialogOpen(true)}
                    // Le sens qui manquait : la feature sait déjà mener aux
                    // projets d'une base, l'onglet d'un projet ne savait pas
                    // mener à la base. Par la téléportation, comme partout :
                    // `openFeature` écrit le chemin `view:database l1:7`, qui
                    // dit « ouvre la feature, et dedans, cette base-là », garde
                    // d'accès comprise.
                    onOpenInFeature={() => openFeature('database', database.id)}
                    after={
                        // Destructeur, donc à part et confirmé : il ne doit pas
                        // côtoyer « Tester », qu'on presse souvent. La
                        // confirmation et le déliement sont à l'hôte, qui seul
                        // tient le pointeur.
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

interface LinkedDatabaseDialogProps {
    open: boolean;
    onClose: () => void;
    onSaved: (databaseId: number) => void;
}

/**
 * Le dialogue de la feature, en mode création seulement : c'est le seul cas
 * de Projets, qui relie ce qui vient d'être créé. La modification passe par
 * `LinkedDatabase`, qui tient la base chargée.
 */
function LinkedDatabaseDialog({ open, onClose, onSaved }: LinkedDatabaseDialogProps) {
    return <DatabaseDialog open={open} database={null} onClose={onClose} onSaved={onSaved} />;
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

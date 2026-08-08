import { useCallback, useEffect, useState } from 'react';
import type { Database, Project } from 'deveye-types';
import { Button, SelectInput } from '@/Components';
import { ws, WsError } from '@/api/ws';
import { invalidate, useResourceVersion } from '@/stores/invalidation';
import { useWorkspacePermissions } from '@/stores/workspace';
import { startTeleport } from '@/stores/live';
import { useActiveWorkspace } from '@/stores/workspace';
import { ENGINE_LABELS, formatAgo, formatBytes, STATUS_META } from '@/Features/Database/format';
import dbStyles from '@/Features/Database/style.module.css';
import { humanizeError } from '../api';
import styles from '../style.module.css';

interface DatabasesProps {
    project: Project;
    canWrite: boolean;
}

/**
 * L'onglet « Bases de données » d'un projet : celles qu'il pointe.
 *
 * Enveloppe mince, comme l'onglet Git. **La base n'appartient pas au projet** :
 * elle vit dans sa feature, avec ses alertes et son relevé, et plusieurs projets
 * peuvent viser la même. Cet onglet ne possède qu'un pointeur
 * (`project.databaseList` / `databaseLink` / `databaseUnlink`).
 *
 * Une différence avec le dépôt git, et une seule : un projet peut suivre
 * **plusieurs** bases, là où il n'a qu'un dépôt.
 *
 * Corollaire à connaître : lire une base relève du droit `database`, pas de
 * `projects`. Un membre qui a l'un sans l'autre voit qu'il y a des bases
 * rattachées sans pouvoir les nommer, et l'écran le dit.
 */
export function Databases({ project, canWrite }: DatabasesProps) {
    const permissions = useWorkspacePermissions();
    const workspace = useActiveWorkspace();
    const canReadDb = permissions.canFeature('database');
    const canWriteDb = permissions.canFeature('database', 'write');

    const [linkedIds, setLinkedIds] = useState<number[]>([]);
    const [catalog, setCatalog] = useState<Database[] | null>(null);
    const [picked, setPicked] = useState('');
    const [loaded, setLoaded] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const boardVersion = useResourceVersion('project.board');
    const dbVersion = useResourceVersion('database.list');
    const guarded = project.securityTier === 'guarded';

    const load = useCallback(async () => {
        if (guarded) {
            setLoaded(true);
            return;
        }
        try {
            const res = await ws.send('project.databaseList', { projectId: project.id });
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

    // Le catalogue de l'espace : pour nommer les liées et proposer les autres.
    // Un refus de droit n'est pas une erreur à afficher.
    useEffect(() => {
        if (guarded || !canReadDb) {
            setCatalog([]);
            return;
        }
        let alive = true;
        void (async () => {
            try {
                const res = await ws.send('database.list', {});
                if (alive) setCatalog(res.databases);
            } catch (e) {
                if (alive) setCatalog([]);
                if (!(e instanceof WsError && e.code === 'forbidden')) {
                    setError(humanizeError(e, 'Impossible de charger les bases de l’espace.'));
                }
            }
        })();
        return () => {
            alive = false;
        };
    }, [guarded, canReadDb, dbVersion]);

    const write = async (command: 'project.databaseLink' | 'project.databaseUnlink', databaseId: number) => {
        setBusy(true);
        try {
            const res = await ws.send(command, { projectId: project.id, databaseId });
            setLinkedIds(res.databaseIds);
            setPicked('');
            setError(null);
            invalidate('database.list');
        } catch (e) {
            setError(humanizeError(e, 'La liaison n’a pas pu être modifiée.'));
        } finally {
            setBusy(false);
        }
    };

    /** Ouvre la base dans sa feature — le second sens de l'interconnexion. */
    const openDatabase = (databaseId: number) => {
        if (!workspace) return;
        startTeleport(workspace.id, ['view:database', `l1:db:${databaseId}`]);
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

    const byId = new Map((catalog ?? []).map((d) => [d.id, d]));
    const free = (catalog ?? []).filter((d) => !linkedIds.includes(d.id));

    return (
        <div className={dbStyles.root}>
            {error && <p className={styles.error}>{error}</p>}

            {linkedIds.length === 0 && (
                <p className={styles.empty}>
                    Aucune base reliée à ce projet.
                    {canWrite && canWriteDb && ' Reliez celles dont il dépend pour en lire l’état ici même.'}
                </p>
            )}

            {linkedIds.length > 0 && (
                <ul className={dbStyles.grid}>
                    {linkedIds.map((id) => {
                        const database = byId.get(id);
                        const status = database ? STATUS_META[database.status] : null;
                        return (
                            <li key={id} className={dbStyles.card}>
                                <div
                                    className={dbStyles.cardBody}
                                    role='button'
                                    tabIndex={0}
                                    onClick={() => openDatabase(id)}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter' || e.key === ' ') {
                                            e.preventDefault();
                                            openDatabase(id);
                                        }
                                    }}
                                >
                                    <div className={dbStyles.cardMain}>
                                        <p className={dbStyles.cardName}>
                                            <span
                                                className={dbStyles.statusDot}
                                                data-tone={status?.tone ?? 'neutral'}
                                                aria-hidden='true'
                                            />
                                            {/* Le pointeur existe mais la base n'est pas
                                                lisible : c'est un manque de droit, pas une
                                                erreur. Le dire plutôt que d'afficher un vide
                                                qui se lirait comme un bug. */}
                                            {database?.name ?? `Base #${id}`}
                                        </p>
                                        {database ? (
                                            <>
                                                <p className={dbStyles.cardMeta}>
                                                    {ENGINE_LABELS[database.engine]} · {database.host}:{database.port}/
                                                    {database.database}
                                                </p>
                                                <div className={dbStyles.cardFoot}>
                                                    <span className={dbStyles.statusTag} data-tone={status?.tone}>
                                                        {status?.label}
                                                    </span>
                                                    <span className={dbStyles.tag}>
                                                        {database.monitorEnabled
                                                            ? `relevée ${formatAgo(database.lastCheckAt)}`
                                                            : 'à la demande'}
                                                    </span>
                                                    {database.sizeBytes !== null && (
                                                        <span className={dbStyles.tag}>
                                                            {formatBytes(database.sizeBytes)}
                                                        </span>
                                                    )}
                                                    {database.firingCount > 0 && (
                                                        <span className={dbStyles.alertTag}>
                                                            {database.firingCount} alerte
                                                            {database.firingCount > 1 ? 's' : ''}
                                                        </span>
                                                    )}
                                                </div>
                                            </>
                                        ) : (
                                            <p className={dbStyles.hint}>
                                                Votre rôle n’ouvre pas la feature « Bases de données ».
                                            </p>
                                        )}
                                    </div>
                                    <span className={dbStyles.openArrow} aria-hidden='true'>
                                        <span className='icon icon-arrow' />
                                    </span>
                                </div>

                                {canWrite && canWriteDb && (
                                    <button
                                        type='button'
                                        className={dbStyles.conditionRemove}
                                        aria-label={`Délier ${database?.name ?? `la base #${id}`}`}
                                        disabled={busy}
                                        onClick={() => void write('project.databaseUnlink', id)}
                                    >
                                        <span className='icon icon-x' />
                                    </button>
                                )}
                            </li>
                        );
                    })}
                </ul>
            )}

            {canWrite && canWriteDb && (
                <div className={dbStyles.actions}>
                    <SelectInput
                        value={picked}
                        onChange={(e) => setPicked(e.target.value)}
                        disabled={busy || free.length === 0}
                    >
                        <option value=''>
                            {catalog === null
                                ? 'Chargement…'
                                : free.length === 0
                                  ? 'Aucune base à relier'
                                  : 'Choisir une base…'}
                        </option>
                        {free.map((d) => (
                            <option key={d.id} value={d.id}>
                                {d.name}
                            </option>
                        ))}
                    </SelectInput>
                    <Button
                        variant='secondary'
                        disabled={busy || !picked}
                        onClick={() => void write('project.databaseLink', Number(picked))}
                    >
                        Relier
                    </Button>
                </div>
            )}

            {canWrite && !canWriteDb && (
                <span className={dbStyles.hint}>
                    Votre rôle ne permet pas de modifier les bases de données de cet espace.
                </span>
            )}
        </div>
    );
}

export default Databases;

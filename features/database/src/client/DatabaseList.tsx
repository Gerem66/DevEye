import { PlanPausedBadge, useDragReorder, type LiveOutlineProps } from 'deveye-sdk-client';
import type { Database } from '../contracts/domain';

import { ENGINE_LABELS, formatAgo, formatBytes, STATUS_META } from './format';
import styles from './style.module.css';

interface DatabaseListProps {
    /** Les bases, déjà dans l'ordre de l'utilisateur. */
    databases: Database[];
    /** Le halo de présence d'une base (`useLiveOutlines('l1')` de l'appelant). */
    outlineFor: (value: string | null) => LiveOutlineProps;
    /** Ranger est une écriture : sans le droit, la poignée n'existe pas. */
    canWrite: boolean;
    onOpen: (databaseId: number) => void;
    onReorder: (ids: number[]) => void;
    onDragStateChange: (dragging: boolean) => void;
}

/** La liste des bases, réordonnable au glisser-déposer (`useDragReorder` du SDK). */
export function DatabaseList({
    databases,
    outlineFor,
    canWrite,
    onOpen,
    onReorder,
    onDragStateChange
}: DatabaseListProps) {
    const drag = useDragReorder<HTMLUListElement, HTMLLIElement>({
        ids: databases.map((d) => d.id),
        rowSelector: '[data-database-card]',
        onReorder: (ids) => onReorder(ids as number[]),
        onDragStateChange
    });

    return (
        <ul ref={drag.listRef} className={styles.grid}>
            {databases.map((database) => (
                <DatabaseCard
                    key={database.id}
                    database={database}
                    outline={outlineFor(String(database.id))}
                    dragging={drag.draggingId === database.id}
                    onOpen={() => onOpen(database.id)}
                    onDragPointerDown={canWrite ? (e) => drag.onGripPointerDown(e, database.id) : undefined}
                />
            ))}
            {/* Un `<li>` : seul enfant valide d'une `<ul>` ; sorti du flux, il
                n'occupe aucune cellule. */}
            <li ref={drag.barRef} className={styles.dropBar} aria-hidden='true' />
        </ul>
    );
}

interface DatabaseCardProps {
    database: Database;
    outline: LiveOutlineProps;
    dragging: boolean;
    onOpen: () => void;
    onDragPointerDown?: (e: React.PointerEvent) => void;
}

function DatabaseCard({ database, outline, dragging, onOpen, onDragPointerDown }: DatabaseCardProps) {
    const status = STATUS_META[database.status];

    return (
        <li className={`${styles.card} ${dragging ? styles.cardDragging : ''}`} data-database-card='' {...outline}>
            {/* Sœur du corps cliquable, pas son enfant : un clic parti d'ici ne
                remonte pas jusqu'à « ouvrir la base ». */}
            {onDragPointerDown && (
                <button
                    type='button'
                    className={styles.grip}
                    aria-label='Réordonner la base'
                    onPointerDown={onDragPointerDown}
                >
                    <span className='icon icon-drag' />
                </button>
            )}

            {/* `div role="button"` et non `<button>` : la carte contient des
                paragraphes, interdits dans un bouton. */}
            <div
                className={styles.cardBody}
                role='button'
                tabIndex={0}
                onClick={onOpen}
                onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onOpen();
                    }
                }}
            >
                <div className={styles.cardMain}>
                    <p className={styles.cardName}>
                        <span className={styles.statusDot} data-tone={status.tone} aria-hidden='true' />
                        {database.name}
                        {database.foreign && (
                            <span
                                className={styles.viaTag}
                                title='Cette base appartient à un autre espace qui la partage ici'
                            >
                                partagé
                            </span>
                        )}
                    </p>
                    <p className={styles.cardMeta}>
                        {ENGINE_LABELS[database.engine]} · {database.host}:{database.port}/{database.database}
                        {database.access.kind !== 'direct' && (
                            <span className={styles.viaTag}>
                                via {database.access.kind === 'ssh' ? 'SSH' : 'SOCKS'}
                            </span>
                        )}
                    </p>
                    <div className={styles.cardFoot}>
                        <span className={styles.statusTag} data-tone={status.tone}>
                            {status.label}
                        </span>
                        {database.planPaused && <PlanPausedBadge />}
                        {database.monitorEnabled ? (
                            <span className={styles.tag}>relevée {formatAgo(database.lastCheckAt)}</span>
                        ) : (
                            // Dit que rien ne tourne : « jamais testée » se lirait
                            // comme une panne.
                            <span className={styles.tag}>à la demande</span>
                        )}
                        {database.sizeBytes !== null && (
                            <span className={styles.tag}>{formatBytes(database.sizeBytes)}</span>
                        )}
                        {database.firingCount > 0 && (
                            <span className={styles.alertTag}>
                                {database.firingCount} alerte{database.firingCount > 1 ? 's' : ''}
                            </span>
                        )}
                        <span className={styles.tag}>
                            {database.projectCount === 0
                                ? 'aucun projet'
                                : `${database.projectCount} projet${database.projectCount > 1 ? 's' : ''}`}
                        </span>
                    </div>
                </div>

                <span className={styles.openArrow} aria-hidden='true'>
                    <span className='icon icon-arrow' />
                </span>
            </div>
        </li>
    );
}

export default DatabaseList;

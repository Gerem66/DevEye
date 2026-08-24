import type { Database } from '@deveye/types';
import { useDragReorder } from '@/dragReorder';
import type { useLiveOutlines } from '@/live/useLiveOutline';
import { ENGINE_LABELS, formatAgo, formatBytes, STATUS_META } from './format';
import styles from './style.module.css';

interface DatabaseListProps {
    /** Les bases, déjà dans l'ordre de l'utilisateur. */
    databases: Database[];
    outlineFor: ReturnType<typeof useLiveOutlines>;
    /** Ranger est une écriture : sans le droit, la poignée n'existe pas. */
    canWrite: boolean;
    onOpen: (databaseId: number) => void;
    onReorder: (ids: number[]) => void;
    onDragStateChange: (dragging: boolean) => void;
}

/**
 * La liste des bases, réordonnable au glisser-déposer.
 *
 * Le geste vit dans {@link ../../dragReorder}, partagé avec Uptime, Git et
 * Monitoring. Ne restent ici que l'apparence de la carte, celle de la poignée et
 * celle de la barre d'insertion.
 */
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
                    outline={outlineFor(`db:${database.id}`)}
                    dragging={drag.draggingId === database.id}
                    onOpen={() => onOpen(database.id)}
                    onDragPointerDown={canWrite ? (e) => drag.onGripPointerDown(e, database.id) : undefined}
                />
            ))}
            {/* Un `<li>` et non un `<span>` : dans une `<ul>`, seul un `<li>` est
                un enfant valide. Sorti du flux par `position: absolute`, il
                n'occupe aucune cellule de la grille. */}
            <li ref={drag.barRef} className={styles.dropBar} aria-hidden='true' />
        </ul>
    );
}

interface DatabaseCardProps {
    database: Database;
    outline: ReturnType<ReturnType<typeof useLiveOutlines>>;
    dragging: boolean;
    onOpen: () => void;
    onDragPointerDown?: (e: React.PointerEvent) => void;
}

function DatabaseCard({ database, outline, dragging, onOpen, onDragPointerDown }: DatabaseCardProps) {
    const status = STATUS_META[database.status];

    return (
        <li className={`${styles.card} ${dragging ? styles.cardDragging : ''}`} data-database-card='' {...outline}>
            {/* La poignée est sœur du corps cliquable, et non son enfant : un
                clic parti d'ici ne peut donc pas remonter jusqu'à « ouvrir la
                base », même sans le neutraliser. */}
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
                paragraphes, c'est-à-dire du contenu de flux, interdit dans un
                bouton dont le modèle de contenu est phrasé. */}
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
                        {/* L'état d'abord : c'est la seule chose qu'on vient
                            lire quand on parcourt la liste. */}
                        <span className={styles.statusTag} data-tone={status.tone}>
                            {status.label}
                        </span>
                        {database.monitorEnabled ? (
                            <span className={styles.tag}>relevée {formatAgo(database.lastCheckAt)}</span>
                        ) : (
                            // Dit explicitement que rien ne tourne : sans cela,
                            // « jamais testée » se lirait comme une panne alors
                            // que c'est le réglage par défaut.
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

                {/* Calée en haut : la flèche annonce que la carte s'ouvre, elle
                    n'appartient pas à la ligne d'état du bas. */}
                <span className={styles.openArrow} aria-hidden='true'>
                    <span className='icon icon-arrow' />
                </span>
            </div>
        </li>
    );
}

export default DatabaseList;

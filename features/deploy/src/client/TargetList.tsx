import { useDragReorder, type LiveOutlineProps } from 'deveye-sdk-client';
import type { DeployTarget } from '../contracts/domain';

import { formatAgo, isOrphan, STATUS_LABELS, statusTone, targetWhere } from './format';
import styles from './style.module.css';

interface TargetListProps {
    /** Les cibles, déjà dans l'ordre de l'utilisateur. */
    targets: DeployTarget[];
    outlineFor: (value: string | null) => LiveOutlineProps;
    /** Ranger est une écriture : sans le droit, la poignée n'existe pas. */
    canWrite: boolean;
    onOpen: (targetId: number) => void;
    onReorder: (ids: number[]) => void;
    onDragStateChange: (dragging: boolean) => void;
}

/**
 * La liste des cibles, réordonnable au glisser-déposer (`useDragReorder`). Ne
 * restent ici que l'apparence de la carte, de la poignée et de la barre.
 */
export function TargetList({ targets, outlineFor, canWrite, onOpen, onReorder, onDragStateChange }: TargetListProps) {
    const drag = useDragReorder<HTMLUListElement, HTMLLIElement>({
        ids: targets.map((t) => t.id),
        rowSelector: '[data-target-card]',
        onReorder: (ids) => onReorder(ids as number[]),
        onDragStateChange
    });

    return (
        <ul ref={drag.listRef} className={styles.grid}>
            {targets.map((target) => (
                <TargetCard
                    key={target.id}
                    target={target}
                    outline={outlineFor(String(target.id))}
                    dragging={drag.draggingId === target.id}
                    onOpen={() => onOpen(target.id)}
                    onDragPointerDown={canWrite ? (e) => drag.onGripPointerDown(e, target.id) : undefined}
                />
            ))}
            {/* Un `<li>` : seul enfant valide d'une `<ul>`. Sorti du flux, il
                n'occupe aucune cellule de la grille. */}
            <li ref={drag.barRef} className={styles.dropBar} aria-hidden='true' />
        </ul>
    );
}

interface TargetCardProps {
    target: DeployTarget;
    outline: LiveOutlineProps;
    dragging: boolean;
    onOpen: () => void;
    onDragPointerDown?: (e: React.PointerEvent) => void;
}

function TargetCard({ target, outline, dragging, onOpen, onDragPointerDown }: TargetCardProps) {
    // Un accès retiré prime sur l'état du dernier déploiement : plus rien ne
    // partira tant que la clé n'est pas revenue.
    const orphan = isOrphan(target);
    const tone = orphan ? 'danger' : statusTone(target.lastStatus);

    return (
        <li className={`${styles.card} ${dragging ? styles.cardDragging : ''}`} data-target-card='' {...outline}>
            {/* La poignée est sœur du corps cliquable, et non son enfant : un
                clic parti d'ici ne remonte pas jusqu'à « ouvrir la cible ». */}
            {onDragPointerDown && (
                <button
                    type='button'
                    className={styles.grip}
                    aria-label='Réordonner la cible'
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
                        <span className={styles.statusDot} data-tone={tone} aria-hidden='true' />
                        {target.name}
                        {/* Distingue une ligne locale d'une fenêtre sur l'espace voisin. */}
                        {target.foreign && (
                            <span
                                className={styles.statusTag}
                                data-tone='neutral'
                                title='Cette cible appartient à un autre espace qui la partage ici'
                            >
                                partagé
                            </span>
                        )}
                    </p>
                    <p className={styles.cardMeta}>{targetWhere(target)}</p>
                    <div className={styles.cardFoot}>
                        <span className={styles.statusTag} data-tone={tone}>
                            {orphan ? 'accès retiré' : target.lastStatus ? STATUS_LABELS[target.lastStatus] : 'jamais'}
                        </span>
                        <span>{formatAgo(target.lastDeployAt)}</span>
                        {target.projectCount > 0 && (
                            <span>
                                {target.projectCount} projet{target.projectCount > 1 ? 's' : ''}
                            </span>
                        )}
                    </div>
                </div>
            </div>
        </li>
    );
}

export default TargetList;

import type { DeployTarget } from 'deveye-types';

import { useDragReorder } from '@/dragReorder';
import type { useLiveOutlines } from '@/live/useLiveOutline';
import { formatAgo, hostOf, STATUS_LABELS, statusTone } from './format';
import styles from './style.module.css';

interface TargetListProps {
    /** Les cibles, déjà dans l'ordre de l'utilisateur. */
    targets: DeployTarget[];
    outlineFor: ReturnType<typeof useLiveOutlines>;
    /** Ranger est une écriture : sans le droit, la poignée n'existe pas. */
    canWrite: boolean;
    onOpen: (targetId: number) => void;
    onReorder: (ids: number[]) => void;
    onDragStateChange: (dragging: boolean) => void;
}

/**
 * La liste des cibles de déploiement, réordonnable au glisser-déposer.
 *
 * Le geste vit dans {@link ../../dragReorder}, partagé avec Uptime, Git,
 * Monitoring, les bases et les sites suivis. Ne restent ici que l'apparence de
 * la carte, celle de la poignée et celle de la barre d'insertion.
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
                    outline={outlineFor(`target:${target.id}`)}
                    dragging={drag.draggingId === target.id}
                    onOpen={() => onOpen(target.id)}
                    onDragPointerDown={canWrite ? (e) => drag.onGripPointerDown(e, target.id) : undefined}
                />
            ))}
            {/* Un `<li>` et non un `<span>` : dans une `<ul>`, seul un `<li>` est
                un enfant valide. Sorti du flux par `position: absolute`, il
                n'occupe aucune cellule de la grille. */}
            <li ref={drag.barRef} className={styles.dropBar} aria-hidden='true' />
        </ul>
    );
}

interface TargetCardProps {
    target: DeployTarget;
    outline: ReturnType<ReturnType<typeof useLiveOutlines>>;
    dragging: boolean;
    onOpen: () => void;
    onDragPointerDown?: (e: React.PointerEvent) => void;
}

function TargetCard({ target, outline, dragging, onOpen, onDragPointerDown }: TargetCardProps) {
    // Un accès retiré prime sur l'état du dernier déploiement : peu importe
    // qu'il ait réussi, plus rien ne partira tant que la clé n'est pas revenue.
    const orphan = target.credentialId === null;
    const tone = orphan ? 'danger' : statusTone(target.lastStatus);

    return (
        <li className={`${styles.card} ${dragging ? styles.cardDragging : ''}`} data-target-card='' {...outline}>
            {/* La poignée est sœur du corps cliquable, et non son enfant : un
                clic parti d'ici ne peut donc pas remonter jusqu'à « ouvrir la
                cible », même sans le neutraliser. */}
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
                        <span className={styles.statusDot} data-tone={tone} aria-hidden='true' />
                        {target.name}
                    </p>
                    <p className={styles.cardMeta}>
                        {target.kind === 'compose' ? 'pile compose' : 'application'} · {hostOf(target.baseUrl)}
                    </p>
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

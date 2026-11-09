import type { CSSProperties } from 'react';
import { useDragReorder } from 'deveye-sdk-client';

import { sourceColorVar } from './colors';
import { pagesUsing, type Plan } from './model';
import styles from './pdf.module.css';

interface SourceStripProps {
    plan: Plan;
    onRemove: (sourceId: string) => void;
    onReorder: (order: string[]) => void;
}

/** « 3 p. » quand tout est gardé, « 2 / 3 p. » quand il en manque, « 3 p. + 1 » quand une page est dupliquée. */
function pagesLabel(used: number, total: number): string {
    if (used === total) return `${total} p.`;
    if (used < total) return `${used} / ${total} p.`;
    return `${total} p. + ${used - total}`;
}

/** Les fichiers ouverts, une pastille chacun : sa couleur, ses pages gardées, et de quoi le retirer ou le déplacer. */
export function SourceStrip({ plan, onRemove, onReorder }: SourceStripProps) {
    const drag = useDragReorder<HTMLUListElement, HTMLLIElement>({
        ids: plan.sources.map((s) => s.id),
        rowSelector: '[data-source-chip]',
        layout: 'grid',
        onReorder: (order) => onReorder(order.map(String))
    });
    if (plan.sources.length === 0 && plan.images.length === 0) return null;

    return (
        <ul className={styles.strip} ref={drag.listRef} aria-label='Fichiers du document'>
            {plan.sources.map((source) => (
                <li
                    key={source.id}
                    data-source-chip
                    className={`${styles.chip} ${drag.draggingId === source.id ? styles.chipDragging : ''}`}
                    style={{ '--source-color': sourceColorVar(source.color) } as CSSProperties}
                >
                    {plan.sources.length > 1 && (
                        <span
                            className={styles.chipGrip}
                            title='Déplacer ce fichier et ses pages'
                            onPointerDown={(e) => drag.onGripPointerDown(e, source.id)}
                        >
                            <span className='icon icon-drag' aria-hidden='true' />
                        </span>
                    )}
                    <span className={styles.chipDot} aria-hidden='true' />
                    <span className={styles.chipName} title={source.name}>
                        {source.name}
                    </span>
                    <span className={styles.chipMeta}>
                        {pagesLabel(pagesUsing(plan, source.id), source.pages.length)}
                    </span>
                    {source.protectedByPassword && (
                        <span className={styles.chipLock} title='Ouvert avec son mot de passe'>
                            <span className='icon icon-lock' aria-hidden='true' />
                        </span>
                    )}
                    <button
                        type='button'
                        className={styles.chipRemove}
                        aria-label={`Retirer ${source.name}`}
                        title='Retirer ce fichier et ses pages'
                        onClick={() => onRemove(source.id)}
                    >
                        <span className='icon icon-x' aria-hidden='true' />
                    </button>
                </li>
            ))}
            {plan.images.length > 0 && (
                <li className={styles.chip}>
                    <span className='icon icon-file' aria-hidden='true' />
                    <span className={styles.chipMeta}>
                        {plan.images.length} image{plan.images.length > 1 ? 's' : ''}
                    </span>
                </li>
            )}
            <li ref={drag.barRef} className={styles.dropBarRow} aria-hidden='true' />
        </ul>
    );
}

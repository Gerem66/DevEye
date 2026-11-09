import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { useDragReorder, useFileDrop } from 'deveye-sdk-client';

import { sourceColorVar } from './colors';
import { displayedSize, moveTogether, sourceOf, totalRotation, type Plan, type PlanPage } from './model';
import styles from './pdf.module.css';
import { thumbnail } from './thumbnails';

/** La largeur de rendu d'une vignette, en pixels CSS : celle d'une carte sur un grand écran. */
const THUMB_WIDTH = 180;

/** Ce qu'un clic apporte de modificateurs : la sélection s'en sert, quelle que soit la touche ou la souris. */
export interface SelectGesture {
    shiftKey: boolean;
    ctrlKey: boolean;
    metaKey: boolean;
}

interface PageBoardProps {
    plan: Plan;
    selection: readonly string[];
    onSelect: (gesture: SelectGesture, id: string) => void;
    onReorder: (order: string[]) => void;
    onRemove: (id: string) => void;
    onFiles: (files: File[]) => void;
}

interface PageCardProps {
    page: PlanPage;
    plan: Plan;
    index: number;
    selected: boolean;
    dragging: boolean;
    onPointerDown: (e: ReactPointerEvent, id: string) => void;
    onSelect: (gesture: SelectGesture, id: string) => void;
    onRemove: (id: string) => void;
}

function originOf(page: PlanPage, plan: Plan): { label: string; color: string } {
    switch (page.kind) {
        case 'source': {
            const source = sourceOf(plan, page.sourceId);
            return {
                label: `${source?.name ?? 'Fichier'} · p. ${page.index + 1}`,
                color: sourceColorVar(source?.color ?? 0)
            };
        }
        case 'image':
            return {
                label: plan.images.find((i) => i.id === page.imageId)?.name ?? 'Image',
                color: 'var(--text-muted)'
            };
        case 'blank':
            return { label: 'Page blanche', color: 'var(--glass-border-strong)' };
    }
}

function PageCard({ page, plan, index, selected, dragging, onPointerDown, onSelect, onRemove }: PageCardProps) {
    const ref = useRef<HTMLLIElement>(null);
    const [url, setUrl] = useState<string | null>(null);
    const planRef = useRef(plan);
    planRef.current = plan;
    const size = displayedSize(page, plan);
    const rotation = totalRotation(page, plan);
    const origin = originOf(page, plan);

    // La vignette ne se dessine qu'à l'approche de l'écran : un document de mille pages n'en rend que quelques dizaines.
    useEffect(() => {
        const el = ref.current;
        if (!el) return;
        let cancelled = false;
        const observer = new IntersectionObserver(
            (entries) => {
                if (!entries.some((entry) => entry.isIntersecting)) return;
                observer.disconnect();
                thumbnail(page, planRef.current, THUMB_WIDTH)
                    .then((u) => {
                        if (!cancelled) setUrl(u);
                    })
                    .catch(() => undefined);
            },
            { rootMargin: '300px' }
        );
        observer.observe(el);
        return () => {
            cancelled = true;
            observer.disconnect();
        };
    }, [page, rotation]);

    return (
        <li
            ref={ref}
            data-page-card
            role='option'
            aria-selected={selected}
            aria-label={`Page ${index + 1}, ${origin.label}`}
            tabIndex={0}
            className={`${styles.card} ${selected ? styles.cardSelected : ''} ${dragging ? styles.cardDragging : ''}`}
            style={{ '--source-color': origin.color, '--ratio': size.width / size.height } as CSSProperties}
            onPointerDown={(e) => onPointerDown(e, page.id)}
            onClick={(e) => onSelect(e, page.id)}
            onKeyDown={(e) => {
                if (e.key === ' ' || e.key === 'Enter') {
                    e.preventDefault();
                    onSelect(e, page.id);
                }
            }}
        >
            <div className={styles.thumbBox}>
                {url ? (
                    <img className={styles.thumb} src={url} alt='' draggable={false} />
                ) : (
                    <div className={styles.thumbPending} />
                )}
            </div>
            {selected && (
                <span className={styles.cardCheck} aria-hidden='true'>
                    <span className='icon icon-v' />
                </span>
            )}
            <div
                className={styles.cardTools}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => e.stopPropagation()}
            >
                <button
                    type='button'
                    className={`${styles.cardTool} ${styles.cardToolDanger}`}
                    aria-label='Retirer cette page'
                    title='Retirer'
                    onClick={() => onRemove(page.id)}
                >
                    <span className='icon icon-trash' aria-hidden='true' />
                </button>
            </div>
            <div className={styles.cardFoot}>
                <span className={styles.cardNum}>{index + 1}</span>
                <span className={styles.cardOrigin} title={origin.label}>
                    <span className={styles.cardOriginDot} aria-hidden='true' />
                    <span className={styles.cardOriginText}>{origin.label}</span>
                </span>
            </div>
        </li>
    );
}

/**
 * La grille des pages du document à produire. Un clic sélectionne, Maj étend,
 * Ctrl ajoute ; un glissé déplace la page, et toute la sélection avec elle
 * quand elle en fait partie. Des fichiers déposés dessus s'ajoutent à la fin.
 */
export function PageBoard({ plan, selection, onSelect, onReorder, onRemove, onFiles }: PageBoardProps) {
    const order = plan.pages.map((p) => p.id);
    const pressed = useRef<string | null>(null);
    /** Un glissé vient de finir : le clic qui le suit n'est pas une sélection. */
    const justDragged = useRef(false);
    const drag = useDragReorder<HTMLUListElement, HTMLLIElement>({
        ids: order,
        rowSelector: '[data-page-card]',
        layout: 'grid',
        onReorder: (next) => {
            const dragged = pressed.current;
            if (dragged === null) return;
            onReorder(moveTogether(order, next.map(String), dragged, selection));
        },
        onDragStateChange: (dragging) => {
            if (dragging) justDragged.current = true;
            else window.setTimeout(() => (justDragged.current = false), 0);
        }
    });
    const drop = useFileDrop((picked) => onFiles(picked.map((p) => p.file)));

    const onPointerDown = (e: ReactPointerEvent, id: string): void => {
        pressed.current = id;
        drag.onGripPointerDown(e, id);
    };
    const select = (gesture: SelectGesture, id: string): void => {
        if (justDragged.current) return;
        onSelect(gesture, id);
    };

    return (
        <ul
            ref={drag.listRef}
            className={`${styles.board} ${drop.over ? styles.boardOver : ''}`}
            role='listbox'
            aria-multiselectable='true'
            aria-label='Pages du document'
            {...drop.props}
        >
            {plan.pages.map((page, index) => (
                <PageCard
                    key={page.id}
                    page={page}
                    plan={plan}
                    index={index}
                    selected={selection.includes(page.id)}
                    dragging={drag.draggingId === page.id}
                    onPointerDown={onPointerDown}
                    onSelect={select}
                    onRemove={onRemove}
                />
            ))}
            <li ref={drag.barRef} className={styles.dropBar} aria-hidden='true' />
        </ul>
    );
}

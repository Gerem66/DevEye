import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { useDismissLayer } from '@/Components/Dialog';

import styles from './style.module.css';

export interface ActionMenuItem {
    label: string;
    icon?: string;
    onSelect: () => void;
    /** Une action destructrice : en rouge. */
    danger?: boolean;
    disabled?: boolean;
    /** Ce que fait l'action, en une phrase, sous le libellé. */
    detail?: string;
}

export interface ActionMenuProps {
    items: readonly ActionMenuItem[];
    /** Le nom du bouton pour les lecteurs d'écran et l'infobulle. */
    label?: string;
    className?: string;
    /** Le contenu du bouton à la place de « ⋯ » : il perd alors son habillage rond, `className` le dessine. */
    trigger?: ReactNode;
}

const GAP = 4;
const PANEL_WIDTH = 260;

/** Un bouton « ⋯ » qui déplie des actions secondaires, posé au-dessus de tout (le panneau n'est jamais rogné par un parent défilant). */
export default function ActionMenu({ items, label = 'Plus d’actions', className, trigger: content }: ActionMenuProps) {
    const [open, setOpen] = useState(false);
    const [anchor, setAnchor] = useState<{ left: number; top?: number; bottom?: number } | null>(null);
    const trigger = useRef<HTMLButtonElement>(null);
    const panel = useRef<HTMLDivElement>(null);
    const id = useId();

    const close = (refocus: boolean): void => {
        setOpen(false);
        setAnchor(null);
        if (refocus) trigger.current?.focus();
    };
    useDismissLayer(open, () => close(true));

    useLayoutEffect(() => {
        if (!open) return;
        const place = (): void => {
            const rect = trigger.current?.getBoundingClientRect();
            if (!rect) return;
            const width = Math.min(PANEL_WIDTH, window.innerWidth - GAP * 4);
            const up = window.innerHeight - rect.bottom < 220 && rect.top > window.innerHeight - rect.bottom;
            setAnchor({
                left: Math.max(GAP * 2, Math.min(rect.right - width, window.innerWidth - width - GAP * 2)),
                ...(up ? { bottom: window.innerHeight - rect.top + GAP } : { top: rect.bottom + GAP })
            });
        };
        place();
        window.addEventListener('resize', place);
        window.addEventListener('scroll', place, true);
        return () => {
            window.removeEventListener('resize', place);
            window.removeEventListener('scroll', place, true);
        };
    }, [open]);

    useEffect(() => {
        if (!open) return;
        const outside = (event: MouseEvent): void => {
            const target = event.target as Node;
            if (trigger.current?.contains(target) || panel.current?.contains(target)) return;
            close(false);
        };
        document.addEventListener('mousedown', outside);
        return () => document.removeEventListener('mousedown', outside);
    }, [open]);

    useEffect(() => {
        if (open && anchor) panel.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    }, [open, anchor]);

    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Tab') return;
        const buttons = [...(panel.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
        if (buttons.length === 0) return;
        event.preventDefault();
        const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const back = event.key === 'ArrowUp' || (event.key === 'Tab' && event.shiftKey);
        buttons[(at + (back ? -1 : 1) + buttons.length) % buttons.length].focus();
    };

    return (
        <>
            <button
                ref={trigger}
                type='button'
                className={
                    content === undefined
                        ? `${styles.trigger} ${open ? styles.triggerOpen : ''} ${className ?? ''}`
                        : className
                }
                title={label}
                aria-label={label}
                aria-haspopup='menu'
                aria-expanded={open}
                aria-controls={open ? id : undefined}
                onClick={() => (open ? close(false) : setOpen(true))}
            >
                {content ?? <span className='icon icon-dots' aria-hidden='true' />}
            </button>
            {open &&
                anchor &&
                createPortal(
                    <div
                        ref={panel}
                        id={id}
                        role='menu'
                        aria-label={label}
                        className={styles.panel}
                        style={{ left: anchor.left, top: anchor.top, bottom: anchor.bottom }}
                        onKeyDown={onKeyDown}
                    >
                        {items.map((item) => (
                            <button
                                key={item.label}
                                type='button'
                                role='menuitem'
                                className={`${styles.item} ${item.danger ? styles.itemDanger : ''}`}
                                disabled={item.disabled}
                                onClick={() => {
                                    close(true);
                                    item.onSelect();
                                }}
                            >
                                {item.icon && <span className={`icon icon-${item.icon} ${styles.itemIcon}`} />}
                                <span className={styles.itemText}>
                                    <span className={styles.itemLabel}>{item.label}</span>
                                    {item.detail && <span className={styles.itemDetail}>{item.detail}</span>}
                                </span>
                            </button>
                        ))}
                    </div>,
                    document.body
                )}
        </>
    );
}

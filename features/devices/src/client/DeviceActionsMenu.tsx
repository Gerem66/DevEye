import { useEffect, useRef, useState } from 'react';
import { useDismissLayer } from 'deveye-sdk-client';

import type { Unavailable } from './availability';
import styles from './style.module.css';

export interface DeviceAction {
    /** Icon class (e.g. `icon-terminal`), shown next to the label. */
    icon: string;
    label: string;
    onClick: () => void;
    /**
     * Ce qui empêche ce geste, s'il y a. L'entrée reste dans la liste, inerte,
     * marquée du glyphe du motif et sa phrase en infobulle : montrer ce qu'on ne
     * peut pas faire dit à quoi la machine sert, le cacher laisse croire qu'elle
     * ne le sait pas. Les motifs et leur ordre sont dans `availability.ts`.
     */
    unavailable?: Unavailable;
}

/**
 * "Fonctions" dropdown of the per-device panel header: one labelled entry per
 * device feature. Closes on pick, outside click, or Escape (through the shared
 * dismiss-layer stack, so nested overlays keep their order).
 */
export function DeviceActionsMenu({ actions }: { actions: DeviceAction[] }) {
    const [open, setOpen] = useState(false);
    const rootRef = useRef<HTMLDivElement>(null);

    useDismissLayer(open, () => setOpen(false));

    useEffect(() => {
        if (!open) return;
        const onPointerDown = (e: MouseEvent) => {
            if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
        };
        document.addEventListener('mousedown', onPointerDown);
        return () => document.removeEventListener('mousedown', onPointerDown);
    }, [open]);

    if (actions.length === 0) return null;

    return (
        <div className={styles.actionsMenuWrap} ref={rootRef}>
            <button
                type='button'
                className={`${styles.iconHeaderBtn} ${styles.actionsMenuBtn} ${open ? styles.actionsMenuBtnOpen : ''}`}
                onClick={() => setOpen((v) => !v)}
                title='Fonctions de l’appareil'
                aria-haspopup='menu'
                aria-expanded={open}
            >
                <span className='icon icon-menu' />
                Fonctions
                <span className={`icon icon-chevron-down ${styles.actionsMenuChevron}`} />
            </button>
            {open && (
                <div className={styles.actionsMenu} role='menu'>
                    {actions.map((a) => (
                        <button
                            key={a.label}
                            type='button'
                            role='menuitem'
                            className={`${styles.actionsMenuItem} ${a.unavailable ? styles.actionsMenuItemLocked : ''}`}
                            // `aria-disabled` et non `disabled` : l'entrée doit
                            // rester atteignable au clavier et son infobulle
                            // lisible, puisque c'est elle qui dit pourquoi.
                            aria-disabled={a.unavailable !== undefined}
                            title={a.unavailable?.reason}
                            onClick={() => {
                                if (a.unavailable) return;
                                setOpen(false);
                                a.onClick();
                            }}
                        >
                            <span className={`icon ${a.icon} ${styles.actionsMenuItemIcon}`} />
                            {a.label}
                            {a.unavailable && (
                                <span className={`icon ${a.unavailable.icon} ${styles.actionsMenuItemLock}`} />
                            )}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}

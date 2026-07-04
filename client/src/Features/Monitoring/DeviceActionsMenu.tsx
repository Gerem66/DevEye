import { useEffect, useRef, useState } from 'react';
import { useDismissLayer } from '@/Components/Dialog';
import styles from './Monitoring.module.css';

export interface DeviceAction {
    /** Icon class (e.g. `icon-terminal`), shown next to the label. */
    icon: string;
    label: string;
    onClick: () => void;
}

/**
 * "Fonctions" dropdown of the per-device panel header: one labelled entry
 * (icon + text) per device feature — hardware sheet, collection config,
 * system updates, file explorer, terminal, logs, power… — replacing the old
 * row of bare icon buttons. Closes on pick, outside click, or Escape (through
 * the shared dismiss-layer stack, so nested overlays keep their order).
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
                            className={styles.actionsMenuItem}
                            onClick={() => {
                                setOpen(false);
                                a.onClick();
                            }}
                        >
                            <span className={`icon ${a.icon} ${styles.actionsMenuItemIcon}`} />
                            {a.label}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}

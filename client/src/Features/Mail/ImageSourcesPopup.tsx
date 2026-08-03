import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import Button from '@/Components/Button';
import styles from './style.module.css';

interface ImageSourcesPopupProps {
    /** Element the popup anchors under — also its own toggle button. */
    anchorRef: React.RefObject<HTMLElement | null>;
    open: boolean;
    onClose: () => void;
    sources: string[];
    onLoadNow: () => void;
    onTrustAlways: (domains: string[]) => void;
}

/**
 * Small popup listing the remote-image hostnames a message had blocked, each
 * individually checkable. Portaled + positioned like `AccountSwitcher`'s
 * panel, for the same reason: it must escape WidgetPopup's clipping.
 */
export function ImageSourcesPopup({
    anchorRef,
    open,
    onClose,
    sources,
    onLoadNow,
    onTrustAlways
}: ImageSourcesPopupProps) {
    const [checked, setChecked] = useState<ReadonlySet<string>>(() => new Set(sources));
    const [rect, setRect] = useState<{ top: number; left: number } | null>(null);
    const panelRef = useRef<HTMLDivElement>(null);

    useLayoutEffect(() => {
        if (!open) return;
        setChecked(new Set(sources));
        const box = anchorRef.current?.getBoundingClientRect();
        if (box) setRect({ top: box.bottom + 6, left: box.left });
    }, [open]);

    useLayoutEffect(() => {
        if (!open) return;
        function onDocPointerDown(e: PointerEvent) {
            const target = e.target as Node;
            if (panelRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
            onClose();
        }
        function onKeyDown(e: KeyboardEvent) {
            if (e.key === 'Escape') onClose();
        }
        document.addEventListener('pointerdown', onDocPointerDown);
        document.addEventListener('keydown', onKeyDown);
        return () => {
            document.removeEventListener('pointerdown', onDocPointerDown);
            document.removeEventListener('keydown', onKeyDown);
        };
    }, [open, onClose, anchorRef]);

    if (!open || !rect) return null;

    function toggle(source: string): void {
        setChecked((prev) => {
            const next = new Set(prev);
            if (next.has(source)) next.delete(source);
            else next.add(source);
            return next;
        });
    }

    return createPortal(
        <div ref={panelRef} className={styles.imageSourcesPopup} style={{ top: rect.top, left: rect.left }}>
            <p className={styles.imageSourcesTitle}>Images bloquées sur ce message</p>
            <div className={styles.imageSourcesList}>
                {sources.map((source) => (
                    <label key={source} className={styles.imageSourceRow}>
                        <input type='checkbox' checked={checked.has(source)} onChange={() => toggle(source)} />
                        <span>{source}</span>
                    </label>
                ))}
            </div>
            <div className={styles.imageSourcesActions}>
                <Button
                    variant='secondary'
                    onClick={() => {
                        onLoadNow();
                        onClose();
                    }}
                >
                    Charger maintenant
                </Button>
                <Button
                    disabled={checked.size === 0}
                    onClick={() => {
                        onTrustAlways(Array.from(checked));
                        onClose();
                    }}
                >
                    Toujours autoriser
                </Button>
            </div>
        </div>,
        document.body
    );
}

export default ImageSourcesPopup;

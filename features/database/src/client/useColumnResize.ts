import { useCallback, useRef, useState, type PointerEvent, type RefObject } from 'react';

/** Largeur plancher d'une colonne tirée à la main. */
const MIN_WIDTH = 48;

interface Drag {
    index: number;
    startX: number;
    /** Les largeurs au départ du geste, puis celles qu'il a données. */
    from: number[];
    to: number[];
}

/**
 * Des colonnes qui se redimensionnent à la poignée, sans rien retenir d'une
 * table à l'autre. Au premier geste, les largeurs naturelles de toutes les
 * colonnes sont figées : en tirer une ne change plus que la sienne. Pendant le
 * geste la largeur s'écrit dans le DOM, l'état ne la reprend qu'au
 * relâchement : le tableau n'est pas rendu à chaque pixel.
 */
export function useColumnResize(tableRef: RefObject<HTMLTableElement | null>) {
    /** Une largeur par colonne, dans l'ordre de l'en-tête ; `null` = largeurs naturelles. */
    const [widths, setWidths] = useState<number[] | null>(null);
    const drag = useRef<Drag | null>(null);

    const reset = useCallback(() => setWidths(null), []);

    const release = () => {
        if (drag.current) setWidths(drag.current.to);
        drag.current = null;
    };

    /** Ce que porte la poignée de la colonne `index`. */
    const grip = (index: number) => ({
        onPointerDown: (event: PointerEvent<HTMLElement>) => {
            const table = tableRef.current;
            if (!table || event.button !== 0) return;
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            const from =
                widths ?? Array.from(table.querySelectorAll('thead th'), (th) => th.getBoundingClientRect().width);
            drag.current = { index, startX: event.clientX, from, to: from };
            if (!widths) setWidths(from);
        },
        onPointerMove: (event: PointerEvent<HTMLElement>) => {
            const current = drag.current;
            const table = tableRef.current;
            const column = table?.querySelectorAll('col')[index];
            if (!current || !table || !column) return;
            const width = Math.max(MIN_WIDTH, current.from[index] + event.clientX - current.startX);
            current.to = current.from.map((w, i) => (i === index ? width : w));
            column.style.width = `${width}px`;
            table.style.width = `${current.to.reduce((sum, w) => sum + w, 0)}px`;
        },
        onPointerUp: release,
        onPointerCancel: release,
        onDoubleClick: reset
    });

    return { widths, reset, grip };
}

import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';

import type { Point } from './geometry';
import styles from './pdf.module.css';

/** L'épaisseur du trait, dans les unités du pavé (des pixels CSS). */
export const PAD_STROKE = 2.5;
const PAD_INK = '#1a1a1f';

interface SignaturePadProps {
    strokes: readonly (readonly Point[])[];
    onChange: (strokes: readonly (readonly Point[])[]) => void;
}

/** Un pavé où l'on signe à la souris ou au doigt : chaque pression est un trait. */
export function SignaturePad({ strokes, onChange }: SignaturePadProps) {
    const canvas = useRef<HTMLCanvasElement>(null);
    const current = useRef<Point[] | null>(null);

    useEffect(() => {
        const el = canvas.current;
        if (!el) return;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const { width, height } = el.getBoundingClientRect();
        el.width = Math.round(width * dpr);
        el.height = Math.round(height * dpr);
        const ctx = el.getContext('2d');
        if (!ctx) return;
        ctx.scale(dpr, dpr);
        ctx.lineWidth = PAD_STROKE;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.strokeStyle = PAD_INK;
        for (const stroke of [...strokes, ...(current.current ? [current.current] : [])]) {
            if (stroke.length === 0) continue;
            ctx.beginPath();
            ctx.moveTo(stroke[0].x, stroke[0].y);
            for (const p of stroke.slice(1)) ctx.lineTo(p.x, p.y);
            if (stroke.length === 1) ctx.lineTo(stroke[0].x + 0.1, stroke[0].y);
            ctx.stroke();
        }
    });

    const at = (e: ReactPointerEvent): Point => {
        const r = e.currentTarget.getBoundingClientRect();
        return { x: e.clientX - r.left, y: e.clientY - r.top };
    };

    return (
        <canvas
            ref={canvas}
            className={styles.sigPad}
            aria-label='Zone de signature'
            onPointerDown={(e) => {
                if (e.button !== 0) return;
                e.currentTarget.setPointerCapture(e.pointerId);
                current.current = [at(e)];
                onChange([...strokes, current.current]);
            }}
            onPointerMove={(e) => {
                if (!current.current) return;
                current.current.push(at(e));
                onChange([...strokes.slice(0, -1), [...current.current]]);
            }}
            onPointerUp={() => {
                current.current = null;
            }}
            onPointerCancel={() => {
                current.current = null;
            }}
        />
    );
}

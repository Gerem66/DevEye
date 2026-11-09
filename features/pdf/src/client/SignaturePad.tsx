import { useEffect, useRef } from 'react';

import { smoothPoints } from './elements';
import type { Point } from './geometry';
import styles from './pdf.module.css';

/** L'épaisseur du trait, dans les unités du pavé (des pixels CSS). */
export const PAD_STROKE = 2.5;
const PAD_INK = '#1a1a1f';
/** Un échantillon plus près que ça du précédent n'apporte que du tremblement. */
const MIN_STEP = 1.5;

/** Le trait tel que `smoothPath` le rend : une quadratique par échantillon, jusqu'au milieu du segment suivant. */
function trace(ctx: CanvasRenderingContext2D, stroke: readonly Point[]): void {
    ctx.beginPath();
    ctx.moveTo(stroke[0].x, stroke[0].y);
    if (stroke.length < 3) {
        for (const p of stroke.slice(1)) ctx.lineTo(p.x, p.y);
        if (stroke.length === 1) ctx.lineTo(stroke[0].x + 0.1, stroke[0].y);
    } else {
        for (let i = 1; i < stroke.length - 1; i++) {
            const next = stroke[i + 1];
            ctx.quadraticCurveTo(stroke[i].x, stroke[i].y, (stroke[i].x + next.x) / 2, (stroke[i].y + next.y) / 2);
        }
        const last = stroke[stroke.length - 1];
        ctx.lineTo(last.x, last.y);
    }
    ctx.stroke();
}

interface SignaturePadProps {
    /** Les traits tels que saisis ; le lissage ne s'applique qu'au dessin. */
    strokes: readonly (readonly Point[])[];
    onChange: (strokes: readonly (readonly Point[])[]) => void;
    smoothing: number;
}

/** Un pavé où l'on signe à la souris ou au doigt : chaque pression est un trait. */
export function SignaturePad({ strokes, onChange, smoothing }: SignaturePadProps) {
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
            if (stroke.length > 0) trace(ctx, smoothPoints(stroke, smoothing));
        }
    });

    const at = (e: { clientX: number; clientY: number }, r: DOMRect): Point => ({
        x: e.clientX - r.left,
        y: e.clientY - r.top
    });

    return (
        <canvas
            ref={canvas}
            className={styles.sigPad}
            aria-label='Zone de signature'
            onPointerDown={(e) => {
                if (e.button !== 0) return;
                e.currentTarget.setPointerCapture(e.pointerId);
                current.current = [at(e, e.currentTarget.getBoundingClientRect())];
                onChange([...strokes, current.current]);
            }}
            onPointerMove={(e) => {
                const stroke = current.current;
                if (!stroke) return;
                // Le navigateur regroupe les mouvements par image : les échantillons intermédiaires sont dans l'événement.
                const r = e.currentTarget.getBoundingClientRect();
                const samples = e.nativeEvent.getCoalescedEvents?.() ?? [];
                for (const sample of samples.length > 0 ? samples : [e]) {
                    const p = at(sample, r);
                    const last = stroke[stroke.length - 1];
                    if (Math.hypot(p.x - last.x, p.y - last.y) >= MIN_STEP) stroke.push(p);
                }
                onChange([...strokes.slice(0, -1), [...stroke]]);
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

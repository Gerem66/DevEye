import {
    useEffect,
    useRef,
    useState,
    type CSSProperties,
    type KeyboardEvent,
    type PointerEvent as ReactPointerEvent,
    type ReactNode
} from 'react';

import { assetUrl } from './documents';
import {
    clampToPage,
    HIGHLIGHT,
    HIGHLIGHT_OPACITY,
    INK,
    KEEPS_ASPECT,
    MARK_BOX,
    MARK_PATHS,
    MIN_ELEMENT_SIZE,
    rectBetween,
    rectOf,
    strokesPath,
    TEXT_LINE_HEIGHT,
    type InkColor,
    type PdfElement
} from './elements';
import { HAND_FONT_FAMILY } from './fonts';
import type { Point, Rect } from './geometry';
import { displayedSize, type Plan, type PlanPage, type Size } from './model';
import styles from './pdf.module.css';
import { thumbnail } from './thumbnails';
import { DRAW_TOOLS, type Tool } from './tools';

/** La page ne s'affiche pas plus large : au-delà, le texte d'un A4 se lit de loin. */
const STAGE_MAX_WIDTH = 920;
/** L'épaisseur d'un trait à main levée, en points. */
const INK_STROKE = 2;
const NUDGE = 1;
const NUDGE_FAST = 10;

type Corner = 'nw' | 'ne' | 'sw' | 'se';

type Gesture =
    | { kind: 'move'; id: string; start: Point; origin: Rect }
    | { kind: 'resize'; id: string; corner: Corner; origin: Rect; aspect: number | null }
    | { kind: 'draw'; start: Point; current: Point }
    | { kind: 'ink'; points: Point[] };

type Live = { kind: 'rect'; id: string | null; rect: Rect } | { kind: 'ink'; points: Point[] };

interface StageProps {
    page: PlanPage;
    plan: Plan;
    elements: readonly PdfElement[];
    /** Les éléments des autres pages qui se répètent ici, déjà placés : montrés, pas touchés. */
    ghosts: readonly PdfElement[];
    selectedId: string | null;
    tool: Tool;
    onSelect: (id: string | null) => void;
    /** Un clic avec un outil qui pose (signature, texte, coche…) : où. */
    onStamp: (at: Point) => void;
    /** Un rectangle tracé du bout du pointeur. */
    onDraw: (tool: 'highlight' | 'box' | 'redact', rect: Rect) => void;
    onInk: (path: string, box: Rect) => void;
    onUpdate: (id: string, rect: Rect) => void;
    onRemove: (id: string) => void;
}

const css = (rgb: readonly [number, number, number], alpha = 1): string =>
    `rgba(${Math.round(rgb[0] * 255)}, ${Math.round(rgb[1] * 255)}, ${Math.round(rgb[2] * 255)}, ${alpha})`;
export const inkCss = (color: InkColor): string => css(INK[color].rgb);

/** Le dessin d'un élément, dans sa boîte à l'écran. */
function Content({ el, rect, scale }: { el: PdfElement; rect: Rect; scale: number }) {
    const path = (d: string, box: Size, color: InkColor, stroke: number) => (
        <svg className={styles.elSvg} viewBox={`0 0 ${box.width} ${box.height}`} preserveAspectRatio='none'>
            <path
                d={d}
                fill='none'
                stroke={inkCss(color)}
                strokeWidth={stroke}
                strokeLinecap='round'
                strokeLinejoin='round'
            />
        </svg>
    );
    switch (el.kind) {
        case 'text':
            return (
                <div
                    className={styles.elText}
                    style={{
                        fontSize: `${el.size * scale}px`,
                        lineHeight: TEXT_LINE_HEIGHT,
                        color: inkCss(el.color),
                        fontFamily: el.hand ? `'${HAND_FONT_FAMILY}', cursive` : undefined
                    }}
                >
                    {el.text}
                </div>
            );
        case 'signature':
            switch (el.signature.kind) {
                case 'path':
                    return path(el.signature.path, el.signature, el.color, el.signature.stroke);
                case 'text':
                    return (
                        <div
                            className={styles.elHand}
                            style={{
                                fontSize: `${(rect.height / TEXT_LINE_HEIGHT) * scale}px`,
                                lineHeight: TEXT_LINE_HEIGHT,
                                color: inkCss(el.color)
                            }}
                        >
                            {el.signature.text}
                        </div>
                    );
                case 'image':
                    return (
                        <img className={styles.elImage} src={assetUrl(el.signature.assetId)} alt='' draggable={false} />
                    );
            }
            break;
        case 'mark':
            return path(MARK_PATHS[el.mark], { width: MARK_BOX, height: MARK_BOX }, el.color, 2.5);
        case 'image':
            return <img className={styles.elImage} src={assetUrl(el.assetId)} alt='' draggable={false} />;
        case 'highlight':
            return (
                <div
                    className={styles.elHighlight}
                    style={{ background: css(HIGHLIGHT[el.color].rgb, HIGHLIGHT_OPACITY) }}
                />
            );
        case 'box':
            return (
                <div
                    className={styles.elBox}
                    style={{
                        background: el.fill === 'white' ? '#ffffff' : 'transparent',
                        border: el.border ? `${Math.max(1, 1.2 * scale)}px solid ${inkCss(el.border)}` : 'none'
                    }}
                />
            );
        case 'ink':
            return path(el.path, { width: el.pathWidth, height: el.pathHeight }, el.color, el.stroke);
        case 'redact':
            return <div className={styles.elRedact} />;
    }
    return null;
}

/**
 * La page affichée avec ce qui est posé dessus. Un clic sélectionne, un
 * glissé déplace, les coins redimensionnent ; les outils qui tracent le font
 * ici aussi. Les positions se comptent en points de la page, à `scale` près.
 */
export function Stage(props: StageProps) {
    const { page, plan, elements, ghosts, selectedId, tool, onSelect, onStamp, onDraw, onInk, onUpdate, onRemove } =
        props;
    const wrap = useRef<HTMLDivElement>(null);
    const overlay = useRef<HTMLDivElement>(null);
    const [stageWidth, setStageWidth] = useState(0);
    const [url, setUrl] = useState<string | null>(null);
    const gesture = useRef<Gesture | null>(null);
    const [live, setLive] = useState<Live | null>(null);

    const pageSize = displayedSize(page, plan);
    const scale = stageWidth > 0 ? stageWidth / pageSize.width : 1;

    useEffect(() => {
        const el = wrap.current;
        if (!el) return;
        const measure = () => setStageWidth(Math.max(120, Math.min(STAGE_MAX_WIDTH, Math.floor(el.clientWidth))));
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(el);
        return () => observer.disconnect();
    }, []);

    const rotation = page.rotation;
    useEffect(() => {
        if (stageWidth === 0) return;
        let cancelled = false;
        thumbnail(page, plan, stageWidth)
            .then((u) => {
                if (!cancelled) setUrl(u);
            })
            .catch(() => undefined);
        return () => {
            cancelled = true;
        };
        // La vignette dépend de la page, de sa rotation et de la largeur ; le plan ne change que les deux premières.
    }, [page, rotation, stageWidth, plan]);

    const toPage = (e: ReactPointerEvent): Point => {
        const r = overlay.current?.getBoundingClientRect();
        if (!r) return { x: 0, y: 0 };
        return { x: (e.clientX - r.left) / scale, y: (e.clientY - r.top) / scale };
    };
    const byId = (id: string) => elements.find((e) => e.id === id);

    const resized = (g: Extract<Gesture, { kind: 'resize' }>, p: Point, startPoint: Point): Rect => {
        const dx = p.x - startPoint.x;
        const dy = p.y - startPoint.y;
        const o = g.origin;
        const right = g.corner === 'ne' || g.corner === 'se';
        const bottom = g.corner === 'sw' || g.corner === 'se';
        let width = Math.max(MIN_ELEMENT_SIZE, right ? o.width + dx : o.width - dx);
        let height = Math.max(MIN_ELEMENT_SIZE, bottom ? o.height + dy : o.height - dy);
        if (g.aspect !== null) height = width / g.aspect;
        width = Math.min(width, pageSize.width);
        height = Math.min(height, pageSize.height);
        return clampToPage(
            { x: right ? o.x : o.x + o.width - width, y: bottom ? o.y : o.y + o.height - height, width, height },
            pageSize
        );
    };
    const startPoint = useRef<Point>({ x: 0, y: 0 });

    const onPointerDown = (e: ReactPointerEvent): void => {
        if (e.button !== 0) return;
        const target = e.target as HTMLElement;
        const corner = target.closest('[data-corner]')?.getAttribute('data-corner') as Corner | null;
        const elId = target.closest('[data-el]')?.getAttribute('data-el') ?? null;
        const p = toPage(e);
        startPoint.current = p;
        let g: Gesture | null = null;
        if (tool === 'select') {
            const el = (corner && selectedId ? byId(selectedId) : null) ?? (elId ? byId(elId) : undefined);
            if (corner && selectedId && el) {
                g = {
                    kind: 'resize',
                    id: el.id,
                    corner,
                    origin: rectOf(el),
                    aspect: KEEPS_ASPECT.includes(el.kind) ? el.width / el.height : null
                };
            } else if (el) {
                onSelect(el.id);
                g = { kind: 'move', id: el.id, start: p, origin: rectOf(el) };
            } else {
                onSelect(null);
                return;
            }
        } else if (DRAW_TOOLS.includes(tool)) {
            g = { kind: 'draw', start: p, current: p };
        } else if (tool === 'ink') {
            g = { kind: 'ink', points: [p] };
        } else {
            onStamp(p);
            return;
        }
        gesture.current = g;
        overlay.current?.setPointerCapture(e.pointerId);
        e.preventDefault();
    };

    const onPointerMove = (e: ReactPointerEvent): void => {
        const g = gesture.current;
        if (!g) return;
        const p = toPage(e);
        switch (g.kind) {
            case 'move':
                setLive({
                    kind: 'rect',
                    id: g.id,
                    rect: clampToPage(
                        { ...g.origin, x: g.origin.x + p.x - g.start.x, y: g.origin.y + p.y - g.start.y },
                        pageSize
                    )
                });
                break;
            case 'resize':
                setLive({ kind: 'rect', id: g.id, rect: resized(g, p, startPoint.current) });
                break;
            case 'draw':
                g.current = p;
                setLive({ kind: 'rect', id: null, rect: rectBetween(g.start, p) });
                break;
            case 'ink':
                g.points.push(p);
                setLive({ kind: 'ink', points: [...g.points] });
                break;
        }
    };

    const onPointerUp = (): void => {
        const g = gesture.current;
        gesture.current = null;
        const current = live;
        setLive(null);
        if (!g) return;
        switch (g.kind) {
            case 'move':
            case 'resize': {
                if (current?.kind !== 'rect') return;
                const o = g.origin;
                const r = current.rect;
                if (r.x !== o.x || r.y !== o.y || r.width !== o.width || r.height !== o.height) onUpdate(g.id, r);
                break;
            }
            case 'draw': {
                const rect = rectBetween(g.start, g.current);
                if (
                    rect.width >= MIN_ELEMENT_SIZE &&
                    rect.height >= MIN_ELEMENT_SIZE &&
                    tool !== 'select' &&
                    tool !== 'ink'
                ) {
                    onDraw(tool as 'highlight' | 'box' | 'redact', clampToPage(rect, pageSize));
                }
                break;
            }
            case 'ink': {
                const ink = strokesPath([g.points], INK_STROKE);
                if (ink && (ink.box.width > MIN_ELEMENT_SIZE || ink.box.height > MIN_ELEMENT_SIZE))
                    onInk(ink.path, ink.box);
                break;
            }
        }
    };

    const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
        if (!selectedId) return;
        const el = byId(selectedId);
        if (!el) return;
        if (e.key === 'Delete' || e.key === 'Backspace') {
            e.preventDefault();
            onRemove(selectedId);
            return;
        }
        const step = e.shiftKey ? NUDGE_FAST : NUDGE;
        const moves: Record<string, Point> = {
            ArrowLeft: { x: -step, y: 0 },
            ArrowRight: { x: step, y: 0 },
            ArrowUp: { x: 0, y: -step },
            ArrowDown: { x: 0, y: step }
        };
        const move = moves[e.key];
        if (!move) return;
        e.preventDefault();
        onUpdate(selectedId, clampToPage({ ...rectOf(el), x: el.x + move.x, y: el.y + move.y }, pageSize));
    };

    const rectFor = (el: PdfElement): Rect => (live?.kind === 'rect' && live.id === el.id ? live.rect : rectOf(el));
    const place = (rect: Rect): CSSProperties => ({
        left: rect.x * scale,
        top: rect.y * scale,
        width: rect.width * scale,
        height: rect.height * scale
    });

    let preview: ReactNode = null;
    if (live?.kind === 'rect' && live.id === null) {
        preview = <div className={`${styles.el} ${styles.elDrawing}`} style={place(live.rect)} />;
    } else if (live?.kind === 'ink') {
        const ink = strokesPath([live.points], INK_STROKE);
        if (ink) {
            preview = (
                <div className={styles.el} style={place(ink.box)}>
                    <svg
                        className={styles.elSvg}
                        viewBox={`0 0 ${ink.box.width} ${ink.box.height}`}
                        preserveAspectRatio='none'
                    >
                        <path
                            d={ink.path}
                            fill='none'
                            stroke='currentColor'
                            strokeWidth={INK_STROKE}
                            strokeLinecap='round'
                            strokeLinejoin='round'
                        />
                    </svg>
                </div>
            );
        }
    }

    return (
        <div ref={wrap} className={styles.stageWrap}>
            <div
                className={styles.stage}
                style={{ width: stageWidth, height: Math.round(pageSize.height * scale) }}
                tabIndex={-1}
                onKeyDown={onKeyDown}
            >
                {url ? <img className={styles.stageImage} src={url} alt='' draggable={false} /> : null}
                <div
                    ref={overlay}
                    className={`${styles.overlay} ${tool === 'select' ? '' : styles.overlayTool}`}
                    onPointerDown={onPointerDown}
                    onPointerMove={onPointerMove}
                    onPointerUp={onPointerUp}
                    onPointerCancel={onPointerUp}
                >
                    {ghosts.map((el) => (
                        <div
                            key={`ghost-${el.id}`}
                            className={`${styles.el} ${styles.elGhost}`}
                            style={place(rectOf(el))}
                        >
                            <Content el={el} rect={rectOf(el)} scale={scale} />
                        </div>
                    ))}
                    {elements.map((el) => {
                        const rect = rectFor(el);
                        const selected = el.id === selectedId;
                        return (
                            <div
                                key={el.id}
                                data-el={el.id}
                                className={`${styles.el} ${selected ? styles.elSelected : ''} ${tool === 'select' ? styles.elGrab : ''}`}
                                style={place(rect)}
                            >
                                <Content el={el} rect={rect} scale={scale} />
                                {selected &&
                                    (['nw', 'ne', 'sw', 'se'] as const).map((corner) => (
                                        <span
                                            key={corner}
                                            data-corner={corner}
                                            className={`${styles.handle} ${styles[`handle-${corner}`]}`}
                                        />
                                    ))}
                            </div>
                        );
                    })}
                    {preview}
                </div>
            </div>
        </div>
    );
}

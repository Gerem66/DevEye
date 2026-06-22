import { useMemo, useRef, useState } from 'react';
import type { PresenceEvent } from 'deveye-types';
import { MonthPicker } from './MonthPicker';
import styles from './Monitoring.module.css';

interface TimelineProps {
    windowStart: number;
    windowEnd: number;
    onlineAtStart: boolean;
    events: PresenceEvent[];
    /** Timestamps of process snapshots in the window (clickable tick marks). */
    snapshotTimes: number[];
    /** Current zone selection, or null when not in range mode. */
    selection: { start: number; end: number } | null;
    /** Current single-point selection, or null when not in snapshot mode. */
    pointAt: number | null;
    onSelectRange: (sel: { start: number; end: number }) => void;
    onPickSnapshot: (at: number) => void;
    /** Back to the live rolling window (clears day + focus). */
    onLive: () => void;
    /** Selected day start (00:00), or null for the live rolling 24h. */
    dayStart: number | null;
    onDayChange: (day: number | null) => void;
    /** Local day keys (YYYY-MM-DD) that have data. */
    dataDays: string[];
    /** Visible window span (zoom) in ms, and the presets to pick from. */
    spanMs: number;
    zoomPresets: { label: string; ms: number }[];
    onSpanChange: (ms: number) => void;
}

interface Segment {
    from: number;
    to: number;
    online: boolean;
}

/** A click that moves less than this (px) is a point pick, not a drag-select. */
const CLICK_SLOP_PX = 5;

function startOfDay(ts: number): number {
    const d = new Date(ts);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
}

function parseDayKey(key: string): number {
    const [y, m, d] = key.split('-').map(Number);
    return new Date(y, m - 1, d).getTime();
}

function nearest(values: number[], target: number): number | null {
    let best: number | null = null;
    let bestDist = Infinity;
    for (const v of values) {
        const d = Math.abs(v - target);
        if (d < bestDist) {
            bestDist = d;
            best = v;
        }
    }
    return best;
}

function buildSegments(
    windowStart: number,
    windowEnd: number,
    onlineAtStart: boolean,
    events: PresenceEvent[]
): Segment[] {
    const inWindow = events.filter((e) => e.ts > windowStart && e.ts < windowEnd).sort((a, b) => a.ts - b.ts);
    const segs: Segment[] = [];
    let cursor = windowStart;
    let online = onlineAtStart;
    for (const e of inWindow) {
        if (e.online === online) continue;
        segs.push({ from: cursor, to: e.ts, online });
        cursor = e.ts;
        online = e.online;
    }
    segs.push({ from: cursor, to: windowEnd, online });
    return segs;
}

export function Timeline({
    windowStart,
    windowEnd,
    onlineAtStart,
    events,
    snapshotTimes,
    selection,
    pointAt,
    onSelectRange,
    onPickSnapshot,
    onLive,
    dayStart,
    onDayChange,
    dataDays,
    spanMs,
    zoomPresets,
    onSpanChange
}: TimelineProps) {
    const trackRef = useRef<HTMLDivElement>(null);
    const [drag, setDrag] = useState<{ a: number; b: number; downX: number } | null>(null);
    const [calOpen, setCalOpen] = useState(false);

    const span = Math.max(1, windowEnd - windowStart);
    const segments = buildSegments(windowStart, windowEnd, onlineAtStart, events);
    const onlineMs = segments.reduce((acc, s) => acc + (s.online ? s.to - s.from : 0), 0);
    const uptimePct = Math.round((onlineMs / span) * 100);

    const dataSet = useMemo(() => new Set(dataDays), [dataDays]);
    const dataMs = useMemo(() => dataDays.map(parseDayKey).sort((a, b) => a - b), [dataDays]);

    const todayStart = startOfDay(Date.now());
    const refDay = dayStart ?? todayStart;
    const prevDay = useMemo(() => {
        let best: number | null = null;
        for (const ms of dataMs) if (ms < refDay) best = ms;
        return best;
    }, [dataMs, refDay]);
    const nextDay = useMemo(() => dataMs.find((ms) => ms > refDay) ?? null, [dataMs, refDay]);

    const atLatest = dayStart === null;
    const dayLabel = atLatest
        ? 'Dernières 24 h'
        : new Date(refDay).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });

    const pctOf = (t: number) => ((t - windowStart) / span) * 100;
    const timeAt = (clientX: number): number => {
        const el = trackRef.current;
        if (!el) return windowStart;
        const rect = el.getBoundingClientRect();
        const frac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
        // Round to an integer ms: the focus drives `metrics.query`/`processesAt`,
        // whose schemas require integer `from`/`to`/`at`. A fractional value would
        // fail client-side validation and the graphs would never reflect the zone.
        return Math.round(windowStart + frac * span);
    };

    const onPointerDown = (e: React.PointerEvent) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        const t = timeAt(e.clientX);
        setDrag({ a: t, b: t, downX: e.clientX });
    };
    const onPointerMove = (e: React.PointerEvent) => {
        if (!drag) return;
        setDrag({ ...drag, b: timeAt(e.clientX) });
    };
    const onPointerUp = (e: React.PointerEvent) => {
        if (!drag) return;
        const movedPx = Math.abs(e.clientX - drag.downX);
        const start = Math.min(drag.a, drag.b);
        const end = Math.max(drag.a, drag.b);
        setDrag(null);
        if (movedPx < CLICK_SLOP_PX) {
            // A click: snap to the nearest snapshot mark when there is one.
            const t = timeAt(e.clientX);
            onPickSnapshot(nearest(snapshotTimes, t) ?? t);
        } else if (end - start > 60_000) {
            onSelectRange({ start, end });
        }
    };

    const dragSel = drag ? { start: Math.min(drag.a, drag.b), end: Math.max(drag.a, drag.b) } : null;
    const sel = dragSel ?? selection;

    const fmtTime = (t: number) => new Date(t).toLocaleString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    const showLive = dayStart !== null || selection !== null || pointAt !== null;

    return (
        <div className={styles.timeline}>
            <div className={styles.timelineNav}>
                <button
                    className={styles.navBtn}
                    onClick={() => prevDay !== null && onDayChange(prevDay)}
                    disabled={prevDay === null}
                    title='Jour avec données précédent'
                >
                    <span className='icon icon-arrow-left' />
                </button>

                <div className={styles.dayPickerWrap}>
                    <button className={styles.dayButton} onClick={() => setCalOpen((v) => !v)}>
                        <span className='icon icon-clock' /> {dayLabel}
                    </button>
                    {calOpen && (
                        <MonthPicker
                            dataDays={dataSet}
                            selectedDay={dayStart}
                            onPick={onDayChange}
                            onClose={() => setCalOpen(false)}
                        />
                    )}
                </div>

                <button
                    className={styles.navBtn}
                    onClick={() => nextDay !== null && onDayChange(nextDay === todayStart ? null : nextDay)}
                    disabled={nextDay === null}
                    title='Jour avec données suivant'
                >
                    <span className='icon icon-arrow-left' style={{ transform: 'rotate(180deg)' }} />
                </button>

                {showLive && (
                    <button className={styles.directBtn} onClick={onLive}>
                        Direct
                    </button>
                )}
                <span className={styles.uptimeBadge} title='Temps en ligne sur la fenêtre'>
                    {uptimePct}% en ligne
                </span>
            </div>

            <div className={styles.zoomRow}>
                <span className={styles.zoomLabel}>Zoom</span>
                {zoomPresets.map((z) => (
                    <button
                        key={z.ms}
                        className={`${styles.zoomChip} ${spanMs === z.ms ? styles.zoomChipActive : ''}`}
                        onClick={() => onSpanChange(z.ms)}
                    >
                        {z.label}
                    </button>
                ))}
            </div>

            <div
                ref={trackRef}
                className={styles.timelineTrack}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
            >
                {segments.map((s, i) => (
                    <div
                        key={i}
                        className={`${styles.segment} ${s.online ? styles.segOnline : styles.segOffline}`}
                        style={{ left: `${pctOf(s.from)}%`, width: `${pctOf(s.to) - pctOf(s.from)}%` }}
                    />
                ))}
                {snapshotTimes.map((t) => (
                    <div key={`m${t}`} className={styles.snapshotMark} style={{ left: `${pctOf(t)}%` }} />
                ))}
                {sel && (
                    <div
                        className={styles.selectionBox}
                        style={{
                            left: `${pctOf(sel.start)}%`,
                            width: `${Math.max(0.5, pctOf(sel.end) - pctOf(sel.start))}%`
                        }}
                    />
                )}
                {pointAt !== null && !dragSel && (
                    <div className={styles.pointMark} style={{ left: `${pctOf(pointAt)}%` }} />
                )}
            </div>

            <div className={styles.timelineFooter}>
                <span>{fmtTime(windowStart)}</span>
                {selection ? (
                    <button className={styles.resetSel} onClick={onLive}>
                        Sélection : {fmtTime(selection.start)} – {fmtTime(selection.end)} ✕
                    </button>
                ) : pointAt !== null ? (
                    <button className={styles.resetSel} onClick={onLive}>
                        Instant : {fmtTime(pointAt)} ✕
                    </button>
                ) : (
                    <span className={styles.dragHint}>Cliquez un instant · glissez pour une période</span>
                )}
                <span>{fmtTime(windowEnd)}</span>
            </div>
        </div>
    );
}

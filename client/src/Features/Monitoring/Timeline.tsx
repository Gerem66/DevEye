import { useEffect, useMemo, useRef, useState } from 'react';
import type { PresenceEvent } from '@deveye/types';
import { MonthPicker } from './MonthPicker';
import { nearestBy } from './utils';

/** L'instant stocké le plus proche d'une position sur la frise. */
const nearestValue = (values: number[], target: number) => nearestBy(values, target, (v) => v);
import styles from './Monitoring.module.css';

interface TimelineProps {
    windowStart: number;
    windowEnd: number;
    onlineAtStart: boolean;
    events: PresenceEvent[];
    /** Timestamps of the stored instants in the window (clickable tick marks). */
    snapshotTimes: number[];
    /** Subset of `snapshotTimes` that are pinned (kept past retention). */
    pinnedTimes: number[];
    /**
     * Subset of `snapshotTimes` whose process list was recorded. Empty when the
     * device captures no processes — the marks and the stepping stay usable, only
     * the process detail is absent.
     */
    processTimes: number[];
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

/**
 * Hard cap on the number of snapshots a selection may span — enforced *here*,
 * at the only place a selection is created (the drag), so every downstream
 * consumer (queries, averages, delete/pin counts) can assume a bounded range
 * and nothing else has to handle oversized selections. The moving edge simply
 * stops growing at the cap-th snapshot from the anchor.
 *
 * Sized for the unified cadence: every collection tick is a snapshot now (~1440
 * a day at 60 s), so the old 200 would have capped a drag at roughly three hours.
 */
const MAX_SELECTION_SNAPSHOTS = 2000;

/**
 * Above this many marks in the visible window, individual ticks stop being
 * legible (they merge into a solid bar) and cost a DOM node each. Past it the
 * timeline draws continuous "data available" bands instead — the click target is
 * unchanged, since a click snaps to the nearest mark either way.
 */
const MAX_INDIVIDUAL_MARKS = 200;

/** Merge marks into contiguous runs, breaking wherever a gap exceeds `maxGap`. */
function toBands(sorted: number[], maxGap: number): { from: number; to: number }[] {
    const bands: { from: number; to: number }[] = [];
    for (const ts of sorted) {
        const last = bands[bands.length - 1];
        if (last && ts - last.to <= maxGap) last.to = ts;
        else bands.push({ from: ts, to: ts });
    }
    return bands;
}

/** Index of the first element of ascending `sorted` that is ≥ `x`. */
function lowerBound(sorted: number[], x: number): number {
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (sorted[mid] < x) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

/** Number of elements of ascending `sorted` inside `[from, to]` (inclusive). */
function countInRange(sorted: number[], from: number, to: number): number {
    return lowerBound(sorted, to + 1) - lowerBound(sorted, from);
}

/**
 * Clamp the moving edge `candidate` so the selection `[anchor, candidate]` holds
 * at most `max` of `sortedSnaps` — the edge sticks at the max-th snapshot from
 * `anchor`. O(log n): runs on every pointer move.
 */
function clampToMaxSnapshots(anchor: number, candidate: number, sortedSnaps: number[], max: number): number {
    if (sortedSnaps.length === 0 || max <= 0) return candidate;
    if (candidate >= anchor) {
        const first = lowerBound(sortedSnaps, anchor);
        const count = lowerBound(sortedSnaps, candidate + 1) - first;
        return count > max ? sortedSnaps[first + max - 1] : candidate;
    }
    const last = lowerBound(sortedSnaps, anchor + 1) - 1;
    const count = last - lowerBound(sortedSnaps, candidate) + 1;
    return count > max ? sortedSnaps[last - max + 1] : candidate;
}

function startOfDay(ts: number): number {
    const d = new Date(ts);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
}

function parseDayKey(key: string): number {
    const [y, m, d] = key.split('-').map(Number);
    return new Date(y, m - 1, d).getTime();
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
    pinnedTimes,
    processTimes,
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
    // Racine de la frise : sert à savoir si ce panneau est bien celui qu'on voit
    // (voir la garde du raccourci clavier plus bas).
    const rootRef = useRef<HTMLDivElement>(null);
    const [drag, setDrag] = useState<{ a: number; b: number; downX: number } | null>(null);
    const [calOpen, setCalOpen] = useState(false);

    // The server sends the marks ascending; re-sorting once per fetch keeps the
    // binary-search helpers (clamp, stepping, counts) safe against any caller.
    const sortedSnaps = useMemo(() => [...snapshotTimes].sort((a, b) => a - b), [snapshotTimes]);

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
        // Round to an integer ms: the focus drives `devices.metrics`/`processesAt`,
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
        const b = clampToMaxSnapshots(drag.a, timeAt(e.clientX), sortedSnaps, MAX_SELECTION_SNAPSHOTS);
        setDrag({ ...drag, b });
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
            onPickSnapshot(nearestValue(snapshotTimes, t) ?? t);
        } else if (end - start > 60_000) {
            onSelectRange({ start, end });
        }
    };

    const dragSel = drag ? { start: Math.min(drag.a, drag.b), end: Math.max(drag.a, drag.b) } : null;
    const sel = dragSel ?? selection;
    // Snapshots inside the shown selection (bounded by MAX_SELECTION_SNAPSHOTS).
    const selCount = sel ? countInRange(sortedSnaps, sel.start, sel.end) : 0;

    const pinnedSet = useMemo(() => new Set(pinnedTimes), [pinnedTimes]);
    const procSet = useMemo(() => new Set(processTimes), [processTimes]);
    // Dense windows collapse to bands; a run breaks when a gap exceeds twice the
    // median spacing, so a real agent outage still reads as a hole.
    const dense = sortedSnaps.length > MAX_INDIVIDUAL_MARKS;
    const bands = useMemo(() => {
        if (!dense) return [];
        const gaps: number[] = [];
        for (let i = 1; i < sortedSnaps.length; i++) gaps.push(sortedSnaps[i] - sortedSnaps[i - 1]);
        gaps.sort((a, b) => a - b);
        const median = gaps[Math.floor(gaps.length / 2)] || 60_000;
        return toBands(sortedSnaps, median * 2);
    }, [dense, sortedSnaps]);
    // Adjacent snapshots around the focused instant, to step through with the
    // ‹ › buttons or the keyboard arrows (binary search on the sorted marks).
    //
    // En direct, la vue montre déjà le dernier relevé : on la traite donc comme
    // un point posé sur la marque la plus récente, et ← recule d'un cran à
    // partir de là. Sans quoi les flèches ne faisaient rien tant qu'on n'avait
    // pas d'abord cliqué un instant, alors que l'écran en affichait un.
    const stepFrom = pointAt ?? sortedSnaps[sortedSnaps.length - 1] ?? null;
    const prevSnap = stepFrom === null ? null : (sortedSnaps[lowerBound(sortedSnaps, stepFrom) - 1] ?? null);
    const nextSnap = pointAt === null ? null : (sortedSnaps[lowerBound(sortedSnaps, pointAt + 1)] ?? null);
    /** Sur la marque la plus récente, → ramène au direct : le pas suivant, c'est lui. */
    const nextIsLive = pointAt !== null && nextSnap === null && dayStart === null;

    // Keyboard stepping (← previous / → next) while an instant is focused. A
    // window listener (not a focus-bound onKeyDown) because the timeline is never
    // focused in normal use; scoped to the arrow keys and skipped when the user is
    // typing in a field, so it can't hijack inputs or other shortcuts.
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
            if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
            // Un panneau **garé** garde son DOM monté (`FeatureKeepAlive` le
            // range dans un conteneur `display: none`) : sans ce contrôle, la
            // popup d'appareil de l'accueil et la vue Monitoring pilotaient
            // toutes deux leur frise sur la même flèche. `offsetParent` est nul
            // exactement dans ce cas.
            if (rootRef.current?.offsetParent === null) return;
            const el = e.target as HTMLElement | null;
            if (
                el &&
                (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)
            ) {
                return;
            }
            if (e.key === 'ArrowRight' && nextIsLive) {
                e.preventDefault();
                onLive();
                return;
            }
            const step = e.key === 'ArrowLeft' ? prevSnap : nextSnap;
            if (step !== null) {
                e.preventDefault();
                onPickSnapshot(step);
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [prevSnap, nextSnap, nextIsLive, onPickSnapshot, onLive]);

    const fmtTime = (t: number) => new Date(t).toLocaleString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    const showLive = dayStart !== null || selection !== null || pointAt !== null;

    return (
        <div className={styles.timeline} ref={rootRef}>
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
                {dense
                    ? bands.map((b) => (
                          <div
                              key={`b${b.from}`}
                              className={styles.snapshotBand}
                              style={{
                                  left: `${pctOf(b.from)}%`,
                                  width: `${Math.max(0.4, pctOf(b.to) - pctOf(b.from))}%`
                              }}
                          />
                      ))
                    : snapshotTimes.map((t) => (
                          <div
                              key={`m${t}`}
                              className={`${styles.snapshotMark} ${pinnedSet.has(t) ? styles.snapshotMarkPinned : ''} ${
                                  procSet.has(t) ? styles.snapshotMarkProc : ''
                              }`}
                              style={{ left: `${pctOf(t)}%` }}
                              title={procSet.has(t) ? undefined : 'Instant sans liste de processus'}
                          />
                      ))}
                {/* Pinned instants stay individually visible whatever the density:
                    they are rare and deliberately kept, so they must be findable. */}
                {dense &&
                    pinnedTimes.map((t) => (
                        <div
                            key={`p${t}`}
                            className={`${styles.snapshotMark} ${styles.snapshotMarkPinned}`}
                            style={{ left: `${pctOf(t)}%` }}
                        />
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
                        Sélection : {fmtTime(selection.start)} – {fmtTime(selection.end)}
                        {selCount > 0 && ` · ${selCount} snapshot${selCount > 1 ? 's' : ''}`} ✕
                    </button>
                ) : pointAt !== null ? (
                    <span className={styles.instantNav}>
                        <button
                            className={styles.instantArrow}
                            onClick={() => prevSnap !== null && onPickSnapshot(prevSnap)}
                            disabled={prevSnap === null}
                            title='Snapshot précédent (flèche gauche)'
                        >
                            <span className='icon icon-arrow-left' />
                        </button>
                        <button className={styles.resetSel} onClick={onLive}>
                            Instant : {fmtTime(pointAt)} ✕
                        </button>
                        <button
                            className={styles.instantArrow}
                            onClick={() => (nextSnap !== null ? onPickSnapshot(nextSnap) : nextIsLive && onLive())}
                            disabled={nextSnap === null && !nextIsLive}
                            title={
                                nextSnap === null && nextIsLive
                                    ? 'Retour au direct (flèche droite)'
                                    : 'Snapshot suivant (flèche droite)'
                            }
                        >
                            <span className='icon icon-arrow-left' style={{ transform: 'rotate(180deg)' }} />
                        </button>
                    </span>
                ) : sortedSnaps.length === 0 ? (
                    <span className={styles.dragHint}>Aucun instant enregistré sur cette fenêtre</span>
                ) : (
                    // En direct, ‹ recule à partir du dernier relevé — celui que
                    // la vue montre déjà. Le bouton dit ce que la flèche fait.
                    <span className={styles.instantNav}>
                        <button
                            className={styles.instantArrow}
                            onClick={() => prevSnap !== null && onPickSnapshot(prevSnap)}
                            disabled={prevSnap === null}
                            title='Snapshot précédent (flèche gauche)'
                        >
                            <span className='icon icon-arrow-left' />
                        </button>
                        <span className={styles.dragHint}>Cliquez un instant · glissez pour une période</span>
                    </span>
                )}
                <span>{fmtTime(windowEnd)}</span>
            </div>
        </div>
    );
}

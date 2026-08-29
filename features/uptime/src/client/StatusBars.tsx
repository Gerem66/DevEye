import { useMemo, useState, type ReactNode } from 'react';

import { formatBucket, formatMs, formatRatio } from './format';
import styles from './style.module.css';

import type { UptimePoint, UptimeResolution } from '../contracts/domain';

/**
 * Slots the window is always cut into. Fixed on purpose: a bar stands for a
 * slice of *time*, so the strip must look the same whether the service has ten
 * samples or a hundred thousand ; only the colours change.
 */
const SLOTS = 90;

/**
 * Below this, a "slow" verdict is noise: on a 20 ms service every 45 ms blip
 * would otherwise light up yellow.
 */
const SLOW_FLOOR_MS = 150;

/** One slot of the timeline; `checks === 0` means nothing was recorded then. */
interface Slot {
    at: number;
    checks: number;
    upChecks: number;
    avgMs: number | null;
}

/** Lay the points over a fixed grid of time slots spanning `[from, to]`. */
function toSlots(points: UptimePoint[], from: number, to: number): Slot[] {
    const width = Math.max(1, (to - from) / SLOTS);
    const slots: Slot[] = Array.from({ length: SLOTS }, (_, i) => ({
        at: Math.round(from + i * width),
        checks: 0,
        upChecks: 0,
        avgMs: null
    }));
    // Running latency sums, kept aside so `avgMs` stays null on an empty slot
    // instead of becoming a misleading 0.
    const msTotal = new Array<number>(SLOTS).fill(0);
    const msCount = new Array<number>(SLOTS).fill(0);

    for (const point of points) {
        const i = Math.min(SLOTS - 1, Math.max(0, Math.floor((point.at - from) / width)));
        slots[i].checks += point.checks;
        slots[i].upChecks += point.upChecks;
        if (point.avgMs !== null) {
            msTotal[i] += point.avgMs;
            msCount[i] += 1;
        }
    }
    for (let i = 0; i < SLOTS; i++) {
        if (msCount[i] > 0) slots[i].avgMs = Math.round(msTotal[i] / msCount[i]);
    }
    return slots;
}

/** Median latency across the filled slots : the baseline "slow" is judged against. */
function medianMs(slots: Slot[]): number | null {
    const values = slots.map((s) => s.avgMs).filter((ms): ms is number => ms !== null);
    if (values.length === 0) return null;
    values.sort((a, b) => a - b);
    return values[Math.floor(values.length / 2)];
}

/** Ce qu'une tranche raconte, en une ligne : le texte de la bulle. */
function slotLabel(slot: Slot, daily: boolean): string {
    if (slot.checks === 0) return `${formatBucket(slot.at, daily)} · aucune mesure`;
    return `${formatBucket(slot.at, daily)} · ${formatRatio(slot.upChecks / slot.checks)} · ${formatMs(slot.avgMs)}`;
}

/**
 * Sous ce ratio d'un bord, la bulle s'aligne sur ce bord au lieu d'être centrée
 * sur la barre : une bulle centrée sur la deuxième tranche sortirait du cadre par
 * la gauche, et se ferait rogner par le `overflow` de la carte qui la porte.
 */
const TIP_EDGE = 0.15;

interface StatusBarsProps {
    points: UptimePoint[];
    /** Window shared with the latency chart, so both read on the same x-axis. */
    from: number;
    to: number;
    resolution: UptimeResolution;
    /**
     * Placé au bout de la ligne de légende, poussé à l'opposé. Sans effet en
     * `inline`, qui n'a pas de légende.
     */
    trailing?: ReactNode;
    /**
     * `full` : sous un titre, avec sa légende. `inline` : dans une rangée, plus
     * basse et sans légende (la bulle dit déjà tout).
     */
    variant?: 'full' | 'inline';
}

/**
 * The classic status strip: one thin bar per slice of the selected window,
 * green when every probe passed, yellow when they passed but slowly, red as soon
 * as one failed, grey when nothing was recorded. Outage periods, and gaps in the
 * monitoring itself, read at a glance.
 *
 * "Slow" is relative to the service's own median rather than an absolute
 * millisecond count: a 20 ms endpoint and a 400 ms one are both normal, and only
 * a departure from their own baseline is worth flagging.
 *
 * La bulle plutôt que `title` : l'infobulle du navigateur se fait attendre, ne
 * suit pas le thème et ne dit jamais quelle barre elle décrit.
 */
export function StatusBars({ points, from, to, resolution, trailing, variant = 'full' }: StatusBarsProps) {
    const slots = useMemo(() => toSlots(points, from, to), [points, from, to]);
    const slowAbove = useMemo(() => {
        const median = medianMs(slots);
        return median === null ? null : Math.max(median * 2, SLOW_FLOOR_MS);
    }, [slots]);
    const [hovered, setHovered] = useState<number | null>(null);

    const daily = resolution === 'day';
    const inline = variant === 'inline';
    // Le survol pointe une tranche disparue quand la fenêtre se recompose sous le
    // pointeur (une sonde arrive, les points bougent). Borner ici évite de lire
    // hors du tableau plutôt que de courir après l'événement de sortie.
    const tip = hovered === null ? null : (slots[hovered] ?? null);
    const tipAt = hovered === null ? 0 : (hovered + 0.5) / SLOTS;

    return (
        <div className={`${styles.bars} ${inline ? styles.barsInline : ''}`}>
            <div className={styles.barsPlot}>
                {tip && (
                    <span
                        className={styles.barsTip}
                        style={
                            tipAt < TIP_EDGE
                                ? { left: 0 }
                                : tipAt > 1 - TIP_EDGE
                                  ? { right: 0 }
                                  : { left: `${tipAt * 100}%`, transform: 'translateX(-50%)' }
                        }
                    >
                        {slotLabel(tip, daily)}
                    </span>
                )}
                <div className={styles.barsRow} onPointerLeave={() => setHovered(null)}>
                    {slots.map((slot, i) => {
                        const failed = slot.checks > 0 && slot.upChecks < slot.checks;
                        const slow = !failed && slowAbove !== null && (slot.avgMs ?? 0) > slowAbove;
                        const tone =
                            slot.checks === 0
                                ? styles.barEmpty
                                : failed
                                  ? styles.barDown
                                  : slow
                                    ? styles.barSlow
                                    : styles.barUp;
                        return (
                            <span
                                key={slot.at}
                                className={`${styles.bar} ${tone} ${i === hovered ? styles.barHovered : ''}`}
                                onPointerEnter={() => setHovered(i)}
                            />
                        );
                    })}
                </div>
            </div>
            {!inline && (
                <div className={styles.barsLegend}>
                    <span className={styles.legendItem}>
                        <span className={`${styles.legendSwatch} ${styles.barUp}`} /> opérationnel
                    </span>
                    <span className={styles.legendItem}>
                        <span className={`${styles.legendSwatch} ${styles.barSlow}`} /> lent
                    </span>
                    <span className={styles.legendItem}>
                        <span className={`${styles.legendSwatch} ${styles.barDown}`} /> panne
                    </span>
                    <span className={styles.legendItem}>
                        <span className={`${styles.legendSwatch} ${styles.barEmpty}`} /> aucune mesure
                    </span>
                    {trailing && <span className={styles.barsTrailing}>{trailing}</span>}
                </div>
            )}
        </div>
    );
}

export default StatusBars;

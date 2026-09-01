import { useEffect, useMemo, useRef, useState } from 'react';
import { SegmentedControl } from 'deveye-sdk-client';

import type { DaySummary } from '../contracts/commands';
import styles from './style.module.css';

interface MonthPickerProps {
    /** Ce que chaque jour local (YYYY-MM-DD) contient, indexé par sa clé. */
    days: Map<string, DaySummary>;
    /** Currently shown day start (ms); null = today/live. */
    selectedDay: number | null;
    onPick: (dayStart: number | null) => void;
    onClose: () => void;
}

const WEEKDAYS = ['L', 'M', 'M', 'J', 'V', 'S', 'D'];
const MONTHS = [
    'Janvier',
    'Février',
    'Mars',
    'Avril',
    'Mai',
    'Juin',
    'Juillet',
    'Août',
    'Septembre',
    'Octobre',
    'Novembre',
    'Décembre'
];

type View = 'month' | 'list';

const VIEW_OPTIONS = [
    { value: 'month' as const, label: 'Mois' },
    { value: 'list' as const, label: 'Liste' }
];

function dayKey(ms: number): string {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function monthKey(year: number, month: number): string {
    return `${year}-${String(month + 1).padStart(2, '0')}`;
}
function startOfDay(ms: number): number {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
}
/** Une clé YYYY-MM-DD locale en début de jour local. */
function parseDayKey(key: string): number {
    const [y, m, d] = key.split('-').map(Number);
    return new Date(y, m - 1, d).getTime();
}

export function MonthPicker({ days, selectedDay, onPick, onClose }: MonthPickerProps) {
    const ref = useRef<HTMLDivElement>(null);
    const today = new Date();
    const todayStart = startOfDay(today.getTime());
    const initial = new Date(selectedDay ?? todayStart);
    const [view, setView] = useState({ year: initial.getFullYear(), month: initial.getMonth() });
    const [mode, setMode] = useState<View>('month');

    useEffect(() => {
        const handler = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) onClose();
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [onClose]);

    // Months that contain at least one data day.
    const monthsWithData = new Set<string>();
    for (const k of days.keys()) monthsWithData.add(k.slice(0, 7));

    const prevM = view.month === 0 ? { year: view.year - 1, month: 11 } : { year: view.year, month: view.month - 1 };
    const nextM = view.month === 11 ? { year: view.year + 1, month: 0 } : { year: view.year, month: view.month + 1 };
    const prevDisabled = !monthsWithData.has(monthKey(prevM.year, prevM.month));
    // No navigating into the future.
    const nextDisabled =
        view.year > today.getFullYear() || (view.year === today.getFullYear() && view.month >= today.getMonth());

    // Build the grid (Monday-first), padding to whole weeks.
    const first = new Date(view.year, view.month, 1);
    const offset = (first.getDay() + 6) % 7; // 0 = Monday
    const daysInMonth = new Date(view.year, view.month + 1, 0).getDate();
    const cells: ({ day: number; ms: number } | null)[] = [];
    for (let i = 0; i < offset; i++) cells.push(null);
    for (let d = 1; d <= daysInMonth; d++) cells.push({ day: d, ms: new Date(view.year, view.month, d).getTime() });
    while (cells.length % 7 !== 0) cells.push(null);

    const selectedMs = selectedDay ?? todayStart;

    /**
     * La liste ne montre QUE les jours qui portent des données : passé la
     * rétention, deux instants épinglés à cent jours d'écart donnent deux
     * lignes, là où la grille demanderait de traverser les mois vides.
     */
    const listed = useMemo(() => [...days.values()].sort((a, b) => b.day.localeCompare(a.day)), [days]);

    const pick = (ms: number) => {
        onPick(ms === todayStart ? null : ms);
        onClose();
    };

    return (
        <div className={styles.calendar} ref={ref}>
            <SegmentedControl options={VIEW_OPTIONS} value={mode} onChange={setMode} className={styles.calModes} />

            {mode === 'month' ? (
                <>
                    <div className={styles.calHead}>
                        <button
                            className={styles.navBtn}
                            disabled={prevDisabled}
                            onClick={() => setView(prevM)}
                            title='Mois précédent'
                        >
                            <span className='icon icon-arrow-left' />
                        </button>
                        <span className={styles.calMonth}>
                            {MONTHS[view.month]} {view.year}
                        </span>
                        <button
                            className={styles.navBtn}
                            disabled={nextDisabled}
                            onClick={() => setView(nextM)}
                            title='Mois suivant'
                        >
                            <span className='icon icon-arrow-left' style={{ transform: 'rotate(180deg)' }} />
                        </button>
                    </div>
                    <div className={styles.calGrid}>
                        {WEEKDAYS.map((w, i) => (
                            <span key={`h${i}`} className={styles.calWeekday}>
                                {w}
                            </span>
                        ))}
                        {cells.map((c, i) => {
                            if (!c) return <span key={`e${i}`} />;
                            const isFuture = c.ms > todayStart;
                            const summary = isFuture ? undefined : days.get(dayKey(c.ms));
                            const isToday = c.ms === todayStart;
                            const isSelected = c.ms === selectedMs;
                            return (
                                <button
                                    key={c.ms}
                                    className={`${styles.calDay} ${isSelected ? styles.calSelected : ''} ${isToday ? styles.calToday : ''}`}
                                    disabled={!summary}
                                    onClick={() => pick(c.ms)}
                                    title={summary ? dayTitle(summary) : undefined}
                                >
                                    {c.day}
                                    {summary && (
                                        <span className={styles.calMarks}>
                                            <span className={styles.calMarkData} />
                                            {summary.pinned > 0 && <span className={styles.calMarkPinned} />}
                                        </span>
                                    )}
                                </button>
                            );
                        })}
                    </div>
                </>
            ) : listed.length === 0 ? (
                <p className={styles.calEmpty}>Aucune donnée enregistrée pour cet appareil.</p>
            ) : (
                <ul className={styles.calList}>
                    {listed.map((d) => {
                        const ms = parseDayKey(d.day);
                        return (
                            <li key={d.day}>
                                <button
                                    className={`${styles.calListRow} ${ms === selectedMs ? styles.calSelected : ''}`}
                                    onClick={() => pick(ms)}
                                >
                                    <span className={styles.calListDate}>
                                        {new Date(ms).toLocaleDateString('fr-FR', {
                                            weekday: 'short',
                                            day: 'numeric',
                                            month: 'short',
                                            year: 'numeric'
                                        })}
                                    </span>
                                    <span className={styles.calListCounts}>
                                        {d.instants}
                                        {d.pinned > 0 && (
                                            <span className={styles.calListPinned}>
                                                <span className='icon icon-star' /> {d.pinned}
                                            </span>
                                        )}
                                    </span>
                                </button>
                            </li>
                        );
                    })}
                </ul>
            )}
        </div>
    );
}

function dayTitle(d: DaySummary): string {
    const instants = `${d.instants} instant${d.instants > 1 ? 's' : ''}`;
    return d.pinned > 0 ? `${instants}, dont ${d.pinned} épinglé${d.pinned > 1 ? 's' : ''}` : instants;
}

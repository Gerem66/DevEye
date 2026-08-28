import { useEffect, useRef, useState } from 'react';
import styles from './style.module.css';

interface MonthPickerProps {
    /** Local day keys (YYYY-MM-DD) that have data. */
    dataDays: Set<string>;
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

export function MonthPicker({ dataDays, selectedDay, onPick, onClose }: MonthPickerProps) {
    const ref = useRef<HTMLDivElement>(null);
    const today = new Date();
    const todayStart = startOfDay(today.getTime());
    const initial = new Date(selectedDay ?? todayStart);
    const [view, setView] = useState({ year: initial.getFullYear(), month: initial.getMonth() });

    useEffect(() => {
        const handler = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) onClose();
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [onClose]);

    // Months that contain at least one data day.
    const monthsWithData = new Set<string>();
    for (const k of dataDays) monthsWithData.add(k.slice(0, 7));

    const prevM = view.month === 0 ? { year: view.year - 1, month: 11 } : { year: view.year, month: view.month - 1 };
    const nextM = view.month === 11 ? { year: view.year + 1, month: 0 } : { year: view.year, month: view.month + 1 };
    const prevDisabled = !monthsWithData.has(monthKey(prevM.year, prevM.month));
    // No navigating into the future; forward only while it stays ≤ current month.
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

    return (
        <div className={styles.calendar} ref={ref}>
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
                    const has = dataDays.has(dayKey(c.ms)) && !isFuture;
                    const isToday = c.ms === todayStart;
                    const isSelected = c.ms === selectedMs;
                    return (
                        <button
                            key={c.ms}
                            className={`${styles.calDay} ${isSelected ? styles.calSelected : ''} ${isToday ? styles.calToday : ''}`}
                            disabled={!has}
                            onClick={() => {
                                onPick(isToday ? null : c.ms);
                                onClose();
                            }}
                        >
                            {c.day}
                        </button>
                    );
                })}
            </div>
        </div>
    );
}

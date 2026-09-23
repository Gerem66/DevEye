/**
 * Les jours civils. Une pièce appartient à un jour, pas à un instant : un
 * horodatage la ferait changer de mois comptable selon le fuseau de qui la
 * regarde. Tout est ici en chaînes `AAAA-MM-JJ`, qui se comparent et se trient
 * comme des dates parce que le format ISO l'a voulu ainsi.
 *
 * Le calcul passe par `Date.UTC` de bout en bout : additionner des jours en
 * heure locale sauterait ou doublerait une heure au changement d'heure d'été.
 */

function partsOf(day: string): [number, number, number] {
    return [Number(day.slice(0, 4)), Number(day.slice(5, 7)), Number(day.slice(8, 10))];
}

function isoOf(at: Date): string {
    return at.toISOString().slice(0, 10);
}

export function addDays(day: string, days: number): string {
    const [year, month, date] = partsOf(day);
    return isoOf(new Date(Date.UTC(year, month - 1, date + days)));
}

/** Le dernier jour du mois de `day`. Le jour zéro du mois suivant, dit autrement. */
export function endOfMonth(day: string): string {
    const [year, month] = partsOf(day);
    return isoOf(new Date(Date.UTC(year, month, 0)));
}

export function startOfMonth(day: string): string {
    return `${day.slice(0, 7)}-01`;
}

/**
 * Le jour civil d'un instant, dans le fuseau de l'espace. Un fuseau inconnu
 * retombe sur celui du processus plutôt que de lever : une pièce datée d'un jour
 * voisin est un désagrément, un écran qui refuse de s'ouvrir est une panne.
 */
export function dayIn(timeZone: string, instant: Date): string {
    try {
        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit'
        }).formatToParts(instant);
        const at = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
        const day = `${at('year')}-${at('month')}-${at('day')}`;
        if (/^\d{4}-\d{2}-\d{2}$/.test(day)) return day;
    } catch {
        // Fuseau refusé par l'environnement : on retombe plus bas.
    }
    const pad = (value: number) => String(value).padStart(2, '0');
    return `${instant.getFullYear()}-${pad(instant.getMonth() + 1)}-${pad(instant.getDate())}`;
}

/** Le jour courant dans le fuseau de l'espace. */
export function todayIn(timeZone: string, now: Date = new Date()): string {
    return dayIn(timeZone, now);
}

/** L'échéance d'une facture : sa date d'émission plus le délai convenu. */
export function dueDateOf(issuedOn: string, termsDays: number): string {
    return addDays(issuedOn, termsDays);
}

export type PeriodRange = 'month' | 'quarter' | 'year';

/** Les bornes inclusives de la période qui contient `day`. */
export function periodBounds(day: string, range: PeriodRange): { from: string; to: string } {
    const [year, month] = partsOf(day);
    if (range === 'year') return { from: `${year}-01-01`, to: `${year}-12-31` };
    if (range === 'quarter') {
        const first = Math.floor((month - 1) / 3) * 3 + 1;
        const from = `${year}-${String(first).padStart(2, '0')}-01`;
        return { from, to: endOfMonth(`${year}-${String(first + 2).padStart(2, '0')}-01`) };
    }
    return { from: startOfMonth(day), to: endOfMonth(day) };
}

export function daysBetween(from: string, to: string): number {
    const [fy, fm, fd] = partsOf(from);
    const [ty, tm, td] = partsOf(to);
    return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000);
}

/**
 * Une facture n'est pas en retard le jour de son échéance : elle l'est le
 * lendemain. Le même prédicat s'écrit `due_on < :today` en SQL, dans le dépôt.
 */
export function isOverdue(dueOn: string | null, today: string): boolean {
    return dueOn !== null && dueOn < today;
}

/** Idem pour un devis : valable jusqu'au dernier jour inclus. */
export function isExpired(validUntil: string | null, today: string): boolean {
    return validUntil !== null && validUntil < today;
}

/**
 * Ce qu’un devis doit laisser à son client au moment où il est émis : au moins
 * un jour pour répondre. Plus strict qu’`isExpired`, qui laisse passer le dernier
 * jour de validité : un devis émis ce jour-là naîtrait expiré le lendemain.
 */
export function leavesAnswerTime(validUntil: string, today: string): boolean {
    return validUntil >= addDays(today, 1);
}

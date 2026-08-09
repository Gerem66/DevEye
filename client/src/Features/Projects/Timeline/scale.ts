/**
 * L'échelle de temps de la frise.
 *
 * Deux choses distinctes, qu'il ne faut pas confondre :
 *
 *  - **les lignes**, une par jour, toujours. Elles ne sont pas engendrées ici :
 *    c'est un dégradé qui se répète tous les `dayWidth` pixels (voir `.tlGrid`).
 *    Rien à calculer, rien à poser dans le DOM, et jamais de jour sauté ;
 *  - **les étiquettes**, qui ne peuvent pas être quotidiennes à toutes les
 *    échelles — deux dates à 12 px l'une de l'autre se chevauchent. Ce fichier
 *    ne s'occupe que de celles-là.
 *
 * `Features/Monitoring/utils.ts:niceTimeTicks` n'est **pas** réutilisable ici :
 * ses paliers s'arrêtent à 24 h, parce qu'il sert à une supervision qui se lit
 * en minutes. Un projet s'étale sur des semaines ou des trimestres. Deux
 * échelles pour deux problèmes, plutôt qu'une abstraction qui ne servirait bien
 * ni l'un ni l'autre.
 */

export const DAY_MS = 86_400_000;

/**
 * Niveaux de zoom, en pixels par jour.
 *
 * L'intitulé nomme la **granularité qui devient lisible**, pas ce qui tient à
 * l'écran : au zoom « Mois » on lit les jours d'un mois, au zoom « Année » on
 * suit des mois entiers. Le plancher de 6 px n'est pas arbitraire — en dessous,
 * la ligne quotidienne devient un aplat gris et la frise perd son unité.
 */
export const ZOOM_LEVELS = [
    { id: 'year', label: 'Année', dayWidth: 6 },
    { id: 'quarter', label: 'Trimestre', dayWidth: 12 },
    { id: 'month', label: 'Mois', dayWidth: 28 },
    { id: 'week', label: 'Semaine', dayWidth: 72 }
] as const;

export type ZoomId = (typeof ZOOM_LEVELS)[number]['id'];

/** Le pas des étiquettes. Trois valeurs, et des bornes naturelles. */
export type TickUnit = 'day' | 'week' | 'month';

export interface Tick {
    t: number;
    label: string;
    /** Premier du mois : trait plus marqué. */
    major: boolean;
}

/** Largeur minimale d'une étiquette de date, à cette taille de police. */
const MIN_LABEL_SPACING = 64;

/** Minuit local du jour contenant `t`. */
export function startOfDay(t: number): number {
    const d = new Date(t);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
}

/**
 * Le pas d'étiquetage : **la plus fine des périodes qui tienne**.
 *
 * Un jour, une semaine, un mois — et rien entre les deux. L'ancienne règle
 * cherchait le premier pas d'une liste de neuf valeurs (1, 2, 7, 14, 30, 60…),
 * ce qui donnait des graduations « tous les deux jours » ou « toutes les deux
 * semaines » : des repères que personne ne compte de tête, et qui changeaient au
 * moindre pixel de largeur gagné.
 */
export function tickUnit(dayWidth: number): TickUnit {
    if (dayWidth >= MIN_LABEL_SPACING) return 'day';
    if (dayWidth * 7 >= MIN_LABEL_SPACING) return 'week';
    return 'month';
}

/** Recule au premier jour de la période contenant `t`. */
function startOfUnit(t: number, unit: TickUnit): Date {
    const d = new Date(startOfDay(t));
    if (unit === 'month') d.setDate(1);
    // Semaine française : lundi. `getDay()` compte à partir de dimanche.
    if (unit === 'week') d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return d;
}

/**
 * Les étiquettes de la fenêtre.
 *
 * L'année n'est écrite qu'une fois : en janvier, ou à défaut sur la première
 * graduation — une fenêtre qui commence en cours d'année n'en contient aucun,
 * et le repère disparaîtrait complètement.
 */
export function timelineTicks(min: number, max: number, dayWidth: number): Tick[] {
    const ticks: Tick[] = [];
    if (max <= min) return ticks;

    const unit = tickUnit(dayWidth);
    const d = startOfUnit(min, unit);

    while (d.getTime() <= max) {
        const t = d.getTime();
        if (t >= min) {
            const first = ticks.length === 0;
            const january = d.getMonth() === 0 && d.getDate() === 1;
            ticks.push({
                t,
                major: d.getDate() === 1,
                label: d.toLocaleDateString('fr-FR', {
                    ...(unit === 'month' ? {} : { day: 'numeric' }),
                    month: 'short',
                    ...(first || january ? { year: 'numeric' } : {})
                })
            });
        }
        if (unit === 'month') d.setMonth(d.getMonth() + 1);
        else d.setDate(d.getDate() + (unit === 'week' ? 7 : 1));
    }
    return ticks;
}

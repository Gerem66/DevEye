/**
 * L'échelle de temps de la frise, c'est-à-dire ses étiquettes seulement : les
 * lignes, une par jour, sont un dégradé qui se répète tous les `dayWidth` pixels
 * (`.tlGrid`), rien n'est posé dans le DOM pour elles. Les étiquettes, elles, ne
 * peuvent pas être quotidiennes à toutes les échelles, deux dates à 12 px l'une de
 * l'autre se chevauchent. Le `niceTimeTicks` de la supervision ne convient pas :
 * ses paliers s'arrêtent à 24 h, quand un projet s'étale sur des trimestres.
 */

import type { ProjectTimelineZoom } from '../../contracts/domain';

export const DAY_MS = 86_400_000;

/** Un niveau, et ce qu'il promet : voir {@link ZOOM_LEVELS}. */
export interface ZoomLevel {
    id: ProjectTimelineZoom;
    label: string;
    target: number;
    minDays: number;
    maxDays: number;
}

/**
 * Les niveaux de zoom : une **durée visible**, pas une densité de pixels. Le
 * choix dit combien de temps on veut avoir sous les yeux ; c'est la place
 * disponible qui en déduit la largeur d'un jour, et non l'inverse. Un zoom qui
 * ne réglerait que la densité laisserait la fenêtre suivre les dates des tâches,
 * et « Semaine » montrerait deux mois dès qu'une tâche traîne en septembre.
 *
 * `target` est la largeur de jour visée, celle où l'échelle se lit : la fenêtre
 * s'étire ou se resserre autour d'elle, entre `minDays` et `maxDays`, selon ce
 * que l'écran offre. Les bornes sont ce que l'intitulé promet : « Semaine »
 * montre d'une à trois semaines, jamais un trimestre.
 *
 * L'ordre est celui de la barre : du plus large au plus fin.
 */
export const ZOOM_LEVELS: readonly ZoomLevel[] = [
    { id: 'year', label: 'Année', target: 3, minDays: 365, maxDays: 1095 },
    { id: 'quarter', label: 'Trimestre', target: 9, minDays: 90, maxDays: 273 },
    { id: 'month', label: 'Mois', target: 26, minDays: 30, maxDays: 92 },
    { id: 'week', label: 'Semaine', target: 80, minDays: 7, maxDays: 21 }
];

/** Le même jeu que `projectTimelineZoomSchema` : le projet enregistre son échelle d'ouverture. */
export type ZoomId = ProjectTimelineZoom;

/**
 * Où tombe aujourd'hui dans la fenêtre : au tiers. Un projet se lit vers
 * l'avant, mais ce qu'on vient de faire explique ce qui vient.
 */
export const TODAY_AT = 1 / 3;

/** Sous ce plancher, la frise défile plutôt que d'écraser ses journées. */
const MIN_DAY_WIDTH = 2;

/** En deçà, la ligne quotidienne devient un aplat gris et la frise perd son unité. */
export const DAY_LINE_MIN_WIDTH = 6;

export interface TimelineWindow {
    /** Minuit du premier jour visible. */
    start: number;
    /** Durée visible, en jours entiers. */
    days: number;
    dayWidth: number;
}

/**
 * La fenêtre qu'un zoom ouvre sur une largeur donnée. `avail` à zéro (avant la
 * première mesure) rend la fenêtre nominale, que le premier rendu remplacera.
 */
export function zoomWindow(zoom: ZoomId, avail: number, now: number): TimelineWindow {
    const level = ZOOM_LEVELS.find((z) => z.id === zoom) ?? ZOOM_LEVELS[2];
    const wanted = avail > 0 ? Math.round(avail / level.target) : level.minDays;
    const days = Math.min(Math.max(wanted, level.minDays), level.maxDays);
    const dayWidth = Math.max(avail > 0 ? avail / days : level.target, MIN_DAY_WIDTH);
    return { start: startOfDay(now) - Math.floor(days * TODAY_AT) * DAY_MS, days, dayWidth };
}

/** Le pas des étiquettes. Des périodes du calendrier, et rien entre elles. */
export type TickUnit = 'day' | 'week' | 'month' | 'quarter' | 'year';

export interface Tick {
    t: number;
    label: string;
    /** Commence une période plus grosse que le pas : trait plus marqué. */
    major: boolean;
}

/** Un barreau de l'échelle : une période, éventuellement prise plusieurs fois. */
interface Step {
    unit: TickUnit;
    /** Nombre d'unités entre deux graduations. Toujours 1 sauf pour l'année. */
    every: number;
    /** Durée la plus courte du pas, en jours ; sert à l'élagage seulement. */
    minDays: number;
}

/**
 * L'échelle des pas, du plus fin au plus grossier. Les multiples d'années suivent
 * la progression 1, 2, 5 reprise à chaque décennie : les seuls intervalles qu'on
 * compte de tête sur un axe.
 */
const STEPS: Step[] = [
    { unit: 'day', every: 1, minDays: 1 },
    { unit: 'week', every: 1, minDays: 7 },
    { unit: 'month', every: 1, minDays: 28 },
    { unit: 'quarter', every: 1, minDays: 90 },
    ...[1, 2, 5, 10, 20, 50, 100].map((every) => ({ unit: 'year' as const, every, minDays: 365 * every }))
];

/**
 * Largeur d'un caractère d'étiquette, en px : celle de la chasse fixe, donc
 * majorante. Une estimation suffit, on décide d'un pas et non d'un placement au
 * pixel ; mesurer le texte coûterait une mise en page à chaque redimensionnement.
 */
const CHAR_W = 6.1;

/** Blanc minimal entre deux étiquettes voisines, en px. */
const LABEL_GAP = 12;

/** Largeur approchée d'une étiquette, en px. */
export function labelWidth(label: string): number {
    return label.length * CHAR_W;
}

/** Minuit local du jour contenant `t`. */
export function startOfDay(t: number): number {
    const d = new Date(t);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
}

/** Lundi d'abord, comme `startOfStep` compte ses semaines. */
export const WEEKDAY_LETTERS = ['L', 'M', 'M', 'J', 'V', 'S', 'D'] as const;

/** En deçà, une lettre par jour se colle à ses voisines. */
export const DAY_LETTER_MIN_WIDTH = 18;

/** Le rang du jour dans la semaine, 0 = lundi. */
export function weekdayIndex(t: number): number {
    return (new Date(t).getDay() + 6) % 7;
}

/** Recule au premier jour de la période contenant `t`. */
function startOfStep(t: number, step: Step): Date {
    const d = new Date(startOfDay(t));
    switch (step.unit) {
        // Semaine française : lundi. `getDay()` compte à partir de dimanche.
        case 'week':
            d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
            break;
        case 'month':
            d.setDate(1);
            break;
        case 'quarter':
            d.setMonth(d.getMonth() - (d.getMonth() % 3), 1);
            break;
        case 'year':
            d.setMonth(0, 1);
            // Les décennies tombent sur 2020, 2030… et non sur l'année du premier
            // commit : sinon les repères changent dès qu'on en gagne un plus ancien.
            d.setFullYear(d.getFullYear() - (d.getFullYear() % step.every));
            break;
    }
    return d;
}

/** Avance `d` d'un pas, sur place. */
function advance(d: Date, step: Step): void {
    switch (step.unit) {
        case 'day':
            d.setDate(d.getDate() + 1);
            break;
        case 'week':
            d.setDate(d.getDate() + 7);
            break;
        case 'month':
            d.setMonth(d.getMonth() + 1);
            break;
        case 'quarter':
            d.setMonth(d.getMonth() + 3);
            break;
        case 'year':
            d.setFullYear(d.getFullYear() + step.every);
            break;
    }
}

/** La graduation ouvre-t-elle une année ? La première du pas à y tomber. */
function opensYear(d: Date, unit: TickUnit): boolean {
    if (unit === 'day') return d.getMonth() === 0 && d.getDate() === 1;
    // Aucun lundi ne tombe un 1er janvier chaque année : c'est le premier de
    // janvier, quel que soit son quantième, qui ouvre l'année pour ce pas.
    if (unit === 'week') return d.getMonth() === 0 && d.getDate() <= 7;
    return d.getMonth() === 0;
}

/**
 * Ce qu'écrit une graduation : la plus grosse période qu'elle ouvre, et elle seule.
 * `withYear` couvre la fenêtre qui s'ouvre en cours d'année sans jamais en franchir
 * une, et qui sans lui n'écrirait l'année nulle part.
 */
function tickLabel(d: Date, step: Step, withYear: boolean): string {
    const opens = opensYear(d, step.unit);
    const coarse = step.unit === 'month' || step.unit === 'quarter';
    if (step.unit === 'year' || (opens && coarse)) return String(d.getFullYear());
    return d.toLocaleDateString('fr-FR', {
        ...(step.unit === 'day' || step.unit === 'week' ? { day: 'numeric' } : {}),
        month: 'short',
        ...(withYear || opens ? { year: 'numeric' } : {})
    });
}

/** Le trait marqué : la graduation ouvre une période plus grosse que le pas. */
function isMajor(d: Date, step: Step): boolean {
    if (step.unit === 'day' || step.unit === 'week') return d.getDate() === 1;
    if (step.unit === 'year') return d.getFullYear() % (step.every * 5) === 0;
    return d.getMonth() === 0;
}

/** Les graduations d'un pas donné, bornes comprises. */
function buildTicks(min: number, max: number, step: Step): Tick[] {
    const dates: Date[] = [];
    const d = startOfStep(min, step);
    while (d.getTime() <= max) {
        // Seule la première itération peut précéder la fenêtre : le pas part de
        // la période *contenant* `min`, pas de `min` lui-même.
        if (d.getTime() >= min) dates.push(new Date(d));
        advance(d, step);
    }

    // La première graduation ne porte l'année que si aucune autre ne l'ouvre :
    // « oct. 2021 » tient deux fois plus de place que « oct. » et déciderait à lui
    // seul du pas.
    const orphan = !dates.some((x) => opensYear(x, step.unit));
    return dates.map((x, i) => ({
        t: x.getTime(),
        major: isMajor(x, step),
        label: tickLabel(x, step, orphan && i === 0)
    }));
}

/**
 * Les étiquettes tiennent-elles côte à côte ? Paire par paire et non contre un
 * écart moyen : les pas du calendrier sont inégaux, et c'est le plus court qui
 * décide de la lisibilité. Chaque voisine n'avance dans l'intervalle que de sa
 * demi-largeur, les étiquettes étant centrées sur leur trait.
 */
function fits(ticks: Tick[], dayWidth: number): boolean {
    for (let i = 1; i < ticks.length; i++) {
        const gap = ((ticks[i].t - ticks[i - 1].t) / DAY_MS) * dayWidth;
        if (gap < (labelWidth(ticks[i - 1].label) + labelWidth(ticks[i].label)) / 2 + LABEL_GAP) return false;
    }
    return true;
}

/** Nul pas ne tient en moins que la plus courte des étiquettes, « mai ». */
const MIN_STEP_PX = 3 * CHAR_W + LABEL_GAP;

/**
 * Les étiquettes de la fenêtre : le pas le plus fin dont elles tiennent, essayé du
 * jour au siècle. Le choix se fait sur les étiquettes une fois écrites et non sur
 * une largeur supposée, « 2024 » et « 12 janv. 2024 » n'occupant pas la même place.
 */
export function timelineTicks(min: number, max: number, dayWidth: number): Tick[] {
    if (max <= min) return [];

    let last: Tick[] = [];
    for (const step of STEPS) {
        // Élagage : inutile d'engendrer mille graduations quotidiennes pour
        // constater qu'elles se chevauchent toutes.
        if (dayWidth * step.minDays < MIN_STEP_PX) continue;
        last = buildTicks(min, max, step);
        if (fits(last, dayWidth)) return last;
    }
    // Fenêtre plus étroite qu'une étiquette, ou plus longue qu'un siècle : le
    // dernier pas essayé reste le moins mauvais, vide si aucun n'a été engendré.
    return last;
}

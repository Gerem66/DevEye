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
 * Le module sert aussi le graphe des commits (`Features/Git/CommitGraph`), qui
 * n'a pas de zoom : il tasse tout l'historique d'un dépôt dans la largeur d'une
 * carte, et descend donc bien plus bas en pixels par jour qu'une frise. D'où une
 * échelle qui va du jour au siècle, et un choix de pas fondé sur la largeur
 * réelle des étiquettes plutôt que sur une constante.
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
    /** Durée la plus courte du pas, en jours — sert à l'élagage seulement. */
    minDays: number;
}

/**
 * L'échelle des pas, du plus fin au plus grossier.
 *
 * Les multiples d'années suivent la progression 1–2–5, reprise à chaque
 * décennie : ce sont les seuls intervalles qu'on compte de tête sur un axe. On
 * s'arrête au siècle — ni un projet ni un dépôt git n'ira jusque-là.
 */
const STEPS: Step[] = [
    { unit: 'day', every: 1, minDays: 1 },
    { unit: 'week', every: 1, minDays: 7 },
    { unit: 'month', every: 1, minDays: 28 },
    { unit: 'quarter', every: 1, minDays: 90 },
    ...[1, 2, 5, 10, 20, 50, 100].map((every) => ({ unit: 'year' as const, every, minDays: 365 * every }))
];

/**
 * Largeur d'un caractère d'étiquette, en px.
 *
 * Les deux appelants écrivent en corps ~10 : à chasse fixe pour le graphe
 * (`.graphLabel`), proportionnelle pour la frise (`.gridLabel`), un peu plus
 * étroite en moyenne. La valeur retenue est celle de la chasse fixe, donc
 * majorante dans les deux cas — et une estimation suffit : on décide d'un pas,
 * pas d'un placement au pixel. Mesurer le texte dans le document coûterait un
 * calcul de mise en page à chaque redimensionnement.
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
            // Les décennies tombent sur 2020, 2030… et non sur l'année du
            // premier commit : sinon le même dépôt change de repères en
            // gagnant un commit plus ancien.
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

/** La graduation ouvre-t-elle une année ? — la première du pas à y tomber. */
function opensYear(d: Date, unit: TickUnit): boolean {
    if (unit === 'day') return d.getMonth() === 0 && d.getDate() === 1;
    // Aucun lundi ne tombe un 1er janvier chaque année : c'est le premier de
    // janvier, quel que soit son quantième, qui ouvre l'année pour ce pas.
    if (unit === 'week') return d.getMonth() === 0 && d.getDate() <= 7;
    return d.getMonth() === 0;
}

/**
 * Ce qu'écrit une graduation.
 *
 * **La plus grosse période qu'elle ouvre, et elle seule.** Une graduation de
 * janvier n'écrit que l'année : « janv. » n'apprendrait rien qu'on ne lise déjà
 * dans sa position, et l'année tiendrait deux fois plus de place au moment
 * précis où l'axe en manque. Les autres portent leur mois — leur jour aussi
 * quand le pas descend sous la semaine.
 *
 * `withYear` couvre le cas de la fenêtre qui s'ouvre en cours d'année sans
 * jamais en franchir une : sans lui, une frise entièrement contenue dans 2024
 * n'écrirait l'année nulle part.
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

    // La première graduation ne porte l'année que si aucune autre ne l'ouvre.
    // C'est elle qui décidait du pas : « oct. 2021 » tient deux fois plus de
    // place que « oct. », et refusait à lui seul le trimestre sur cinq ans de
    // commits — pour redire une année écrite en clair trois crans plus loin.
    const orphan = !dates.some((x) => opensYear(x, step.unit));
    return dates.map((x, i) => ({
        t: x.getTime(),
        major: isMajor(x, step),
        label: tickLabel(x, step, orphan && i === 0)
    }));
}

/**
 * Les étiquettes tiennent-elles côte à côte ?
 *
 * Comparaison paire par paire, et non contre un écart moyen : les pas du
 * calendrier sont inégaux — février contre juillet, une année bissextile — et
 * c'est toujours l'intervalle le plus court qui décide de la lisibilité.
 *
 * Chaque voisine n'avance dans l'intervalle que de sa demi-largeur : c'est la
 * géométrie du graphe, dont les étiquettes sont centrées sur leur trait. La
 * frise les pose à droite du trait, donc en occupe le double ; `LABEL_GAP` et
 * une chasse majorante lui rendent la marge, et ses quatre niveaux de zoom
 * donnent de toute façon des étiquettes largement séparées.
 */
function fits(ticks: Tick[], dayWidth: number): boolean {
    for (let i = 1; i < ticks.length; i++) {
        const gap = ((ticks[i].t - ticks[i - 1].t) / DAY_MS) * dayWidth;
        if (gap < (labelWidth(ticks[i - 1].label) + labelWidth(ticks[i].label)) / 2 + LABEL_GAP) return false;
    }
    return true;
}

/** Nul pas ne tient en moins que la plus courte des étiquettes — « mai ». */
const MIN_STEP_PX = 3 * CHAR_W + LABEL_GAP;

/**
 * Les étiquettes de la fenêtre : **le pas le plus fin dont elles tiennent**.
 *
 * L'échelle est essayée du jour au siècle et la première qui passe est rendue.
 * L'ancienne règle s'arrêtait au mois : sur une frise de projet, dont le zoom
 * garantit au moins 6 px par jour, cela suffisait ; sur cinq ans de commits
 * ramenés à la largeur d'une carte, cela donnait soixante dates en bouillie.
 *
 * Le choix se fait sur les étiquettes elles-mêmes, une fois écrites, et non sur
 * une largeur supposée : « 2024 » et « 12 janv. 2024 » n'occupent pas la même
 * place, et c'est justement le format qui décide si un pas passe ou non.
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
    // Fenêtre plus étroite qu'une seule étiquette, ou plus longue qu'un siècle :
    // le dernier pas essayé reste le moins mauvais. Vide si aucun n'a été
    // engendré — mieux vaut pas d'axe qu'un axe illisible.
    return last;
}

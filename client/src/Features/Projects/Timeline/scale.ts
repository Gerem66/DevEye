/**
 * L'échelle de temps de la frise.
 *
 * `Features/Monitoring/utils.ts:niceTimeTicks` n'est **pas** réutilisable ici :
 * ses paliers s'arrêtent à 24 h, parce qu'il sert à une supervision qui se lit
 * en minutes. Un projet s'étale sur des semaines ou des trimestres, et il lui
 * faut des paliers jour / semaine / mois. Deux échelles pour deux problèmes,
 * plutôt qu'une abstraction qui ne servirait bien ni l'un ni l'autre.
 */

export const DAY_MS = 86_400_000;

/** Niveaux de zoom, en pixels par jour. */
export const ZOOM_LEVELS = [
    { id: 'year', label: 'Année', dayWidth: 3 },
    { id: 'quarter', label: 'Trimestre', dayWidth: 10 },
    { id: 'month', label: 'Mois', dayWidth: 26 },
    { id: 'week', label: 'Semaine', dayWidth: 90 }
] as const;

export type ZoomId = (typeof ZOOM_LEVELS)[number]['id'];

export interface Tick {
    t: number;
    label: string;
    /** Début de mois : trait plus marqué, étiquette plus longue. */
    major: boolean;
}

/** Minuit local du jour contenant `t`. */
export function startOfDay(t: number): number {
    const d = new Date(t);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
}

/**
 * Graduations adaptées à la largeur disponible : on ne pose une étiquette que
 * si elle a la place d'être lue, sinon on monte d'un palier.
 */
export function timelineTicks(min: number, max: number, dayWidth: number): Tick[] {
    const ticks: Tick[] = [];
    if (max <= min) return ticks;

    // Palier minimal pour que deux étiquettes ne se chevauchent pas (~64 px).
    const minSpacingDays = Math.ceil(64 / dayWidth);
    const step = [1, 2, 7, 14, 30, 60, 90, 180, 365].find((s) => s >= minSpacingDays) ?? 365;

    // Les paliers courts se posent sur les jours, les longs sur les mois : un
    // « tous les 30 jours » qui dérive du 3 au 2 puis au 1er serait illisible.
    if (step >= 30) {
        const monthStep = Math.max(1, Math.round(step / 30));
        const d = new Date(min);
        d.setDate(1);
        d.setHours(0, 0, 0, 0);
        while (d.getTime() <= max) {
            const t = d.getTime();
            if (t >= min) {
                // L'année est portée par janvier — mais une fenêtre qui commence
                // en cours d'année n'en contient aucun, et l'année disparaîtrait
                // alors complètement. La **première** graduation la porte donc
                // aussi : le repère est ainsi toujours ancré quelque part.
                const first = ticks.length === 0;
                const year = d.getMonth() === 0;
                ticks.push({
                    t,
                    major: year || first,
                    label: year
                        ? String(d.getFullYear())
                        : d.toLocaleDateString(
                              'fr-FR',
                              first ? { month: 'short', year: 'numeric' } : { month: 'short' }
                          )
                });
            }
            d.setMonth(d.getMonth() + monthStep);
        }
        return ticks;
    }

    for (let t = startOfDay(min); t <= max; t += step * DAY_MS) {
        if (t < min) continue;
        const d = new Date(t);
        // Même raison : sans ça, un zoom serré n'affiche jamais l'année.
        const first = ticks.length === 0;
        ticks.push({
            t,
            major: d.getDate() === 1 || first,
            label: d.toLocaleDateString(
                'fr-FR',
                first ? { day: 'numeric', month: 'short', year: 'numeric' } : { day: 'numeric', month: 'short' }
            )
        });
    }
    return ticks;
}

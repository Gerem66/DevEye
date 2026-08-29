import type { BackupScheduleKind } from '../contracts/domain';

/**
 * La prochaine échéance d'un travail à partir de `from` ; `null` pour un
 * travail manuel ou désactivé (ce qui le sort de l'index des travaux dus).
 * Heures locales au serveur : « 3 h » veut dire 3 h là où la machine est
 * administrée, heure d'été comprise.
 */
export function nextRunAt(
    schedule: BackupScheduleKind,
    enabled: boolean,
    hour: number,
    weekday: number,
    day: number,
    from: Date = new Date()
): number | null {
    if (!enabled || schedule === 'manual') return null;

    const next = new Date(from.getTime());
    next.setSeconds(0, 0);

    if (schedule === 'hourly') {
        next.setMinutes(0);
        next.setTime(next.getTime() + 60 * 60 * 1000);
        return Math.floor(next.getTime() / 1000);
    }

    next.setMinutes(0);
    next.setHours(hour);
    // Toujours strictement dans le futur : sans ce test, enregistrer un
    // travail à 3 h 00 min 30 s le ferait partir immédiatement, puis
    // repartir le lendemain, un déclenchement fantôme à chaque édition.
    const advanceDay = (): void => {
        next.setDate(next.getDate() + 1);
    };
    if (next.getTime() <= from.getTime()) advanceDay();

    if (schedule === 'daily') return Math.floor(next.getTime() / 1000);

    if (schedule === 'weekly') {
        while (next.getDay() !== weekday) advanceDay();
        return Math.floor(next.getTime() / 1000);
    }

    // Mensuel. `day` est borné à 28 par le contrat, donc ce quantième
    // existe tous les mois et la boucle se termine en au plus 31 pas.
    while (next.getDate() !== day) advanceDay();
    return Math.floor(next.getTime() / 1000);
}

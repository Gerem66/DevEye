import type { ExposureAsset, ExposureFinding, ExposureSource } from '../contracts/exposure';

import { dayMs, untilLine } from './softwareLabels';

export const SOURCE_LABEL: Record<ExposureSource, string> = {
    git: 'Dépôt Git',
    device: 'Appareil',
    database: 'Base de données',
    deploy: 'Déploiement'
};

/** L'icône de l'app qui dit d'où vient un élément. */
export const SOURCE_ICON: Record<ExposureSource, string> = {
    git: 'icon-branch',
    device: 'icon-server',
    database: 'icon-database',
    deploy: 'icon-rocket'
};

/** La feature qui tient un élément, pour y emmener. */
export const SOURCE_FEATURE: Record<ExposureSource, string> = {
    git: 'git',
    device: 'devices',
    database: 'database',
    deploy: 'deploy'
};

/** Ce qu'un élément touché a de touché : `4.17.20 · client/package-lock.json:12`. */
export function whereLine(a: ExposureFinding['affected'][number]): string {
    const where = a.path === null ? null : a.line === null ? a.path : `${a.path}:${a.line}`;
    return where === null ? a.version : `${a.version} · ${where}`;
}

/** Les versions touchées d'un constat, sans doublon : `4.17.15, 4.17.20`. */
export function versionsOf(f: ExposureFinding): string {
    return [...new Set(f.affected.map((a) => a.version))].join(', ');
}

/** Depuis quand, en français parlé : « à l’instant », « il y a 2 h », « hier ». */
export function since(epochSeconds: number): string {
    const s = Math.max(0, Math.floor(Date.now() / 1000) - epochSeconds);
    if (s < 60) return 'à l’instant';
    if (s < 3600) return `il y a ${Math.floor(s / 60)} min`;
    if (s < 86_400) return `il y a ${Math.floor(s / 3600)} h`;
    const days = Math.floor(s / 86_400);
    return days === 1 ? 'hier' : `il y a ${days} j`;
}

/** L'état de lecture d'un élément, en une ligne. */
export function assetStatusLine(a: ExposureAsset): string {
    if (a.excluded) return 'Sorti de la veille';
    if (a.status === 'pending') return 'En attente du premier passage';
    if (a.status === 'error') return a.error ?? 'La dernière lecture a échoué';
    if (a.scannedAt === null) return 'Lu';
    const checked = a.checkedAt !== null && a.checkedAt > a.scannedAt ? `, vérifié ${since(a.checkedAt)}` : '';
    return `Lu ${since(a.scannedAt)}${checked}`;
}

/** Une fin de vie est atteinte : la veille l'a dit, ou sa date est passée depuis. */
export function eolReached(f: ExposureFinding): boolean {
    if (!f.eol) return f.severity === 'high';
    return f.eol.reached || (f.eol.date !== null && dayMs(f.eol.date) <= Date.now());
}

/** Ce qu'un constat de fin de vie nomme : « Node.js 18 ». */
export function eolName(f: ExposureFinding): string {
    return f.eol ? `${f.subject.name} ${f.eol.release}` : f.title;
}

/** La pastille d'une fin de vie : « Fin de vie depuis 7 mois », « Fin de vie dans 12 jours ». */
export function eolBadge(f: ExposureFinding): { tone: 'danger' | 'warning'; label: string } {
    const reached = eolReached(f);
    const date = f.eol?.date ?? null;
    return {
        tone: reached ? 'danger' : 'warning',
        label: date !== null ? `Fin de vie ${untilLine(date)}` : reached ? 'Fin de vie' : 'Fin de vie proche'
    };
}

/** « 1 version majeure de retard », « 3 versions majeures de retard ». */
export function behindLine(behind: number): string {
    return `${behind} version${behind > 1 ? 's' : ''} majeure${behind > 1 ? 's' : ''} de retard`;
}

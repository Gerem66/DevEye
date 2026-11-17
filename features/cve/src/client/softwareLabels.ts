import { EOL_SOON_DAYS } from '../contracts/exposure';
import type { Software, SoftwareRelease } from '../contracts/software';

const DAY_MS = 86_400_000;

/** Un jour `AAAA-MM-JJ` en millisecondes, minuit UTC. */
export function dayMs(iso: string): number {
    return Date.parse(`${iso}T00:00:00Z`);
}

/** « 30 avr. 2025 », pour une cellule de tableau. */
export function shortDate(iso: string | null): string {
    if (iso === null) return '';
    return new Date(dayMs(iso)).toLocaleDateString('fr-FR', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        timeZone: 'UTC'
    });
}

/** « 30 avril 2025 », pour une phrase. */
export function longDate(iso: string): string {
    return new Date(dayMs(iso)).toLocaleDateString('fr-FR', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC'
    });
}

/** L'écart d'avec une date, en français parlé : « depuis 7 mois », « dans 12 jours ». */
export function untilLine(iso: string): string {
    const days = Math.round((dayMs(iso) - Date.now()) / DAY_MS);
    if (days === 0) return 'aujourd’hui';
    if (days === 1) return 'demain';
    const n = Math.abs(days);
    const span =
        n < 31
            ? `${n} jour${n > 1 ? 's' : ''}`
            : n < 365
              ? `${Math.floor(n / 30)} mois`
              : `${Math.floor(n / 365)} an${Math.floor(n / 365) > 1 ? 's' : ''}`;
    return days < 0 ? `depuis ${span}` : `dans ${span}`;
}

export type ReleaseState = 'maintained' | 'soon' | 'eol';

/** Où en est une branche aujourd'hui, avec le même seuil que la veille. */
export function releaseState(r: Pick<SoftwareRelease, 'isEol' | 'eolFrom'>): ReleaseState {
    const at = r.eolFrom === null ? NaN : dayMs(r.eolFrom);
    const now = Date.now();
    if (r.isEol || (Number.isFinite(at) && at <= now)) return 'eol';
    if (Number.isFinite(at) && at - now <= EOL_SOON_DAYS * DAY_MS) return 'soon';
    return 'maintained';
}

export const RELEASE_STATE_LABEL: Record<ReleaseState, string> = {
    maintained: 'Maintenue',
    soon: 'Fin proche',
    eol: 'Fin de vie'
};

/**
 * Le nom d'une branche tel qu'endoflife.date l'affiche (« 11 26H2 (E) »), sans
 * le « (LTS) » que la pastille dit déjà ni le nom de code, qui ferait passer
 * chaque ligne sur deux.
 */
export function releaseLabel(r: Pick<SoftwareRelease, 'name' | 'label'>): string {
    return (r.label ?? r.name)
        .replace(/\s*\(LTS\)\s*$/, '')
        .replace(/\s*'[^']*'/, '')
        .trim();
}

/** Le nom de code d'une branche (« Noble Numbat »), quand son libellé en porte un. */
export function releaseCodename(r: Pick<SoftwareRelease, 'label'>): string | undefined {
    return r.label?.match(/'([^']+)'/)?.[1];
}

const CATEGORY_LABEL: Record<string, string> = {
    app: 'Application',
    database: 'Base de données',
    device: 'Appareil',
    framework: 'Framework',
    lang: 'Langage',
    os: 'Système',
    'server-app': 'Serveur',
    service: 'Service',
    standard: 'Norme'
};

export function categoryLabel(category: string | null): string | null {
    return category === null ? null : (CATEGORY_LABEL[category] ?? null);
}

/** Les branches encore suivies, la plus récente d'abord. */
export function maintainedReleases(software: Software): SoftwareRelease[] {
    return software.releases.filter((r) => releaseState(r) !== 'eol');
}

/** Ce qu'il faut savoir d'une branche, en une phrase : « Node.js 18 : fin de vie depuis le 30 avril 2025. » */
export function verdictLine(software: Software, release: SoftwareRelease): string {
    const name = `${software.label} ${releaseLabel(release)}`;
    const state = releaseState(release);
    const when = release.eolFrom === null ? null : longDate(release.eolFrom);
    const until = release.eolFrom === null ? null : untilLine(release.eolFrom);
    const head =
        state === 'eol'
            ? when
                ? `${name} : fin de vie depuis le ${when}.`
                : `${name} : fin de vie.`
            : state === 'soon'
              ? `${name} : fin de vie le ${when}, ${until}.`
              : when
                ? `${name} : maintenue jusqu’au ${when}.`
                : `${name} : maintenue, sans date de fin annoncée.`;
    if (state === 'maintained') return head;
    const others = maintainedReleases(software)
        .filter((r) => r.name !== release.name)
        .slice(0, 3)
        .map(releaseLabel);
    return others.length > 0 ? `${head} Branches maintenues : ${others.join(', ')}.` : head;
}

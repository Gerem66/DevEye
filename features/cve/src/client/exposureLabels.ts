import type { ExposureAsset, ExposureFinding, ExposureSource, FindingKind } from '../contracts/exposure';

/** Les genres de constats que la veille établit, dans l'ordre où l'écran les propose. */
export const FINDING_KINDS: readonly { value: FindingKind; label: string; empty: string }[] = [
    { value: 'vuln', label: 'Failles', empty: 'Aucune faille connue dans ce que l’espace fait tourner.' },
    {
        value: 'deprecated',
        label: 'Dépréciées',
        empty: 'Aucun paquet déprécié ou abandonné par son auteur.'
    }
];

export const SOURCE_LABEL: Record<ExposureSource, string> = {
    git: 'Dépôt Git'
};

/** L'icône de l'app qui dit d'où vient un élément. */
export const SOURCE_ICON: Record<ExposureSource, string> = {
    git: 'icon-branch'
};

/** La feature qui tient un élément, pour y emmener. */
export const SOURCE_FEATURE: Record<ExposureSource, string> = {
    git: 'git'
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

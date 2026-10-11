const BROWSERS: readonly [RegExp, string][] = [
    [/\bEdg(e|A|iOS)?\//, 'Edge'],
    [/\b(OPR|Opera)\//, 'Opera'],
    [/\bSamsungBrowser\//, 'Samsung Internet'],
    [/\b(Firefox|FxiOS)\//, 'Firefox'],
    [/\b(Chrome|CriOS|Chromium)\//, 'Chrome'],
    [/\bSafari\//, 'Safari']
];

const SYSTEMS: readonly [RegExp, string][] = [
    [/\bWindows\b/, 'Windows'],
    [/\bAndroid\b/, 'Android'],
    [/\b(iPhone|iPad|iPod)\b/, 'iOS'],
    [/\b(Macintosh|Mac OS X)\b/, 'macOS'],
    [/\bCrOS\b/, 'ChromeOS'],
    [/\bLinux\b/, 'Linux']
];

/**
 * « Firefox sur Linux » : ce qu'un User-Agent dit d'un navigateur, assez pour
 * qu'une personne reconnaisse le sien dans une liste, jamais une empreinte.
 */
export function browserLabel(userAgent: string | undefined): string {
    const ua = userAgent ?? '';
    const browser = BROWSERS.find(([pattern]) => pattern.test(ua))?.[1];
    const system = SYSTEMS.find(([pattern]) => pattern.test(ua))?.[1];
    if (browser && system) return `${browser} sur ${system}`;
    return browser ?? (system ? `Navigateur sur ${system}` : 'Navigateur inconnu');
}

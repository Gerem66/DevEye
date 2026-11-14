import crypto from 'node:crypto';

/**
 * Les registres de paquets, par deps.dev : la dernière version publiée d'un
 * paquet, et celles que son auteur déprécie. Une requête par paquet, gardée
 * un jour dans un cache commun à tout le serveur ; seules les dépendances
 * directes d'un projet sont demandées.
 */

const API = 'https://api.deps.dev/v3/systems';
const TIMEOUT_MS = 15_000;
/** La pause après un refus sans `Retry-After`, ou une panne réseau. */
const COOLDOWN_MS = 10 * 60_000;

/** Les écosystèmes d'OSV que deps.dev connaît, sous son nom. */
export const REGISTRY_SYSTEM: Readonly<Record<string, string>> = {
    npm: 'NPM',
    PyPI: 'PYPI',
    'crates.io': 'CARGO',
    Go: 'GO',
    Maven: 'MAVEN',
    NuGet: 'NUGET',
    RubyGems: 'RUBYGEMS'
};

export interface PackageMeta {
    /** La version que le registre sert par défaut. */
    latest: string | null;
    /** Les versions dépréciées, et ce que l'auteur en dit. */
    deprecated: Record<string, string>;
}

export const registryHealth = {
    blockedUntil: 0,
    lastOkAt: 0,
    lastFailure: null as { at: number; reason: string } | null
};

export class RegistryUnavailable extends Error {}

/** La clé d'un paquet dans le cache : son empreinte. */
export function metaKey(system: string, name: string): string {
    return crypto.createHash('sha256').update(`${system}|${name}`).digest('hex');
}

interface RawVersion {
    versionKey?: { version?: string };
    isDefault?: boolean;
    isDeprecated?: boolean;
    deprecatedReason?: string;
}

/** Ce que la veille garde d'un paquet tel que deps.dev le décrit. */
export function readPackage(json: unknown): PackageMeta {
    const versions = ((json as { versions?: RawVersion[] } | null)?.versions ?? []).filter(
        (v) => v.versionKey?.version
    );
    const deprecated: Record<string, string> = {};
    for (const v of versions) {
        if (v.isDeprecated) deprecated[v.versionKey!.version!] = (v.deprecatedReason ?? '').slice(0, 200);
    }
    return { latest: versions.find((v) => v.isDefault)?.versionKey?.version ?? null, deprecated };
}

/** Un paquet chez deps.dev ; `null` quand il ne le connaît pas. Une panne lève `RegistryUnavailable`. */
export async function fetchPackage(
    system: string,
    name: string,
    fetchImpl: typeof fetch = fetch
): Promise<PackageMeta | null> {
    if (Date.now() < registryHealth.blockedUntil) {
        throw new RegistryUnavailable(registryHealth.lastFailure?.reason ?? 'deps.dev est en pause.');
    }
    const block = (reason: string, retryAfter: string | null): never => {
        const seconds = retryAfter !== null ? Number(retryAfter) : NaN;
        registryHealth.blockedUntil =
            Date.now() + (Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : COOLDOWN_MS);
        registryHealth.lastFailure = { at: Date.now(), reason };
        throw new RegistryUnavailable(reason);
    };
    let res: Response;
    try {
        res = await fetchImpl(`${API}/${system}/packages/${encodeURIComponent(name)}`, {
            headers: { accept: 'application/json', 'user-agent': 'DevEye' },
            signal: AbortSignal.timeout(TIMEOUT_MS)
        });
    } catch {
        return block('deps.dev ne répond pas.', null);
    }
    if (res.status === 404) return null;
    if (res.status === 429) return block('deps.dev limite le nombre de requêtes.', res.headers.get('retry-after'));
    if (res.status >= 500) return block(`deps.dev est en panne (${res.status}).`, res.headers.get('retry-after'));
    if (!res.ok) return null;
    registryHealth.lastOkAt = Date.now();
    return readPackage(await res.json());
}

/** La « majeure » d'une version : la mineure en `0.x`, où chaque mineure peut tout casser. */
function majorOf(version: string): [number, number] | null {
    const m = /^v?(\d+)(?:\.(\d+))?/.exec(version);
    if (!m) return null;
    const major = Number(m[1]);
    return major > 0 ? [major, 0] : [0, Number(m[2] ?? 0)];
}

/** Combien de versions majeures séparent `version` de `latest`, zéro quand elle est à jour ou plus loin. */
export function majorsBehind(version: string, latest: string): number {
    const a = majorOf(version);
    const b = majorOf(latest);
    if (!a || !b) return 0;
    if (a[0] === 0 && b[0] === 0) return Math.max(0, b[1] - a[1]);
    if (a[0] === 0) return b[0];
    return Math.max(0, b[0] - a[0]);
}

/** La branche majeure d'une version, telle qu'un constat « en retard » la nomme. */
export function majorKey(version: string): string {
    const m = majorOf(version);
    return m === null ? version : m[0] > 0 ? String(m[0]) : `0.${m[1]}`;
}

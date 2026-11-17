import type { ExposureComponent } from '../../contracts/exposure';
import { TOOLS } from '../inventory/tools';

/**
 * Les fins de vie, d'après endoflife.date : chaque produit, ses branches, et
 * la date où chacune cesse de recevoir ses correctifs. Le catalogue entier se
 * lit en une requête par jour (`/products/full`, quelques mégaoctets) et se
 * garde en base : une évaluation ne sort jamais.
 */

const API = 'https://endoflife.date/api/v1/products/full';
const TIMEOUT_MS = 60_000;

export interface EolRelease {
    name: string;
    /** Le libellé d'endoflife.date (« 26.04 'Resolute Raccoon' (LTS) »), quand il diffère du nom. */
    label: string | null;
    /** `AAAA-MM-JJ`, comme toutes les dates d'une branche. */
    releaseDate: string | null;
    isLts: boolean;
    /** Fin du support actif : ensuite, les seuls correctifs de sécurité. */
    eoasFrom: string | null;
    isEol: boolean;
    eolFrom: string | null;
    /** Fin du support étendu, souvent payant. */
    eoesFrom: string | null;
    isMaintained: boolean;
    latest: string | null;
    latestDate: string | null;
}

export interface EolProduct {
    name: string;
    label: string;
    aliases: string[];
    /** `purl` et `cpe`, ce qui relie un paquet ou un produit du NVD à sa fiche. */
    identifiers: { type: string; id: string }[];
    /** `lang`, `os`, `database`… */
    category: string | null;
    link: string | null;
    /** Les jalons que le logiciel distingue de sa fin de vie. */
    hasEoas: boolean;
    hasEoes: boolean;
    releases: EolRelease[];
}

/** L'état du service, pour la page des services externes. */
export const eolHealth = { lastOkAt: 0, lastFailure: null as { at: number; reason: string } | null };

type RawRelease = {
    name?: unknown;
    label?: unknown;
    releaseDate?: unknown;
    isLts?: unknown;
    eoasFrom?: unknown;
    isEol?: unknown;
    eolFrom?: unknown;
    eoesFrom?: unknown;
    isMaintained?: unknown;
    latest?: { name?: unknown; date?: unknown } | null;
};
type RawProduct = {
    name?: unknown;
    label?: unknown;
    aliases?: unknown;
    identifiers?: unknown;
    category?: unknown;
    links?: { html?: unknown } | null;
    labels?: { eoas?: unknown; eoes?: unknown } | null;
    releases?: unknown;
};

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

/** Le dump tel que l'API le rend, réduit à ce que la veille et la recherche lisent. Un champ absent vaut `null`. */
export function parseDump(json: unknown): EolProduct[] {
    const result = (json as { result?: unknown } | null)?.result;
    if (!Array.isArray(result)) return [];
    const out: EolProduct[] = [];
    for (const raw of result as RawProduct[]) {
        const name = str(raw.name);
        if (!name || !Array.isArray(raw.releases)) continue;
        const releases = (raw.releases as RawRelease[]).flatMap((r) => {
            const release = str(r.name);
            if (!release) return [];
            const label = str(r.label);
            return [
                {
                    name: release,
                    label: label === release ? null : label,
                    releaseDate: str(r.releaseDate),
                    isLts: r.isLts === true,
                    eoasFrom: str(r.eoasFrom),
                    isEol: r.isEol === true,
                    eolFrom: str(r.eolFrom),
                    eoesFrom: str(r.eoesFrom),
                    isMaintained: r.isMaintained === true,
                    latest: str(r.latest?.name),
                    latestDate: str(r.latest?.date)
                }
            ];
        });
        out.push({
            name,
            label: str(raw.label) ?? name,
            aliases: Array.isArray(raw.aliases) ? raw.aliases.filter((a): a is string => typeof a === 'string') : [],
            identifiers: Array.isArray(raw.identifiers)
                ? (raw.identifiers as { type?: unknown; id?: unknown }[]).flatMap((i) =>
                      str(i.type) && str(i.id) ? [{ type: String(i.type), id: String(i.id) }] : []
                  )
                : [],
            category: str(raw.category),
            link: str(raw.links?.html),
            // Ubuntu nomme un support actif qui finit le jour de la fin de vie :
            // une colonne qui répète la voisine ne dit rien.
            hasEoas: str(raw.labels?.eoas) !== null && releases.some((r) => r.eoasFrom && r.eoasFrom !== r.eolFrom),
            hasEoes: str(raw.labels?.eoes) !== null && releases.some((r) => r.eoesFrom !== null),
            releases
        });
    }
    return out;
}

export async function fetchDump(fetchImpl: typeof fetch = fetch): Promise<EolProduct[]> {
    try {
        const res = await fetchImpl(API, {
            headers: { accept: 'application/json', 'user-agent': 'DevEye' },
            signal: AbortSignal.timeout(TIMEOUT_MS)
        });
        if (!res.ok) throw new Error(`endoflife.date a répondu ${res.status}.`);
        const products = parseDump(await res.json());
        if (products.length === 0) throw new Error('endoflife.date a rendu un catalogue vide.');
        eolHealth.lastOkAt = Date.now();
        return products;
    } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        eolHealth.lastFailure = { at: Date.now(), reason };
        throw e;
    }
}

/**
 * La branche d'une version : la release dont le nom est le plus long préfixe
 * de la version, par segments (`15` pour `15.4`, `22.04` pour `22.04`,
 * `1.25` pour `1.25.3`).
 */
export function releaseFor(product: EolProduct, version: string): EolRelease | null {
    const parts = version.split(/[.\-+]/);
    let best: EolRelease | null = null;
    let bestLength = 0;
    for (const release of product.releases) {
        const segments = release.name.split('.');
        if (segments.length > parts.length || segments.length <= bestLength) continue;
        if (segments.every((s, i) => s === parts[i])) {
            best = release;
            bestLength = segments.length;
        }
    }
    return best;
}

/** Les produits d'endoflife.date, trouvables par leur nom, leurs alias et leurs identifiants. */
export interface EolIndex {
    products: readonly EolProduct[];
    byName: Map<string, EolProduct>;
    byIdentifier: Map<string, EolProduct>;
}

const normalizeId = (id: string): string =>
    decodeURIComponent(id)
        .toLowerCase()
        .replace(/^cpe:\/a:/, 'cpe:2.3:a:');

export function indexOf(products: readonly EolProduct[]): EolIndex {
    const byName = new Map<string, EolProduct>();
    const byIdentifier = new Map<string, EolProduct>();
    for (const p of products) {
        byName.set(p.name, p);
        for (const alias of p.aliases) if (!byName.has(alias)) byName.set(alias, p);
        for (const i of p.identifiers) byIdentifier.set(normalizeId(i.id), p);
    }
    return { products, byName, byIdentifier };
}

/** Le nom endoflife.date d'un outil, quand il diffère du sien. */
const TOOL_PRODUCT: Record<string, string> = {
    node: 'nodejs',
    httpd: 'apache-http-server',
    postgres: 'postgresql',
    mongo: 'mongodb',
    golang: 'go',
    docker: 'docker-engine'
};

/** Les systèmes, tels que `os-release` les nomme, vers leur fiche. */
const OS_PRODUCT: readonly [RegExp, string][] = [
    [/ubuntu/i, 'ubuntu'],
    [/debian/i, 'debian'],
    [/fedora/i, 'fedora'],
    [/alpine/i, 'alpine-linux'],
    [/rocky/i, 'rocky-linux'],
    [/alma/i, 'almalinux'],
    [/red hat|rhel/i, 'rhel'],
    [/centos stream/i, 'centos-stream'],
    [/centos/i, 'centos'],
    [/opensuse leap/i, 'opensuse'],
    [/linux mint/i, 'linuxmint'],
    [/amazon linux/i, 'amazon-linux'],
    [/oracle linux/i, 'oracle-linux']
];

/** L'identifiant purl d'un paquet, pour les écosystèmes qu'endoflife.date relie. */
const PURL_TYPE: Record<string, string> = {
    npm: 'npm',
    PyPI: 'pypi',
    Packagist: 'composer',
    Maven: 'maven',
    RubyGems: 'gem',
    'crates.io': 'cargo',
    NuGet: 'nuget',
    Go: 'golang'
};

/**
 * La fiche d'un composant. Un paquet n'en a une que s'il est déclaré par le
 * projet : la fin de vie d'une dépendance de dépendance n'est pas une décision
 * que l'auteur peut prendre.
 */
export function eolProductOf(c: ExposureComponent, index: EolIndex): EolProduct | null {
    if (c.kind === 'package') {
        const type = PURL_TYPE[c.ecosystem];
        if (!c.direct || !type) return null;
        return index.byIdentifier.get(`pkg:${type}/${c.name}`.toLowerCase()) ?? null;
    }
    if (c.ecosystem === 'os') {
        const id = OS_PRODUCT.find(([re]) => re.test(c.name))?.[1];
        return id ? (index.byName.get(id) ?? null) : null;
    }
    return eolProductOfTool(c.ecosystem, index);
}

/** La fiche d'un outil que la veille reconnaît (`node`, `postgres`). */
export function eolProductOfTool(tool: string, index: EolIndex): EolProduct | null {
    const named = index.byName.get(TOOL_PRODUCT[tool] ?? tool);
    if (named) return named;
    for (const p of TOOLS[tool]?.products ?? []) {
        const found = index.byIdentifier.get(`cpe:2.3:a:${p.vendor}:${p.product}`.toLowerCase());
        if (found) return found;
    }
    return null;
}

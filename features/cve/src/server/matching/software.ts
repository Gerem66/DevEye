import { cveIdCandidate } from '../_shared';
import { eolProductOfTool, releaseFor, type EolIndex, type EolProduct } from './eol';

/**
 * La recherche d'un logiciel dans le catalogue des fins de vie : un nom, et
 * peut-être une version (« node 18 », « postgresql@16.4 », « python3.11 »).
 */

export interface SoftwareQuery {
    name: string;
    version: string | null;
}

const VERSION = /^v?\d+(?:\.\d+)*(?:[-+.][0-9a-z]+)*$/i;
const GLUED = /^([a-z][a-z.-]*[a-z])-?v?(\d+(?:\.\d+)*)$/i;

/**
 * Les lectures possibles d'une requête, la plus probable d'abord. Un nom collé
 * à sa version (`php8.2`) ne vient qu'en dernier : `log4j` ou `k3s` sont des
 * noms entiers. Une CVE ne désigne aucun logiciel.
 */
export function parseSoftwareQuery(query: string): SoftwareQuery[] {
    const q = query.trim();
    if (q.length === 0 || cveIdCandidate(q) !== null) return [];
    const at = q.match(/^(.+?)@v?(\d[\w.+-]*)$/);
    if (at) return [{ name: at[1].trim(), version: at[2] }];
    const out: SoftwareQuery[] = [];
    const tokens = q.split(/\s+/);
    const last = tokens[tokens.length - 1];
    if (tokens.length > 1 && VERSION.test(last)) {
        out.push({ name: tokens.slice(0, -1).join(' '), version: last.replace(/^v/i, '') });
    }
    out.push({ name: q, version: null });
    const glued = tokens.length === 1 ? q.match(GLUED) : null;
    if (glued) out.push({ name: glued[1], version: glued[2] });
    return out;
}

/** La forme qui se compare : minuscules, lettres et chiffres seuls (« Node.js » = « nodejs »). */
function compact(s: string): string {
    return s
        .normalize('NFD')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');
}

/**
 * Les logiciels qui répondent à un nom : le nom exact, un alias ou le nom d'un
 * outil de la veille (`postgres`, `httpd`) d'abord, puis ce qui commence par
 * lui, puis ce qui le contient. Un nom exact écarte ce qui ne fait que le
 * contenir : « node » trouve Node.js, pas « Kubernetes Node Feature Discovery ».
 */
export function findSoftware(index: EolIndex, name: string): EolProduct[] {
    const n = compact(name);
    if (n.length < 2) return [];
    const tool = eolProductOfTool(name.trim().toLowerCase(), index);
    const scored: { product: EolProduct; score: number }[] = [];
    for (const product of index.products) {
        const keys = [product.name, product.label, ...product.aliases].map(compact);
        let score = 0;
        if (product === tool || keys.includes(n)) score = 3;
        else if (keys.some((k) => k.startsWith(n))) score = 2;
        else if (n.length >= 3 && keys.some((k) => k.includes(n))) score = 1;
        if (score > 0) scored.push({ product, score });
    }
    const floor = scored.some((s) => s.score === 3) ? 2 : 1;
    return scored
        .filter((s) => s.score >= floor)
        .sort(
            (a, b) =>
                b.score - a.score ||
                a.product.label.length - b.product.label.length ||
                a.product.label.localeCompare(b.product.label)
        )
        .map((s) => s.product);
}

/**
 * Les branches d'une version : la sienne quand une branche la contient, sinon
 * celles dont le nom commence par elle (Windows « 11 » : `11-23h2`, `11-24h2`).
 */
export function branchesFor(product: EolProduct, version: string): string[] {
    const exact = releaseFor(product, version);
    if (exact) return [exact.name];
    return product.releases
        .filter((r) => r.name.startsWith(version) && /^\D/.test(r.name.slice(version.length)))
        .map((r) => r.name);
}

/**
 * Ce qu'une requête trouve : la première lecture qui nomme au moins un
 * logiciel. Avec une version, seuls ceux qui ont cette branche, s'il y en a :
 * « windows 11 » ne veut pas de Windows Server.
 */
export function searchSoftware(index: EolIndex, query: string): { products: EolProduct[]; version: string | null } {
    for (const reading of parseSoftwareQuery(query)) {
        const products = findSoftware(index, reading.name);
        if (products.length === 0) continue;
        const { version } = reading;
        const versioned = version === null ? [] : products.filter((p) => branchesFor(p, version).length > 0);
        return { products: versioned.length > 0 ? versioned : products, version };
    }
    return { products: [], version: null };
}

import type { CveEntry, CveEntryWithFavoriteRow, CveReference } from '../contracts/domain';
import type { CveUpsert } from './repo';

/** La clé de la clé d'API du NVD dans le magasin de l'espace. */
export const NVD_KEY_STORE_KEY = 'nvdApiKey';

/** Ce qu'une fenêtre d'ingestion demande au NVD, au plus. Une journée y tient. */
export const INGEST_MAX_PAGES = 2;

function parseReferences(raw: string | CveReference[]): CveReference[] {
    // Le pilote MySQL rend une colonne JSON deja decodee ou en chaine selon sa
    // configuration : les deux formes se presentent.
    if (Array.isArray(raw)) return raw;
    try {
        const parsed: unknown = JSON.parse(raw);
        return Array.isArray(parsed) ? (parsed as CveReference[]) : [];
    } catch {
        return [];
    }
}

export function toEntry(row: CveEntryWithFavoriteRow): CveEntry {
    return {
        id: row.cve_id,
        published: row.published,
        lastModified: row.last_modified,
        severity: row.severity,
        score: row.score === null ? null : Number(row.score),
        vector: row.vector,
        cwe: row.cwe,
        summary: row.summary,
        references: parseReferences(row.refs),
        isFavorite: row.favorite !== null
    };
}

/** Une CVE tout juste lue chez le fournisseur, rendue sans repasser par la base. */
export function upsertToEntry(entry: CveUpsert, isFavorite: boolean): CveEntry {
    return { ...entry, isFavorite };
}

/**
 * La forme d'un identifiant CVE tel qu'on le tape : le préfixe est facultatif,
 * le séparateur peut être une espace. « 2026-6785 » et « cve 2026 6785 » disent
 * la même chose que « CVE-2026-6785 ».
 */
const ID_SHAPE = /^(?:cve[\s-]?)?(\d{4})[\s-](\d{4,10})$/i;

/**
 * L'identifiant que cette requête désigne, s'il y en a un.
 *
 * Ce n'est pas un raffinement : le `keywordSearch` du NVD ne regarde QUE les
 * descriptions, jamais les identifiants. Une recherche par numéro qui ne passe
 * pas par `cveId` ne peut donc rien trouver chez lui, et se limite à ce que le
 * catalogue local a déjà vu.
 */
export function cveIdCandidate(query: string): string | null {
    const found = ID_SHAPE.exec(query.trim());
    return found === null ? null : `CVE-${found[1]}-${found[2]}`;
}

/**
 * Les termes d'une recherche : espaces comme séparateurs, tous exigés. Bornés
 * en nombre, une requête ne devant pas se transformer en jointure de vingt LIKE.
 */
export function searchTerms(query: string): string[] {
    return query
        .trim()
        .split(/\s+/)
        .filter((t) => t.length > 0)
        .slice(0, 6);
}

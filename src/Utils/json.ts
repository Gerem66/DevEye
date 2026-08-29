/**
 * Un tableau lu depuis une colonne JSON de MySQL.
 *
 * Le pilote rend tantôt le tableau déjà décodé (colonne `JSON`), tantôt la
 * chaîne brute (colonne `TEXT`, ou vue qui la recopie) : les deux formes
 * arrivent selon la table. Une valeur illisible vaut un tableau vide, jamais une
 * exception, sinon une ligne corrompue ferait tomber toute une liste.
 */
export function parseJsonArray<T>(raw: unknown): T[] {
    if (Array.isArray(raw)) return raw as T[];
    if (typeof raw !== 'string') return [];
    try {
        const parsed: unknown = JSON.parse(raw);
        return Array.isArray(parsed) ? (parsed as T[]) : [];
    } catch {
        return [];
    }
}

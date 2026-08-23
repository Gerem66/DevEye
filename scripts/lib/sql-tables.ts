/**
 * Balayage statique des DDL d'un fichier SQL : quelles tables sont visées.
 *
 * Partagé par les deux sentinelles du cycle de vie d'un module :
 * `gen-features` (les migrations ne touchent que `ft_<slug>_*`, allowlist des
 * tables historiques d'une native rapatriée) et `uninstall-feature` (le
 * `uninstall.sql` ne détruit QUE `ft_<slug>_*`, sans allowlist : les tables
 * historiques sont des données de l'app, jamais à lui).
 */
export function sqlTableTargets(sql: string): string[] {
    const targets: string[] = [];
    const patterns = [
        /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"]?([A-Za-z0-9_]+)/gi,
        /ALTER\s+TABLE\s+[`"]?([A-Za-z0-9_]+)/gi,
        /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?[`"]?([A-Za-z0-9_]+)/gi,
        /RENAME\s+TABLE\s+[`"]?([A-Za-z0-9_]+)/gi,
        /CREATE\s+(?:UNIQUE\s+)?INDEX\s+\S+\s+ON\s+[`"]?([A-Za-z0-9_]+)/gi,
        /DELETE\s+FROM\s+[`"]?([A-Za-z0-9_]+)/gi,
        /TRUNCATE\s+(?:TABLE\s+)?[`"]?([A-Za-z0-9_]+)/gi
    ];
    for (const re of patterns) {
        for (let m = re.exec(sql); m !== null; m = re.exec(sql)) targets.push(m[1]);
    }
    return targets;
}

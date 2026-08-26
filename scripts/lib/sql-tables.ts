/**
 * Balayage statique d'un fichier SQL : quelles tables sont visées, en DDL
 * comme en DML. Un module ne doit toucher que `ft_<slug>_*` (allowlist des
 * tables historiques d'une native rapatriée), et une écriture de données dans
 * une table du socle est une violation au même titre qu'un ALTER.
 *
 * Partagé par les deux sentinelles du cycle de vie d'un module : `gen-features`
 * (les migrations) et `uninstall-feature` (le `uninstall.sql`, sans allowlist :
 * les tables historiques sont des données de l'app, jamais à lui).
 */
export function sqlTableTargets(sql: string): string[] {
    const targets: string[] = [];
    const patterns = [
        /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"]?([A-Za-z0-9_]+)/gi,
        /CREATE\s+(?:OR\s+REPLACE\s+)?(?:VIEW|TRIGGER)\s+[`"]?([A-Za-z0-9_]+)/gi,
        /CREATE\s+TRIGGER\s+\S+\s+(?:BEFORE|AFTER)\s+\w+\s+ON\s+[`"]?([A-Za-z0-9_]+)/gi,
        /CREATE\s+(?:UNIQUE\s+)?INDEX\s+\S+\s+ON\s+[`"]?([A-Za-z0-9_]+)/gi,
        /ALTER\s+TABLE\s+[`"]?([A-Za-z0-9_]+)/gi,
        /DROP\s+(?:TABLE|VIEW|TRIGGER)\s+(?:IF\s+EXISTS\s+)?[`"]?([A-Za-z0-9_]+)/gi,
        /TRUNCATE\s+(?:TABLE\s+)?[`"]?([A-Za-z0-9_]+)/gi,
        /INSERT\s+(?:IGNORE\s+)?INTO\s+[`"]?([A-Za-z0-9_]+)/gi,
        /REPLACE\s+INTO\s+[`"]?([A-Za-z0-9_]+)/gi,
        /UPDATE\s+(?:IGNORE\s+)?[`"]?([A-Za-z0-9_]+)/gi,
        /DELETE\s+FROM\s+[`"]?([A-Za-z0-9_]+)/gi,
        /LOAD\s+DATA\s+(?:LOCAL\s+)?INFILE\s+\S+\s+(?:REPLACE\s+|IGNORE\s+)?INTO\s+TABLE\s+[`"]?([A-Za-z0-9_]+)/gi
    ];
    for (const re of patterns) {
        for (let m = re.exec(sql); m !== null; m = re.exec(sql)) targets.push(m[1]);
    }
    // `RENAME TABLE a TO b, c TO d` : les deux côtés de chaque paire sont visés.
    const renames = /RENAME\s+TABLE\s+([^;]+)/gi;
    for (let m = renames.exec(sql); m !== null; m = renames.exec(sql)) {
        const pairs = /[`"]?([A-Za-z0-9_]+)[`"]?\s+TO\s+[`"]?([A-Za-z0-9_]+)/gi;
        for (let p = pairs.exec(m[1]); p !== null; p = pairs.exec(m[1])) targets.push(p[1], p[2]);
    }
    return targets;
}

import fs from 'node:fs';
import path from 'node:path';

import { readFeatureConfig, resolveModuleDir } from './features-config';
import { scopeFileSchema, type Exemption, type KeyDeclaration, type TableDeclaration } from './query-scope';

/** Un dépôt de requêtes et sa déclaration de cloisonnement : le socle, ou un module installé. */
export interface ScopeRoot {
    /** Le dossier, depuis celui du workspace : ce que le rapport affiche. */
    label: string;
    dir: string;
    /** Sa déclaration, qu'elle existe ou non. */
    file: string;
    exempt: Map<string, Exemption>;
}

/**
 * Le socle, qui déclare dans `src/db/scope.json`, et chaque module installé,
 * dans son `deveye-scope.json`. Du dossier le plus profond au moins profond :
 * un module du dépôt vit sous le socle.
 */
export function scopeRoots(root: string, workspace: string): ScopeRoot[] {
    const make = (dir: string, file: string): ScopeRoot => ({
        label: path.relative(workspace, dir) || '.',
        dir,
        file,
        exempt: new Map()
    });
    const roots = [make(root, path.join(root, 'src', 'db', 'scope.json'))];
    for (const config of ['features.config.json', 'features.local.json'] as const) {
        for (const entry of readFeatureConfig(root, config)) {
            const resolved = resolveModuleDir(root, entry);
            if (!resolved) continue;
            const dir = fs.realpathSync(resolved);
            if (!roots.some((r) => r.dir === dir)) roots.push(make(dir, path.join(dir, 'deveye-scope.json')));
        }
    }
    return roots.sort((a, b) => b.dir.length - a.dir.length);
}

export function rootOf(file: string, roots: readonly ScopeRoot[]): ScopeRoot | null {
    return roots.find((r) => file === r.dir || file.startsWith(r.dir + path.sep)) ?? null;
}

/**
 * Lit chaque déclaration présente : remplit les dispenses de chaque dépôt, rend
 * les classes de tables déclarées et ce qui cloche dans les fichiers.
 */
export function loadScopeFiles(roots: readonly ScopeRoot[]): {
    declared: Map<string, TableDeclaration>;
    keys: Map<string, KeyDeclaration>;
    problems: string[];
} {
    const declared = new Map<string, TableDeclaration>();
    const keys = new Map<string, KeyDeclaration>();
    const owners = new Map<string, string>();
    const problems: string[] = [];
    for (const root of roots) {
        if (!fs.existsSync(root.file)) continue;
        const where = path.join(root.label, path.relative(root.dir, root.file));
        let raw: unknown;
        try {
            raw = JSON.parse(fs.readFileSync(root.file, 'utf8'));
        } catch (e) {
            problems.push(`${where} : JSON illisible (${(e as Error).message})`);
            continue;
        }
        const parsed = scopeFileSchema.safeParse(raw);
        if (!parsed.success) {
            for (const issue of parsed.error.issues)
                problems.push(`${where} : ${issue.path.join('.')} ${issue.message}`);
            continue;
        }
        for (const [table, declaration] of Object.entries(parsed.data.tables)) {
            const other = owners.get(table);
            if (other) problems.push(`${where} : « ${table} » est déjà déclarée dans ${other}`);
            else {
                owners.set(table, where);
                declared.set(table, declaration);
            }
        }
        for (const [table, key] of Object.entries(parsed.data.keys)) {
            if (keys.has(table)) problems.push(`${where} : les clés de « ${table} » sont déjà déclarées ailleurs`);
            else keys.set(table, key);
        }
        for (const [key, exemption] of Object.entries(parsed.data.exempt)) root.exempt.set(key, exemption);
    }
    return { declared, keys, problems };
}

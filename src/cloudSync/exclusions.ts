import type { SyncExclusionKind, SyncExclusionRow, SyncShareAssignment } from 'deveye-types';
import { SYNC_DEFAULT_IGNORED_NAMES } from 'deveye-types';
import { safeRelPath } from './pathValidation';

/**
 * Exclusions d'un partage. Trois formes (mêmes sémantiques côté agent, qui
 * fait le vrai filtrage au scan — le moteur `regex` de Rust est linéaire) :
 *  - `path`  → chemin relatif exact, fichier ou préfixe de dossier ;
 *  - `name`  → nom exact d'un composant (ex. `node_modules`, `.git`) ;
 *  - `regex` → expression régulière sur le chemin relatif complet.
 */

/** Valide un motif à l'ajout. Retourne le problème (français) ou `null` si OK. */
export function validateExclusionPattern(kind: SyncExclusionKind, pattern: string): string | null {
    switch (kind) {
        case 'path':
            return safeRelPath(pattern) === null ? 'Chemin relatif invalide.' : null;
        case 'name':
            if (pattern.includes('/') || pattern.includes('\\')) {
                return 'Un nom ne peut pas contenir de séparateur.';
            }
            return null;
        case 'regex':
            try {
                new RegExp(pattern);
                return null;
            } catch {
                return 'Expression régulière invalide.';
            }
    }
}

/** Compile un prédicat « ce chemin relatif est-il exclu ? » (usage serveur).
 *  Les déchets d'OS ({@link SYNC_DEFAULT_IGNORED_NAMES}) sont toujours exclus. */
export function compileExclusions(
    rows: ReadonlyArray<Pick<SyncExclusionRow, 'kind' | 'pattern'>>
): (relPath: string) => boolean {
    const paths: string[] = [];
    const names = new Set<string>(SYNC_DEFAULT_IGNORED_NAMES);
    const regexes: RegExp[] = [];
    for (const row of rows) {
        if (row.kind === 'path') paths.push(row.pattern);
        else if (row.kind === 'name') names.add(row.pattern);
        else {
            try {
                regexes.push(new RegExp(row.pattern));
            } catch {
                // Motif devenu invalide : ignoré (l'ajout le valide, ceinture ici).
            }
        }
    }
    return (relPath) => {
        for (const p of paths) {
            if (relPath === p || relPath.startsWith(`${p}/`)) return true;
        }
        if (names.size > 0 && relPath.split('/').some((seg) => names.has(seg))) return true;
        return regexes.some((re) => re.test(relPath));
    };
}

/** La forme envoyée à l'agent dans `sync.config` (déchets d'OS inclus :
 *  l'agent n'a aucune liste en dur, le serveur reste la source de vérité). */
export function toAssignmentExclusions(rows: ReadonlyArray<SyncExclusionRow>): SyncShareAssignment['exclusions'] {
    return [
        ...SYNC_DEFAULT_IGNORED_NAMES.map((name) => ({ kind: 'name' as const, pattern: name })),
        ...rows.map((r) => ({ kind: r.kind, pattern: r.pattern }))
    ];
}

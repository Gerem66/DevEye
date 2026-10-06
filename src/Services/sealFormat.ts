import { getQueryable, type DbPool } from '@/db/pool';
import { isCurrentSealFormat, sealedRows, type SealTarget } from './sealTargets';

/**
 * Refuse de démarrer sur une base dont un blob scellé n'est pas au format
 * courant : le serveur ne saurait pas l'ouvrir, et l'échec surgirait plus tard,
 * au premier déverrouillage ou à la première connexion en 2FA. Le passage se
 * fait par un script (`npm run reseal:server-key`) et non par une migration de
 * boot : il lui faut la clé serveur et une transaction annulable.
 */
export async function assertSealFormat(pool: DbPool, targets: readonly SealTarget[]): Promise<void> {
    const stale: string[] = [];
    const q = getQueryable(pool);
    for (const t of targets) {
        const rows = await sealedRows(q, t);
        if (rows === null) continue;
        const old = rows.filter((r) => !isCurrentSealFormat(r.enc)).length;
        if (old > 0) stale.push(`${t.table}.${t.column} (${old})`);
    }
    if (stale.length === 0) return;
    throw new Error(
        `Blobs scellés à l'ancien format : ${stale.join(', ')}. Arrêter le serveur, lancer ` +
            '`npm run reseal:server-key` (dry-run) puis `npm run reseal:server-key -- --yes`, et redémarrer. ' +
            'Procédure : Docs/KEY_ROTATION.md.'
    );
}

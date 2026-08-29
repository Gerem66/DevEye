/**
 * Change la clé serveur (`CRYPT_KEY_A` / `CRYPT_KEY_B`) sans rien perdre : elle
 * n'emballe que des clés et scelle le secret TOTP (procédure dans
 * `Docs/KEY_ROTATION.md`). Chaque ligne est rouverte, rescellée, relue, en une
 * seule transaction.
 *
 * Usage : NEW_CRYPT_KEY_A=… NEW_CRYPT_KEY_B=… npm run rotate:server-key [-- --yes]
 *   anciennes clés : l'environnement courant ; dry-run par défaut.
 *
 * Serveur arrêté : un serveur vivant écrirait encore sous l'ancienne clé. Les
 * archives de sauvegarde déjà écrites restent sous l'ancienne clé dérivée.
 */
import { createDbPool, testConnection, withTransaction, type Queryable } from '@/db/pool';
import Encryption from '@/Services/Encryption';
import { env } from '@/Utils/Env';

interface Target {
    table: string;
    column: string;
    /** La colonne qui identifie une ligne à elle seule. */
    id: string;
    /** Restreint aux lignes emballées par la clé serveur, quand la table en mêle d'autres. */
    where?: string;
}

const TARGETS: Target[] = [
    { table: 'user_secret_keys', column: 'dek_wrapped', id: 'user_id', where: "wrap_mode = 'server'" },
    { table: 'user_secret_keys', column: 'open_dek_wrapped', id: 'user_id' },
    { table: 'workspace_secret_keys', column: 'dek_wrapped', id: 'workspace_id' },
    { table: 'user_2fa', column: 'secret_enc', id: 'user_id' },
    // CloudSync : la BMK, scellée par `deps.keys.sealBytes`. Un autre module
    // qui scelle du matériel ajoute sa ligne ici.
    { table: 'sync_meta', column: 'v', id: 'k', where: "k = 'blob_key_wrapped'" }
];

const YES = process.argv.includes('--yes');

function fail(message: string): never {
    console.error(`rotate-server-key: ${message}`);
    process.exit(1);
}

type Row = { id: string | number; enc: string };

async function tableExists(q: Queryable, table: string): Promise<boolean> {
    const r = await q.query<{ n: number }>(
        'SELECT COUNT(*) n FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
        [table]
    );
    return Number(r.rows[0]?.n ?? 0) > 0;
}

async function main(): Promise<void> {
    const newA = process.env.NEW_CRYPT_KEY_A ?? '';
    const newB = process.env.NEW_CRYPT_KEY_B ?? '';
    if (!newA || !newB) fail('NEW_CRYPT_KEY_A et NEW_CRYPT_KEY_B sont requis (les nouvelles clés)');
    if (newA === env.CRYPT_KEY_A && newB === env.CRYPT_KEY_B) fail('les nouvelles clés sont les anciennes');
    const oldKey = new Encryption(env.CRYPT_KEY_A, env.CRYPT_KEY_B);
    const newKey = new Encryption(newA, newB);

    const pool = createDbPool();
    if (!(await testConnection(pool))) fail('connexion à la base impossible (tunnel ouvert ? variables DB_* ?)');
    console.log(`Rotation de la clé serveur — ${YES ? 'EXÉCUTION' : 'dry-run, rien ne sera écrit'}\n`);

    let unreadable = 0;
    let total = 0;
    await withTransaction(pool, async (q) => {
        for (const t of TARGETS) {
            if (!(await tableExists(q, t.table))) {
                console.log(`  ${t.table}.${t.column}`.padEnd(44) + 'table absente, ignorée');
                continue;
            }
            const r = await q.query<Row>(
                `SELECT ${t.id} AS id, ${t.column} AS enc FROM ${t.table}
                 WHERE ${t.column} IS NOT NULL AND ${t.column} <> ''${t.where ? ` AND ${t.where}` : ''}`,
                []
            );
            const bad: (string | number)[] = [];
            for (const row of r.rows) {
                const plain = oldKey.openRaw(row.enc);
                if (plain === null) {
                    bad.push(row.id);
                    continue;
                }
                if (!YES) continue;
                const sealed = newKey.seal(plain);
                const check = newKey.openRaw(sealed);
                if (check === null || !check.equals(plain)) {
                    throw new Error(`${t.table}.${t.column} ${row.id} : relecture impossible sous la nouvelle clé`);
                }
                await q.query(`UPDATE ${t.table} SET ${t.column} = ? WHERE ${t.id} = ?`, [sealed, row.id]);
            }
            total += r.rows.length - bad.length;
            unreadable += bad.length;
            const state = YES ? 'ré-emballée(s)' : 'à ré-emballer';
            const badNote = bad.length > 0 ? `, ${bad.length} ILLISIBLE(S) : ${bad.join(', ')}` : '';
            console.log(`  ${t.table}.${t.column}`.padEnd(44) + `${r.rows.length - bad.length} ${state}${badNote}`);
        }
        if (unreadable > 0) {
            throw new Error(
                `${unreadable} blob(s) illisible(s) sous la clé courante : cet environnement n'est pas celui qui a écrit la base. Rien n'est écrit.`
            );
        }
        if (!YES) throw new DryRun();
    }).catch((e: unknown) => {
        if (e instanceof DryRun) return;
        throw e;
    });
    await pool.end();

    console.log('');
    if (YES) {
        console.log(
            `${total} blob(s) ré-emballé(s). Basculer CRYPT_KEY_A/B sur les nouvelles valeurs AVANT de redémarrer,`
        );
        console.log('et garder les anciennes pour les archives de sauvegarde déjà écrites (Docs/KEY_ROTATION.md).');
    } else {
        console.log(`${total} blob(s) s'ouvrent sous la clé courante. Relancer avec --yes pour les ré-emballer.`);
    }
}

/** Le dry-run sort de la transaction par une erreur : c'est ce qui la fait annuler. */
class DryRun extends Error {}

main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
});

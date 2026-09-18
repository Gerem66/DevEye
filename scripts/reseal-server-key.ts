/**
 * Porte une base au format 2 du scellement : chaque blob que la clé serveur
 * scellait nu (une seule clé, sans contexte) est rouvert, puis rescellé sous la
 * sous-clé de son usage avec sa ligne en contexte (`Services/Encryption.ts`).
 * Le serveur refuse de démarrer tant qu'il reste un blob à l'ancien format
 * (`Services/sealFormat.ts`). Procédure : `Docs/KEY_ROTATION.md`.
 *
 * Usage : npm run reseal:server-key [-- --yes]   (dry-run par défaut)
 *
 * Serveur arrêté. Rejouable : un blob déjà au format 2 est compté et laissé.
 */
import { createDbPool, testConnection, withTransaction } from '@/db/pool';
import Encryption from '@/Services/Encryption';
import { env } from '@/Utils/Env';
import { SEAL_TARGETS, sealedRows } from '@/Services/sealTargets';

const YES = process.argv.includes('--yes');

function fail(message: string): never {
    console.error(`reseal-server-key: ${message}`);
    process.exit(1);
}

async function main(): Promise<void> {
    const crypt = new Encryption(env.CRYPT_KEY_A, env.CRYPT_KEY_B);
    const legacyKey = Encryption.legacyServerKey(env.CRYPT_KEY_A, env.CRYPT_KEY_B);

    const pool = createDbPool();
    if (!(await testConnection(pool))) fail('connexion à la base impossible (tunnel ouvert ? variables DB_* ?)');
    console.log(`Re-scellement au format 2 : ${YES ? 'EXÉCUTION' : 'dry-run, rien ne sera écrit'}\n`);

    let unreadable = 0;
    let resealed = 0;
    let already = 0;
    await withTransaction(pool, async (q) => {
        for (const t of SEAL_TARGETS) {
            const rows = await sealedRows(q, t);
            if (rows === null) {
                console.log(`  ${t.table}.${t.column}`.padEnd(44) + 'table absente, ignorée');
                continue;
            }
            const bad: (string | number)[] = [];
            let done = 0;
            let todo = 0;
            for (const row of rows) {
                const context = t.context(row.id);
                // L'ancien format d'abord : un IV aléatoire peut commencer par
                // l'octet de version, l'inverse (un blob au format 2 qui
                // s'ouvrirait sous l'ancienne clé nue) ne peut pas arriver.
                const plain = Encryption.decryptWithKeyRaw(legacyKey, row.enc);
                if (plain === null) {
                    if (crypt.openFor(t.label, row.enc, context) !== null) done += 1;
                    else bad.push(row.id);
                    continue;
                }
                todo += 1;
                if (!YES) continue;
                const sealed = crypt.sealFor(t.label, plain, context);
                const check = crypt.openFor(t.label, sealed, context);
                if (check === null || !check.equals(plain)) {
                    throw new Error(`${t.table}.${t.column} ${row.id} : relecture impossible après re-scellement`);
                }
                await q.query(`UPDATE ${t.table} SET ${t.column} = ? WHERE ${t.id} = ?`, [sealed, row.id]);
            }
            resealed += todo;
            already += done;
            unreadable += bad.length;
            const state = YES ? 're-scellée(s)' : 'à re-sceller';
            const badNote = bad.length > 0 ? `, ${bad.length} ILLISIBLE(S) : ${bad.join(', ')}` : '';
            console.log(`  ${t.table}.${t.column}`.padEnd(44) + `${todo} ${state}, ${done} déjà au format 2${badNote}`);
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
    if (YES) console.log(`${resealed} blob(s) re-scellé(s), ${already} déjà au format 2. Le serveur peut redémarrer.`);
    else console.log(`${resealed} blob(s) à re-sceller, ${already} déjà au format 2. Relancer avec --yes.`);
}

/** Le dry-run sort de la transaction par une erreur : c'est ce qui la fait annuler. */
class DryRun extends Error {}

main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
});

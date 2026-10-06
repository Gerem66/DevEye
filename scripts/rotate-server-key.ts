/**
 * Change la clé serveur (`CRYPT_KEY_A` / `CRYPT_KEY_B`) sans rien perdre : elle
 * emballe des clés, et scelle le secret TOTP et ce que les modules déclarent
 * (procédure dans `Docs/KEY_ROTATION.md`). Chaque ligne est rouverte, rescellée
 * sous la même étiquette et le même contexte, relue, en une seule transaction.
 *
 * Usage : NEW_CRYPT_KEY_A=… NEW_CRYPT_KEY_B=… npm run rotate:server-key [-- --yes]
 *   anciennes clés : l'environnement courant ; dry-run par défaut.
 *
 * Serveur arrêté : un serveur vivant écrirait encore sous l'ancienne clé. Les
 * archives de sauvegarde déjà écrites restent sous l'ancienne clé dérivée, et
 * les codes de secours 2FA (condensés sous une clé dérivée) sont à régénérer.
 */
import { createDbPool, testConnection, withTransaction } from '@/db/pool';
import Encryption from '@/Services/Encryption';
import { env } from '@/Utils/Env';
import { INSTALLED_MODULES } from '@/features/_generated/installed';
import { sealedRows, sealTargets } from '@/Services/sealTargets';

const YES = process.argv.includes('--yes');

function fail(message: string): never {
    console.error(`rotate-server-key: ${message}`);
    process.exit(1);
}

async function main(): Promise<void> {
    const newA = process.env.NEW_CRYPT_KEY_A ?? '';
    const newB = process.env.NEW_CRYPT_KEY_B ?? '';
    if (!newA || !newB) fail('NEW_CRYPT_KEY_A et NEW_CRYPT_KEY_B sont requis (les nouvelles clés)');
    if (newA.length < 32 || newB.length < 32) fail('les nouvelles clés doivent faire au moins 32 caractères chacune');
    if (newA === newB) fail('NEW_CRYPT_KEY_A et NEW_CRYPT_KEY_B doivent différer');
    if (newA === env.CRYPT_KEY_A && newB === env.CRYPT_KEY_B) fail('les nouvelles clés sont les anciennes');
    const oldKey = new Encryption(env.CRYPT_KEY_A, env.CRYPT_KEY_B);
    const newKey = new Encryption(newA, newB);

    const pool = createDbPool();
    if (!(await testConnection(pool))) fail('connexion à la base impossible (tunnel ouvert ? variables DB_* ?)');
    console.log(`Rotation de la clé serveur : ${YES ? 'EXÉCUTION' : 'dry-run, rien ne sera écrit'}\n`);

    let unreadable = 0;
    let total = 0;
    await withTransaction(pool, async (q) => {
        for (const t of sealTargets(INSTALLED_MODULES)) {
            const rows = await sealedRows(q, t);
            if (rows === null) {
                console.log(`  ${t.table}.${t.column}`.padEnd(44) + 'table absente, ignorée');
                continue;
            }
            const bad: (string | number)[] = [];
            for (const row of rows) {
                const context = t.context(row.id);
                const plain = oldKey.openFor(t.label, row.enc, context);
                if (plain === null) {
                    bad.push(row.id);
                    continue;
                }
                if (!YES) continue;
                const sealed = newKey.sealFor(t.label, plain, context);
                const check = newKey.openFor(t.label, sealed, context);
                if (check === null || !check.equals(plain)) {
                    throw new Error(`${t.table}.${t.column} ${row.id} : relecture impossible sous la nouvelle clé`);
                }
                await q.query(`UPDATE ${t.table} SET ${t.column} = ? WHERE ${t.id} = ?`, [sealed, row.id]);
            }
            total += rows.length - bad.length;
            unreadable += bad.length;
            const state = YES ? 'ré-emballée(s)' : 'à ré-emballer';
            const badNote = bad.length > 0 ? `, ${bad.length} ILLISIBLE(S) : ${bad.join(', ')}` : '';
            console.log(`  ${t.table}.${t.column}`.padEnd(44) + `${rows.length - bad.length} ${state}${badNote}`);
        }
        if (unreadable > 0) {
            throw new Error(
                `${unreadable} blob(s) illisible(s) sous la clé courante : cet environnement n'est pas celui qui a écrit la base, ou la base n'est pas au format 2 (npm run reseal:server-key). Rien n'est écrit.`
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

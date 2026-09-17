/**
 * Désinstallation propre d'un module de feature : toutes ses traces, partout.
 * Dans l'ordre : ses tables `ft_<slug>_*` (via son `src/server/uninstall.sql`,
 * borné au préfixe), son magasin clé-valeur, ses domaines, ses migrations
 * enregistrées, ses canaux et routes de notification, ses partages et
 * restrictions d'éléments, ses grants dans les rôles, ses tuiles dans toutes
 * les dispositions d'accueil.
 * Le journal d'audit reste.
 *
 * Dry-run par défaut, n'écrit qu'avec `--yes`. Chaque étape est idempotente :
 * un échec au milieu se répare en relançant.
 *
 * Usage :
 *   npm run uninstall:feature -- <package> [--yes]
 *
 * S'exécute avant de retirer l'entrée de config et le paquet (il faut son
 * deveye-feature.json et son uninstall.sql), serveur arrêté (un serveur qui
 * tourne encore recréerait du KV derrière le nettoyage). Un module déjà disparu
 * se nettoie par `--id=x-machin` : seule la part app est alors couverte,
 * d'éventuelles tables ft_* restent, et le script le dit.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDbPool, getQueryable, testConnection, type Queryable } from '@/db/pool';
import { readFeatureConfig, resolveModuleDir, tablePrefix } from './lib/features-config';
import { forbiddenUninstallTargets, scrubHomeLayout, scrubRoleGrants } from './lib/uninstall';
import { sqlTableTargets } from './lib/sql-tables';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const YES = process.argv.includes('--yes');
const idFlag = process.argv.find((a) => a.startsWith('--id='))?.slice('--id='.length);
const PKG = positional[0];
if (!PKG && !idFlag) {
    console.error('Usage: npm run uninstall:feature -- <package> [--yes] | -- --id=<featureId> [--yes]');
    process.exit(2);
}

function fail(message: string): never {
    console.error(`uninstall-feature: ${message}`);
    process.exit(1);
}

/** Le dossier du paquet : le `path` d'une des deux configs (l'overlay local d'abord), sinon node_modules. */
function packageDir(pkg: string): string {
    const byPath = (['features.local.json', 'features.config.json'] as const)
        .flatMap((file) => readFeatureConfig(ROOT, file))
        .find((e) => e.package === pkg && e.path);
    const dir = resolveModuleDir(ROOT, byPath ?? { package: pkg });
    if (dir === null) fail(`« ${pkg} » introuvable : ni dans les configs (par chemin), ni dans node_modules`);
    return dir;
}

async function main(): Promise<void> {
    let id: string;
    let uninstallSql: string | null = null;

    if (idFlag) {
        // Mode « module déjà disparu » : rien à résoudre, part app seulement.
        id = idFlag;
        console.warn(
            `uninstall-feature: --id sans paquet — pas d'uninstall.sql : d'éventuelles tables ${tablePrefix(id)}* resteront.\n`
        );
    } else {
        const dir = packageDir(PKG);
        const metaPath = path.join(dir, 'deveye-feature.json');
        if (!fs.existsSync(metaPath)) fail(`${PKG}: deveye-feature.json manquant (${dir})`);
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as { id?: string };
        if (!meta.id) fail(`${PKG}: deveye-feature.json sans « id »`);
        id = meta.id;

        // Le SQL de démontage du module, s'il a des tables à lui. Vérifié AVANT
        // de toucher quoi que ce soit : hors préfixe, on refuse tout.
        const uninstallPath = path.join(dir, 'src', 'server', 'uninstall.sql');
        uninstallSql = fs.existsSync(uninstallPath) ? fs.readFileSync(uninstallPath, 'utf8') : null;
        if (uninstallSql) {
            const outlaw = forbiddenUninstallTargets(id, uninstallSql);
            if (outlaw.length > 0) {
                fail(`${PKG}: uninstall.sql touche ${outlaw.join(', ')} — hors du préfixe ${tablePrefix(id)}`);
            }
        }
    }

    const pool = createDbPool();
    if (!(await testConnection(pool))) fail('connexion à la base impossible (tunnel ouvert ? variables DB_* ?)');
    const q: Queryable = getQueryable(pool);

    const count = async (sql: string, params: unknown[]): Promise<number> => {
        const r = await q.query<{ n: number }>(sql, params);
        return Number(r.rows[0]?.n ?? 0);
    };

    console.log(
        `Désinstallation de « ${id} »${PKG ? ` (${PKG})` : ''} — ${YES ? 'EXÉCUTION' : 'dry-run, rien ne sera écrit'}\n`
    );

    // --- 1. les tables du module -------------------------------------------
    const tables = uninstallSql ? [...new Set(sqlTableTargets(uninstallSql))] : [];
    if (uninstallSql) {
        console.log(`tables (uninstall.sql) : ${tables.join(', ') || 'aucune cible détectée'}`);
    } else {
        console.log('tables : pas de src/server/uninstall.sql — rien à détruire (module sans tables ?)');
    }

    // --- 2..5 : les lignes portées par un id de feature ---------------------
    const rows: { label: string; table: string }[] = [
        { label: 'magasin clé-valeur', table: 'feature_kv' },
        { label: 'domaines', table: 'feature_domains' },
        { label: 'canaux de notification', table: 'notification_channels' },
        { label: 'routes de notification', table: 'notification_routes' },
        { label: "partages d'éléments", table: 'item_shares' },
        { label: "restrictions d'éléments", table: 'item_role_grants' }
    ];
    for (const r of rows) {
        console.log(
            `${r.label} : ${await count(`SELECT COUNT(*) AS n FROM ${r.table} WHERE feature = ?`, [id])} ligne(s)`
        );
    }
    const migrations = await count('SELECT COUNT(*) AS n FROM _migrations WHERE name LIKE ?', [`${id}/%`]);
    console.log(`migrations enregistrées : ${migrations}`);

    // --- 6. les grants dans les rôles ---------------------------------------
    const roles = await q.query<{ id: number; features: string }>('SELECT id, features FROM workspace_roles', []);
    const rolePatches = roles.rows
        .map((r) => ({ id: r.id, next: scrubRoleGrants(String(r.features), id) }))
        .filter((r): r is { id: number; next: string } => r.next !== null);
    console.log(`rôles portant un grant : ${rolePatches.length}`);

    // --- 7. les dispositions d'accueil --------------------------------------
    const workspaces = await q.query<{ id: number; home_layout: string | null }>(
        'SELECT id, home_layout FROM workspaces WHERE home_layout IS NOT NULL',
        []
    );
    const layoutPatches = workspaces.rows
        .map((w) => ({ id: w.id, next: scrubHomeLayout(String(w.home_layout), id) }))
        .filter((w): w is { id: number; next: string } => w.next !== null);
    console.log(`dispositions d'accueil touchées : ${layoutPatches.length}`);

    if (!YES) {
        console.log('\nDry-run terminé. Relancer avec --yes pour nettoyer (serveur arrêté).');
        await pool.end();
        return;
    }

    // --- exécution ----------------------------------------------------------
    if (uninstallSql) {
        // Le fichier entier en une requête, comme une migration (pool en
        // `multipleStatements`) : découper sur `;` casserait sur les commentaires.
        await q.query(uninstallSql);
        console.log('\n✓ uninstall.sql exécuté');
    }
    for (const r of rows) {
        await q.query(`DELETE FROM ${r.table} WHERE feature = ?`, [id]);
    }
    console.log('✓ lignes par feature supprimées (kv, domaines, canaux, routes, partages, restrictions)');
    await q.query('DELETE FROM _migrations WHERE name LIKE ?', [`${id}/%`]);
    console.log('✓ migrations désenregistrées');
    for (const patch of rolePatches) {
        await q.query('UPDATE workspace_roles SET features = ? WHERE id = ?', [patch.next, patch.id]);
    }
    console.log(`✓ ${rolePatches.length} rôle(s) nettoyé(s)`);
    for (const patch of layoutPatches) {
        await q.query('UPDATE workspaces SET home_layout = ? WHERE id = ?', [patch.next, patch.id]);
    }
    console.log(`✓ ${layoutPatches.length} disposition(s) nettoyée(s)`);

    console.log(
        `\nTerminé. Reste à faire : retirer « ${PKG ?? id} » de features.config.json / features.local.json,` +
            `\nnpm uninstall si besoin, puis npm run gen:features.`
    );
    await pool.end();
}

void main();

/**
 * Désinstallation PROPRE d'un module de feature : toutes ses traces, partout.
 *
 * Installer un module = dépendance + entrée de config + `gen:features`. Le
 * chemin inverse n'existait pas : retirer l'entrée laissait ses tables, son
 * KV, ses permissions dans les rôles, ses tuiles posées. Ce script est le
 * geste manquant. Il nettoie, dans l'ordre :
 *
 *  1. ses tables `ft_<slug>_*` — via le `src/server/uninstall.sql` du module
 *     (le pendant destructif de ses migrations ; vérifié : il ne peut toucher
 *     QUE le préfixe du module, jamais une table historique de l'allowlist) ;
 *  2. son magasin clé-valeur (`feature_kv`) ;
 *  3. ses migrations enregistrées (`_migrations` en `<id>/...`) ;
 *  4. ses canaux et routes de notification (`notification_channels`,
 *     `notification_routes` — les liaisons suivent par cascade) ;
 *  5. ses partages et restrictions d'éléments (`item_shares`,
 *     `item_role_grants`) ;
 *  6. ses grants dans les rôles de tous les espaces (droit + extras + canaux :
 *     le JSON `workspace_roles.features`) ;
 *  7. ses tuiles et son mini-widget de topbar dans TOUTES les dispositions
 *     d'accueil (`workspaces.home_layout`).
 *
 * Le journal d'audit reste : c'est de l'histoire, pas une dépendance.
 *
 * **Dry-run par défaut** : il énumère ce qu'il ferait, avec les comptes réels,
 * et n'écrit qu'avec `--yes` — même discipline que les migrations (rejouées
 * sur copie du dump avant toute prod). Ordre d'exécution pensé pour être
 * REJOUABLE : chaque étape est idempotente (écrire un `uninstall.sql` en
 * `DROP TABLE IF EXISTS`), un échec au milieu se répare en relançant.
 *
 * Usage :
 *   npx tsx scripts/uninstall-feature.ts <package> [--yes]
 *   npx tsx scripts/uninstall-feature.ts deveye-feature-countdown            # état des lieux
 *   npx tsx scripts/uninstall-feature.ts deveye-feature-countdown --yes      # nettoie
 *
 * Après le nettoyage : retirer l'entrée de features.config.json (ou
 * features.local.json), `npm uninstall <package>` s'il vient de npm, puis
 * `npm run gen:features`. Le script s'exécute AVANT, tant que le module est
 * encore résoluble (il faut son deveye-feature.json et son uninstall.sql),
 * et de préférence serveur ARRÊTÉ (un serveur qui tourne encore avec le
 * module recréerait du KV derrière le nettoyage).
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { createDbPool, getQueryable, testConnection, type Queryable } from '@/db/pool';
import { forbiddenUninstallTargets, scrubHomeLayout, scrubRoleGrants } from './uninstall-lib';
import { sqlTableTargets } from './sql-tables';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(ROOT, 'package.json'));

const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const YES = process.argv.includes('--yes');
const PKG = positional[0];
if (!PKG) {
    console.error('Usage: npx tsx scripts/uninstall-feature.ts <package> [--yes]');
    process.exit(2);
}

function fail(message: string): never {
    console.error(`uninstall-feature: ${message}`);
    process.exit(1);
}

/** Le dossier du module : node_modules, ou le `path` d'une des deux configs. */
function resolveModuleDir(pkg: string): string {
    for (const file of ['features.local.json', 'features.config.json']) {
        const full = path.join(ROOT, file);
        if (!fs.existsSync(full)) continue;
        const entries =
            (JSON.parse(fs.readFileSync(full, 'utf8')) as { features?: { package: string; path?: string }[] })
                .features ?? [];
        const entry = entries.find((e) => e.package === pkg);
        if (entry?.path) return path.resolve(ROOT, entry.path);
    }
    try {
        return path.dirname(require.resolve(`${pkg}/package.json`));
    } catch {
        fail(`« ${pkg} » introuvable : ni dans les configs (par chemin), ni dans node_modules`);
    }
}

async function main(): Promise<void> {
    const dir = resolveModuleDir(PKG);
    const metaPath = path.join(dir, 'deveye-feature.json');
    if (!fs.existsSync(metaPath)) fail(`${PKG}: deveye-feature.json manquant (${dir})`);
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as { id?: string };
    const id = meta.id;
    if (!id) fail(`${PKG}: deveye-feature.json sans « id »`);

    // Le SQL de démontage du module, s'il a des tables à lui. Vérifié AVANT de
    // toucher quoi que ce soit : hors préfixe, on refuse tout.
    const uninstallPath = path.join(dir, 'src', 'server', 'uninstall.sql');
    const uninstallSql = fs.existsSync(uninstallPath) ? fs.readFileSync(uninstallPath, 'utf8') : null;
    if (uninstallSql) {
        const outlaw = forbiddenUninstallTargets(id, uninstallSql);
        if (outlaw.length > 0) {
            fail(`${PKG}: uninstall.sql touche ${outlaw.join(', ')} — hors du préfixe ft_${id.replace(/^x-/, '')}_`);
        }
    }

    const pool = createDbPool();
    if (!(await testConnection(pool))) fail('connexion à la base impossible (tunnel ouvert ? variables DB_* ?)');
    const q: Queryable = getQueryable(pool);

    const count = async (sql: string, params: unknown[]): Promise<number> => {
        const r = await q.query<{ n: number }>(sql, params);
        return Number(r.rows[0]?.n ?? 0);
    };

    console.log(`Désinstallation de « ${id} » (${PKG}) — ${YES ? 'EXÉCUTION' : 'dry-run, rien ne sera écrit'}\n`);

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
        for (const statement of uninstallSql
            .split(';')
            .map((s) => s.trim())
            .filter((s) => s.length > 0 && !s.startsWith('--'))) {
            await q.query(statement, []);
        }
        console.log('\n✓ uninstall.sql exécuté');
    }
    for (const r of rows) {
        await q.query(`DELETE FROM ${r.table} WHERE feature = ?`, [id]);
    }
    console.log('✓ lignes par feature supprimées (kv, canaux, routes, partages, restrictions)');
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
        `\nTerminé. Reste à faire : retirer « ${PKG} » de features.config.json / features.local.json,` +
            `\nnpm uninstall si besoin, puis npm run gen:features.`
    );
    await pool.end();
}

void main();

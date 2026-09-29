import {
    accountExportProblem,
    EXPORT_SECRET_COLUMN,
    type FeatureAccountExport,
    type SdkQueryable
} from '@deveye/types/sdk/server';

/**
 * Le sort des tables du cœur dans l'export d'un compte : écrites par l'hôte
 * (le compte, ses espaces), ou tues avec leur raison. Toute table du schéma a
 * un sort, ici ou dans la déclaration d'un module.
 */
export const CORE_EXPORT_TABLES: Readonly<Record<string, 'host' | { skip: string }>> = {
    users: 'host',
    workspaces: 'host',
    workspace_members: 'host',
    workspace_roles: 'host',
    feature_kv: 'host',
    feature_domains: 'host',
    notification_channels: 'host',
    logs: 'host',
    feedback: 'host',
    remote_instances: 'host',
    refresh_tokens: 'host',
    notification_routes: { skip: 'Les routes de notification visent des éléments par leur numéro interne.' },
    notification_route_channels: { skip: 'Les routes de notification visent des éléments par leur numéro interne.' },
    item_shares: { skip: 'Le partage d’un élément entre espaces n’a de sens que sur ce serveur.' },
    item_role_grants: { skip: 'Les droits d’un rôle sur un élément n’ont de sens que sur ce serveur.' },
    user_2fa: { skip: 'Le secret de la double authentification ne sort jamais.' },
    user_2fa_backup_codes: { skip: 'Les codes de secours ne sortent jamais.' },
    user_secret_keys: { skip: 'Les clés de chiffrement ne sortent jamais.' },
    workspace_secret_keys: { skip: 'Les clés de chiffrement ne sortent jamais.' },
    quota_pauses: { skip: 'L’état des pauses de l’offre appartient au service.' },
    quota_rechecks: { skip: 'L’état des pauses de l’offre appartient au service.' },
    pending_signups: { skip: 'Une inscription en attente n’est pas encore un compte.' },
    site_maintenance: { skip: 'Un réglage du serveur, pas du compte.' },
    feature_maintenance: { skip: 'Un réglage du serveur, pas du compte.' },
    instance_settings: { skip: 'Un réglage du serveur, pas du compte.' },
    debug_runs: { skip: 'Les essais de la page Tests et débogage appartiennent au serveur.' },
    _migrations: { skip: 'Le registre des migrations appartient au serveur.' }
};

/**
 * Les tables que les migrations du socle créent pour un module qui n'est pas
 * dans ce dépôt : elles existent sur toute base, module installé ou non. Le
 * module, installé, déclare leur sort ; absent, elles dorment sans données et
 * ne manquent pas de sort.
 */
export const DORMANT_MODULE_TABLES: Readonly<Record<string, readonly string[]>> = {
    // Migrations 031, 032, 052, 081 à 083, 111 et 131.
    cloudsync: [
        'sync_meta',
        'sync_shares',
        'sync_share_devices',
        'sync_exclusions',
        'sync_files',
        'sync_device_files',
        'sync_versions',
        'sync_sessions',
        'sync_events',
        'sync_snapshots',
        'sync_snapshot_files'
    ]
};

export interface CoverageModule {
    id: string;
    entry: FeatureAccountExport<unknown> | undefined;
}

export interface CoverageReport {
    /** Des déclarations fausses : une table ou une colonne qui n'existe pas, un secret qui sortirait. */
    faults: string[];
    /** Des tables sans sort : celles d'un module qui ne déclare pas encore, ou d'un module désinstallé. */
    uncovered: string[];
}

/**
 * Chaque table du schéma a-t-elle un sort, et un seul ? Chaque déclaration
 * tient-elle devant les colonnes réelles : toute colonne `*_enc` ouverte ou
 * tue, toute colonne à allure de secret tue sauf `keep` explicite ?
 */
export async function exportCoverage(q: SdkQueryable, modules: readonly CoverageModule[]): Promise<CoverageReport> {
    const rows = await q.query<{ t: string; c: string }>(
        'SELECT TABLE_NAME AS t, COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()'
    );
    const columns = new Map<string, Set<string>>();
    for (const row of rows) {
        const set = columns.get(row.t) ?? new Set<string>();
        set.add(row.c);
        columns.set(row.t, set);
    }
    const faults: string[] = [];
    const owner = new Map<string, string>(Object.keys(CORE_EXPORT_TABLES).map((t) => [t, 'cœur']));
    for (const mod of modules) {
        if (!mod.entry) continue;
        const problem = accountExportProblem(mod.entry);
        if (problem) faults.push(`${mod.id} : ${problem}`);
        for (const [table, fate] of Object.entries(mod.entry.tables)) {
            const known = columns.get(table);
            if (!known) {
                faults.push(`${mod.id} : table « ${table} » absente du schéma`);
                continue;
            }
            const previous = owner.get(table);
            if (previous) faults.push(`${mod.id} : table « ${table} » déjà déclarée par ${previous}`);
            owner.set(table, mod.id);
            if (typeof fate !== 'object' || 'skip' in fate) continue;
            const named = [
                ...fate.key,
                ...(fate.sealed ?? []),
                ...(fate.json ?? []),
                ...Object.keys(fate.dates ?? {}),
                ...(fate.omit ?? []),
                ...(fate.keep ?? [])
            ];
            for (const column of named) {
                if (!known.has(column)) faults.push(`${mod.id} : colonne « ${table}.${column} » inconnue`);
            }
            const handled = new Set([...(fate.sealed ?? []), ...(fate.omit ?? [])]);
            const kept = new Set(fate.keep ?? []);
            for (const column of known) {
                if (column.endsWith('_enc') && !handled.has(column)) {
                    faults.push(`${mod.id} : « ${table}.${column} » est chiffrée, ni ouverte ni tue`);
                } else if (EXPORT_SECRET_COLUMN.test(column) && !handled.has(column) && !kept.has(column)) {
                    faults.push(`${mod.id} : « ${table}.${column} » ressemble à un secret, ni tue ni gardée`);
                }
            }
        }
    }
    const installed = new Set(modules.map((m) => m.id));
    const dormant = new Set(
        Object.entries(DORMANT_MODULE_TABLES)
            .filter(([id]) => !installed.has(id))
            .flatMap(([, tables]) => tables)
    );
    const uncovered = [...columns.keys()].filter((t) => !owner.has(t) && !dormant.has(t)).sort();
    return { faults, uncovered };
}

/**
 * Au boot, après les migrations. Une déclaration fausse arrête le serveur :
 * un secret sortirait, ou l'archive tairait une table sans le dire. Une table
 * sans sort n'est que rendue, pour le journal (celle d'un module désinstallé
 * sans son `uninstall.sql`) ; le smoke de la CI, lui, la refuse.
 */
export async function assertExportCoverage(q: SdkQueryable, modules: readonly CoverageModule[]): Promise<string[]> {
    const { faults, uncovered } = await exportCoverage(q, modules);
    if (faults.length > 0) {
        throw new Error(`Export des données, déclarations fausses :\n  ${faults.join('\n  ')}`);
    }
    return uncovered;
}

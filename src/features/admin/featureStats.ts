import {
    adminFeatureFactSchema,
    adminFeatureStats,
    homeLayoutSchema,
    placedFeatureIds,
    type AdminFeatureFact,
    type AdminFeatureStats
} from '@deveye/types';
import type { FeatureManifest } from '@deveye/types/sdk';
import type { Logger } from 'pino';

import type { Database } from '@/db';
import { moduleAdminFacts, moduleManifest, moduleOwnedTables, moduleQuotaCounters } from '../_sdk/register';
import { defineFeature, FeatureError, type FeatureDefinition } from '../_define';

/** Ces chiffres parcourent toute l'instance : un calcul sert quelques minutes, sauf demande expresse. */
const MEMO_MS = 5 * 60_000;

const memo = new Map<string, AdminFeatureStats>();
const running = new Map<string, Promise<AdminFeatureStats>>();

/** Les espaces dont l'accueil porte la fonctionnalité, dossiers compris. Une disposition illisible ne compte pas. */
async function workspacesWithTile(db: Database, featureId: string): Promise<number[]> {
    const rows = await db.workspaces.listHomeLayoutsNaming(featureId);
    return rows.flatMap((row) => {
        let raw: unknown;
        try {
            raw = JSON.parse(row.homeLayout);
        } catch {
            return [];
        }
        const layout = homeLayoutSchema.safeParse(raw);
        return layout.success && placedFeatureIds(layout.data).some((id) => id === featureId) ? [row.id] : [];
    });
}

/**
 * Les statistiques de MySQL sur les tables du module : des estimations, que
 * `information_schema` garde en cache. Les sommes se font ici : un `SUM` sur
 * ces colonnes rend un DECIMAL.
 */
async function storageOf(db: Database, tables: readonly string[]): Promise<AdminFeatureStats['storage']> {
    if (tables.length === 0) return { tables: 0, rows: 0, bytes: 0 };
    const r = await db.queryable.query<{
        table_rows: number | null;
        data_length: number | null;
        index_length: number | null;
    }>(
        `SELECT TABLE_ROWS AS table_rows, DATA_LENGTH AS data_length, INDEX_LENGTH AS index_length
         FROM information_schema.TABLES
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (?)`,
        [tables]
    );
    let rows = 0;
    let bytes = 0;
    for (const t of r.rows) {
        rows += Number(t.table_rows ?? 0);
        bytes += Number(t.data_length ?? 0) + Number(t.index_length ?? 0);
    }
    return { tables: r.rows.length, rows, bytes };
}

/** Le total de chaque quota mesurable, compté une fois sur tous les espaces. Un compteur en panne est tu. */
async function quotaTotals(db: Database, featureId: string, logger: Logger): Promise<AdminFeatureFact[]> {
    const counters = moduleQuotaCounters(featureId, db);
    if (counters.length === 0) return [];
    const workspaceIds = await db.workspaces.listIds();
    const totals: AdminFeatureFact[] = [];
    for (const counter of counters) {
        try {
            const value = workspaceIds.length === 0 ? 0 : await counter.count(workspaceIds);
            totals.push({ label: counter.label, unit: counter.unit, value });
        } catch (err) {
            logger.error({ err, module: featureId, quota: counter.label }, 'Total d’un quota illisible');
        }
    }
    return totals;
}

/** Les chiffres propres du module : `null` s'il échoue ou répond hors contrat, vide s'il n'en déclare pas. */
async function moduleFacts(db: Database, featureId: string, logger: Logger): Promise<AdminFeatureFact[] | null> {
    const entry = moduleAdminFacts(db).find((e) => e.featureId === featureId);
    if (!entry) return [];
    try {
        const parsed = adminFeatureFactSchema.array().safeParse(await entry.read());
        if (parsed.success) return parsed.data;
        logger.error({ module: featureId, err: parsed.error.message }, 'Chiffres d’administration mal formés');
    } catch (err) {
        logger.error({ err, module: featureId }, 'Chiffres d’administration en échec');
    }
    return null;
}

async function compute(db: Database, manifest: FeatureManifest, logger: Logger): Promise<AdminFeatureStats> {
    const reach = async (): Promise<{ workspaces: number | null; accounts: number | null }> => {
        // Un module du seul menu du compte n'a pas de tuile à compter.
        if (manifest.accountOnly) return { workspaces: null, accounts: null };
        const ids = await workspacesWithTile(db, manifest.id);
        return { workspaces: ids.length, accounts: await db.workspaceMembers.countUsersIn(ids) };
    };
    const [{ workspaces, accounts }, storage, quotas, facts] = await Promise.all([
        reach(),
        storageOf(db, moduleOwnedTables(manifest.id)),
        quotaTotals(db, manifest.id, logger),
        moduleFacts(db, manifest.id, logger)
    ]);
    return { workspaces, accounts, storage, quotas, facts, computedAt: Date.now() };
}

export const adminFeatureStatsFeature: FeatureDefinition<
    typeof adminFeatureStats.command,
    typeof adminFeatureStats.input,
    typeof adminFeatureStats.output
> = defineFeature({
    ...adminFeatureStats,
    access: { admin: true, scope: 'account' },
    handler: async (ctx, input) => {
        const manifest = moduleManifest(input.featureId);
        if (!manifest) throw new FeatureError('not_found', 'Cette fonctionnalité n’est pas installée');
        const hit = memo.get(manifest.id);
        if (!input.refresh && hit && Date.now() - hit.computedAt < MEMO_MS) return hit;
        let run = running.get(manifest.id);
        if (!run) {
            run = compute(ctx.db, manifest, ctx.logger).finally(() => running.delete(manifest.id));
            running.set(manifest.id, run);
        }
        const stats = await run;
        memo.set(manifest.id, stats);
        return stats;
    }
});

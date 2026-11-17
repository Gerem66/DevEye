import { randomUUID } from 'crypto';
import { databaseKpiRemove, databaseKpiSave } from '../contracts/commands';
import { DATABASE_KPI_MAX, databaseKpiSchema } from '../contracts/domain';
import { defineSdkFeature, FeatureError } from '@deveye/types/sdk/server';

import { withSession } from './probe';
import { measure, type ConditionOutcome } from './rules';
import { keepKpiValues, loadDatabase, readJson, type Ctx, type StoredKpi, type StoredKpiValues } from './_shared';

/**
 * Les indicateurs d'une base : écrits ici, mesurés à l'enregistrement puis par
 * le relevé (`service.ts`). Domicile seulement, comme les alertes : une
 * définition posée d'une fenêtre serait scellée sous la clé d'ici, que le
 * relevé du domicile ne lit pas.
 */

async function loadHome(ctx: Ctx, databaseId: number) {
    const row = await loadDatabase(ctx, databaseId);
    if (row.workspace_id !== ctx.workspaceId) {
        throw new FeatureError(
            'forbidden',
            'Cette base appartient à un autre espace : ses indicateurs se règlent depuis là-bas.'
        );
    }
    return row;
}

export const databaseKpiFeatures = [
    defineSdkFeature({
        ...databaseKpiSave,
        access: { level: 'write', item: 'databaseId' },
        mutates: true,
        handler: async (ctx: Ctx, input) => {
            const row = await loadHome(ctx, input.databaseId);
            const cipher = ctx.cipher();
            const kpis = (await readJson<StoredKpi[]>(cipher, row.kpis)) ?? [];
            const index = input.kpiId === undefined ? -1 : kpis.findIndex((k) => k.id === input.kpiId);
            if (input.kpiId !== undefined && index === -1)
                throw new FeatureError('not_found', 'Indicateur introuvable');
            if (index === -1 && kpis.length >= DATABASE_KPI_MAX) {
                throw new FeatureError('validation', `Une base porte ${DATABASE_KPI_MAX} indicateurs au plus.`);
            }

            const kpi: StoredKpi = {
                id: input.kpiId ?? randomUUID(),
                label: input.label.trim(),
                sql: input.sql.trim(),
                unit: input.unit.trim()
            };
            if (kpi.label === '' || kpi.sql === '') {
                throw new FeatureError('validation', 'Un indicateur a besoin d’un nom et d’une requête.');
            }
            const next = index === -1 ? [...kpis, kpi] : kpis.map((k, i) => (i === index ? kpi : k));
            await ctx.repo.saveKpis(row.id, ctx.workspaceId, await cipher.encrypt(JSON.stringify(next)));

            // Mesuré tout de suite : une tuile ne naît pas vide. Une base
            // injoignable n'empêche pas l'enregistrement, la tuile dira pourquoi.
            let outcome: ConditionOutcome;
            try {
                outcome = await withSession(ctx, row.id, (s) => measure(s, kpi.sql));
            } catch (e) {
                outcome = { value: null, error: e instanceof Error ? e.message : String(e) };
            }
            const at = Math.floor(Date.now() / 1000);
            const values = (await readJson<StoredKpiValues>(cipher, row.kpi_values)) ?? {};
            values[kpi.id] = { sql: kpi.sql, value: outcome.value, error: outcome.error, at };
            await ctx.repo.recordKpiValues(row.id, await cipher.encrypt(JSON.stringify(keepKpiValues(next, values))));
            return { kpi: databaseKpiSchema.parse({ ...kpi, ...outcome, measuredAt: at }) };
        }
    }),
    defineSdkFeature({
        ...databaseKpiRemove,
        access: { level: 'write', item: 'databaseId' },
        mutates: true,
        handler: async (ctx: Ctx, input) => {
            const row = await loadHome(ctx, input.databaseId);
            const cipher = ctx.cipher();
            const kpis = (await readJson<StoredKpi[]>(cipher, row.kpis)) ?? [];
            const next = kpis.filter((k) => k.id !== input.kpiId);
            if (next.length === kpis.length) throw new FeatureError('not_found', 'Indicateur introuvable');
            await ctx.repo.saveKpis(
                row.id,
                ctx.workspaceId,
                next.length > 0 ? await cipher.encrypt(JSON.stringify(next)) : null
            );
            return { kpiId: input.kpiId };
        }
    })
];

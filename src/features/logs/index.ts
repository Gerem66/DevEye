import { LOGS_PAGE_DEFAULT, logsFacets, logsList } from 'deveye-types';

import { defineFeature, FeatureError, type FeatureContext, type FeatureDefinition } from '../_define';
import type { LogQueryFilter } from '@/db/repos/logs';

/**
 * The logs are a cross-account, system-wide audit trail, so they are strictly
 * admin-only — a regular user must never see another user's activity. Throws
 * `forbidden` for anyone who isn't an admin.
 */
async function assertAdmin(ctx: FeatureContext): Promise<void> {
    const user = await ctx.db.users.findById(ctx.userId);
    if (!user || user.role !== 'admin') {
        throw new FeatureError('forbidden', 'Réservé aux administrateurs');
    }
}

export const logsListFeature: FeatureDefinition<
    typeof logsList.command,
    typeof logsList.input,
    typeof logsList.output
> = defineFeature({
    ...logsList,
    handler: async (ctx, input) => {
        await assertAdmin(ctx);

        const { limit, offset, ...rest } = input;
        // Only forward the fields that are actually set, so an absent filter
        // never narrows the query (and `exactOptionalPropertyTypes` is happy).
        const filter: LogQueryFilter = {};
        if (rest.uid !== undefined) filter.uid = rest.uid;
        if (rest.source !== undefined) filter.source = rest.source;
        if (rest.category !== undefined) filter.category = rest.category;
        if (rest.action !== undefined) filter.action = rest.action;
        if (rest.levelMin !== undefined) filter.levelMin = rest.levelMin;
        if (rest.search !== undefined) filter.search = rest.search.trim();
        if (rest.ip !== undefined) filter.ip = rest.ip;
        if (rest.dateFrom !== undefined) filter.dateFrom = rest.dateFrom;
        if (rest.dateTo !== undefined) filter.dateTo = rest.dateTo;

        const pageSize = limit ?? LOGS_PAGE_DEFAULT;
        const start = offset ?? 0;
        const { logs, total } = await ctx.db.logs.query(filter, { limit: pageSize, offset: start });

        return { logs, total, hasMore: start + logs.length < total };
    }
});

export const logsFacetsFeature: FeatureDefinition<
    typeof logsFacets.command,
    typeof logsFacets.input,
    typeof logsFacets.output
> = defineFeature({
    ...logsFacets,
    handler: async (ctx) => {
        await assertAdmin(ctx);
        return ctx.db.logs.facets();
    }
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const logsFeatures: FeatureDefinition<string, any, any>[] = [logsListFeature, logsFacetsFeature];

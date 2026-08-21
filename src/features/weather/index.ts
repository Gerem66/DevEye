import {
    weatherAdd,
    weatherGet,
    weatherKeyList,
    weatherList,
    weatherProviderSchema,
    weatherRemove,
    weatherReorder,
    weatherSetKey,
    weatherSetPrimary,
    weatherUpdate,
    type WeatherLocation,
    type WeatherLocationRow
} from 'deveye-types';

import { fetchWeatherReport, getWeatherAdapter, WeatherError } from '@/Services/WeatherProvider';
import { defineFeature, FeatureError, type FeatureContext, type FeatureDefinition } from '../_define';

function toLocation(row: WeatherLocationRow): WeatherLocation {
    return {
        id: row.id,
        label: row.label,
        latitude: row.latitude,
        longitude: row.longitude,
        format: row.format,
        days: row.days,
        provider: row.provider,
        position: row.position,
        isPrimary: row.is_primary === 1,
        hasApiKey: row.api_key_enc != null && row.api_key_enc.length > 0
    };
}

/**
 * Decrypt the API key to use for a location: its own per-city key if set,
 * otherwise the legacy per-account key for the provider, if any.
 */
async function resolveLocationKey(ctx: FeatureContext, row: WeatherLocationRow): Promise<string | null> {
    if (row.api_key_enc) return ctx.crypt.Decrypt(row.api_key_enc);
    const accountKey = await ctx.db.weather.getKey(ctx.workspaceId, row.provider);
    return accountKey ? ctx.crypt.Decrypt(accountKey.key_enc) : null;
}

function mapWeatherError(e: unknown): FeatureError {
    if (e instanceof WeatherError) {
        const code = e.reason === 'not_found' ? 'not_found' : 'internal';
        return new FeatureError(code, e.message);
    }
    return new FeatureError('internal', 'Weather provider error');
}

export const weatherListFeature: FeatureDefinition<
    typeof weatherList.command,
    typeof weatherList.input,
    typeof weatherList.output
> = defineFeature({
    ...weatherList,
    access: { feature: 'weather', level: 'read' },
    handler: async (ctx) => {
        const rows = await ctx.db.weather.listLocations(ctx.workspaceId);
        return { locations: rows.map(toLocation) };
    }
});

export const weatherAddFeature: FeatureDefinition<
    typeof weatherAdd.command,
    typeof weatherAdd.input,
    typeof weatherAdd.output
> = defineFeature({
    ...weatherAdd,
    access: { feature: 'weather', level: 'write' },
    mutates: true,
    handler: async (ctx, input) => {
        const apiKey = input.apiKey?.trim() || null;
        let geo;
        try {
            geo = await getWeatherAdapter(input.provider).geocode(input.query, apiKey);
        } catch (e) {
            throw mapWeatherError(e);
        }
        const row = await ctx.db.weather.createLocation({
            userId: ctx.userId,
            workspaceId: ctx.workspaceId,
            label: geo.label,
            latitude: geo.latitude,
            longitude: geo.longitude,
            format: input.format,
            days: input.days,
            provider: input.provider,
            apiKeyEnc: apiKey ? ctx.crypt.Encrypt(apiKey) : null
        });
        ctx.audit({
            action: 'weather.add',
            description: `Ville météo ajoutée : « ${row.label} »`,
            metadata: { locationId: row.id, provider: row.provider }
        });
        return { location: toLocation(row) };
    }
});

export const weatherUpdateFeature: FeatureDefinition<
    typeof weatherUpdate.command,
    typeof weatherUpdate.input,
    typeof weatherUpdate.output
> = defineFeature({
    ...weatherUpdate,
    access: { feature: 'weather', level: 'write' },
    mutates: true,
    handler: async (ctx, input) => {
        // apiKey: undefined = leave; "" = clear; non-empty = encrypt + store.
        let apiKeyEnc: string | null | undefined;
        if (input.apiKey !== undefined) {
            const trimmed = input.apiKey.trim();
            apiKeyEnc = trimmed ? ctx.crypt.Encrypt(trimmed) : null;
        }
        const row = await ctx.db.weather.updateLocation(input.id, ctx.workspaceId, {
            format: input.format,
            days: input.days,
            position: input.position,
            provider: input.provider,
            apiKeyEnc
        });
        if (!row) throw new FeatureError('not_found', 'Weather location not found');
        ctx.audit({
            action: 'weather.update',
            description: `Ville météo modifiée : « ${row.label} »`,
            metadata: { locationId: row.id, apiKeyChanged: input.apiKey !== undefined }
        });
        return { location: toLocation(row) };
    }
});

export const weatherRemoveFeature: FeatureDefinition<
    typeof weatherRemove.command,
    typeof weatherRemove.input,
    typeof weatherRemove.output
> = defineFeature({
    ...weatherRemove,
    access: { feature: 'weather', level: 'write' },
    mutates: true,
    handler: async (ctx, input) => {
        const deleted = await ctx.db.weather.deleteLocation(input.id, ctx.workspaceId);
        if (!deleted) throw new FeatureError('not_found', 'Weather location not found');
        ctx.audit({
            action: 'weather.remove',
            level: 'info',
            description: 'Ville météo supprimée',
            metadata: { locationId: input.id }
        });
        return { id: input.id };
    }
});

export const weatherReorderFeature: FeatureDefinition<
    typeof weatherReorder.command,
    typeof weatherReorder.input,
    typeof weatherReorder.output
> = defineFeature({
    ...weatherReorder,
    access: { feature: 'weather', level: 'write' },
    mutates: true,
    handler: async (ctx, input) => {
        const rows = await ctx.db.weather.reorderLocations(ctx.workspaceId, input.ids);
        return { locations: rows.map(toLocation) };
    }
});

export const weatherSetPrimaryFeature: FeatureDefinition<
    typeof weatherSetPrimary.command,
    typeof weatherSetPrimary.input,
    typeof weatherSetPrimary.output
> = defineFeature({
    ...weatherSetPrimary,
    access: { feature: 'weather', level: 'write' },
    mutates: true,
    handler: async (ctx, input) => {
        const target = await ctx.db.weather.findLocation(input.id, ctx.workspaceId);
        if (!target) throw new FeatureError('not_found', 'Weather location not found');
        const rows = await ctx.db.weather.setPrimaryLocation(ctx.workspaceId, input.id);
        return { locations: rows.map(toLocation) };
    }
});

export const weatherGetFeature: FeatureDefinition<
    typeof weatherGet.command,
    typeof weatherGet.input,
    typeof weatherGet.output
> = defineFeature({
    ...weatherGet,
    access: { feature: 'weather', level: 'read' },
    handler: async (ctx, input) => {
        const row = await ctx.db.weather.findLocation(input.id, ctx.workspaceId);
        if (!row) throw new FeatureError('not_found', 'Weather location not found');
        const apiKey = await resolveLocationKey(ctx, row);
        try {
            const report = await fetchWeatherReport({
                locationId: row.id,
                label: row.label,
                latitude: row.latitude,
                longitude: row.longitude,
                format: row.format,
                days: row.days,
                provider: row.provider,
                apiKey
            });
            return { report };
        } catch (e) {
            throw mapWeatherError(e);
        }
    }
});

export const weatherKeyListFeature: FeatureDefinition<
    typeof weatherKeyList.command,
    typeof weatherKeyList.input,
    typeof weatherKeyList.output
> = defineFeature({
    ...weatherKeyList,
    access: { feature: 'weather', level: 'read' },
    handler: async (ctx) => {
        // Le fait, jamais le secret : la clé elle-même ne quitte pas la base.
        const held = new Set(await ctx.db.weather.listKeyProviders(ctx.workspaceId));
        return {
            providers: weatherProviderSchema.options.map((provider) => ({
                provider,
                hasKey: held.has(provider)
            }))
        };
    }
});

export const weatherSetKeyFeature: FeatureDefinition<
    typeof weatherSetKey.command,
    typeof weatherSetKey.input,
    typeof weatherSetKey.output
> = defineFeature({
    ...weatherSetKey,
    access: { feature: 'weather', level: 'write' },
    mutates: true,
    handler: async (ctx, input) => {
        const key = input.key.trim();
        if (key.length === 0) {
            await ctx.db.weather.deleteKey(ctx.workspaceId, input.provider);
            ctx.audit({
                action: 'weather.setKey',
                description: `Clé API météo supprimée (${input.provider})`,
                metadata: { provider: input.provider, hasKey: false }
            });
            return { provider: input.provider, hasKey: false };
        }
        await ctx.db.weather.setKey(ctx.workspaceId, input.provider, ctx.crypt.Encrypt(key));
        ctx.audit({
            action: 'weather.setKey',
            description: `Clé API météo enregistrée (${input.provider})`,
            metadata: { provider: input.provider, hasKey: true }
        });
        return { provider: input.provider, hasKey: true };
    }
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const weatherFeatures: FeatureDefinition<string, any, any>[] = [
    weatherListFeature,
    weatherAddFeature,
    weatherUpdateFeature,
    weatherRemoveFeature,
    weatherReorderFeature,
    weatherSetPrimaryFeature,
    weatherGetFeature,
    weatherKeyListFeature,
    weatherSetKeyFeature
];

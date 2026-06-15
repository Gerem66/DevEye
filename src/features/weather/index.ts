import {
    weatherAdd,
    weatherGet,
    weatherList,
    weatherRemove,
    weatherSetKey,
    weatherUpdate,
    type WeatherLocation,
    type WeatherLocationRow,
    type WeatherProvider
} from 'deveye-types';

import { getWeatherAdapter, WeatherError } from '@/Services/WeatherProvider';
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
        position: row.position
    };
}

/** Decrypt the per-account API key for a provider, if one is configured. */
async function resolveKey(ctx: FeatureContext, provider: WeatherProvider): Promise<string | null> {
    const row = await ctx.db.weather.getKey(ctx.userId, provider);
    if (!row) return null;
    return ctx.crypt.Decrypt(row.key_enc);
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
    handler: async (ctx) => {
        const rows = await ctx.db.weather.listLocations(ctx.userId);
        return { locations: rows.map(toLocation) };
    }
});

export const weatherAddFeature: FeatureDefinition<
    typeof weatherAdd.command,
    typeof weatherAdd.input,
    typeof weatherAdd.output
> = defineFeature({
    ...weatherAdd,
    handler: async (ctx, input) => {
        const apiKey = await resolveKey(ctx, input.provider);
        let geo;
        try {
            geo = await getWeatherAdapter(input.provider).geocode(input.query, apiKey);
        } catch (e) {
            throw mapWeatherError(e);
        }
        const row = await ctx.db.weather.createLocation({
            userId: ctx.userId,
            label: geo.label,
            latitude: geo.latitude,
            longitude: geo.longitude,
            format: input.format,
            days: input.days,
            provider: input.provider
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
    handler: async (ctx, input) => {
        const row = await ctx.db.weather.updateLocation(input.id, ctx.userId, {
            format: input.format,
            days: input.days,
            position: input.position
        });
        if (!row) throw new FeatureError('not_found', 'Weather location not found');
        return { location: toLocation(row) };
    }
});

export const weatherRemoveFeature: FeatureDefinition<
    typeof weatherRemove.command,
    typeof weatherRemove.input,
    typeof weatherRemove.output
> = defineFeature({
    ...weatherRemove,
    handler: async (ctx, input) => {
        const deleted = await ctx.db.weather.deleteLocation(input.id, ctx.userId);
        if (!deleted) throw new FeatureError('not_found', 'Weather location not found');
        return { id: input.id };
    }
});

export const weatherGetFeature: FeatureDefinition<
    typeof weatherGet.command,
    typeof weatherGet.input,
    typeof weatherGet.output
> = defineFeature({
    ...weatherGet,
    handler: async (ctx, input) => {
        const row = await ctx.db.weather.findLocation(input.id, ctx.userId);
        if (!row) throw new FeatureError('not_found', 'Weather location not found');
        const apiKey = await resolveKey(ctx, row.provider);
        try {
            const report = await getWeatherAdapter(row.provider).fetchReport({
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

export const weatherSetKeyFeature: FeatureDefinition<
    typeof weatherSetKey.command,
    typeof weatherSetKey.input,
    typeof weatherSetKey.output
> = defineFeature({
    ...weatherSetKey,
    handler: async (ctx, input) => {
        const key = input.key.trim();
        if (key.length === 0) {
            await ctx.db.weather.deleteKey(ctx.userId, input.provider);
            return { provider: input.provider, hasKey: false };
        }
        await ctx.db.weather.setKey(ctx.userId, input.provider, ctx.crypt.Encrypt(key));
        return { provider: input.provider, hasKey: true };
    }
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const weatherFeatures: FeatureDefinition<string, any, any>[] = [
    weatherListFeature,
    weatherAddFeature,
    weatherUpdateFeature,
    weatherRemoveFeature,
    weatherGetFeature,
    weatherSetKeyFeature
];

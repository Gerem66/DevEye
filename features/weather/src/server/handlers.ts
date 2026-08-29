import {
    weatherAdd,
    weatherGet,
    weatherKeyList,
    weatherList,
    weatherRemove,
    weatherReorder,
    weatherSetKey,
    weatherSetPrimary,
    weatherUpdate
} from '../contracts/commands';
import { weatherProviderSchema, type WeatherLocation, type WeatherLocationRow } from '../contracts/domain';
import { defineSdkFeature, FeatureError, type SdkFeatureContext } from '@deveye/types/sdk/server';

import { fetchWeatherReport, getWeatherAdapter, WeatherError } from './provider';
import type { WeatherRepo } from './repo';

type Ctx = SdkFeatureContext<WeatherRepo>;

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
 * The API key to use for a location: its own per-city key if set, otherwise
 * the workspace key for the provider. `tryDecrypt`: an unreadable key reads as
 * "no key", never an error.
 */
async function resolveLocationKey(ctx: Ctx, row: WeatherLocationRow): Promise<string | null> {
    const cipher = ctx.cipher();
    if (row.api_key_enc) return cipher.tryDecrypt(row.api_key_enc);
    const accountKey = await ctx.repo.getKey(ctx.workspaceId, row.provider);
    return accountKey ? cipher.tryDecrypt(accountKey.key_enc) : null;
}

function mapWeatherError(e: unknown): FeatureError {
    if (e instanceof WeatherError) {
        const code = e.reason === 'not_found' ? 'not_found' : 'internal';
        return new FeatureError(code, e.message);
    }
    return new FeatureError('internal', 'Weather provider error');
}

export const weatherHandlers = [
    defineSdkFeature({
        ...weatherList,
        handler: async (ctx: Ctx) => {
            const rows = await ctx.repo.listLocations(ctx.workspaceId);
            return { locations: rows.map(toLocation) };
        }
    }),
    defineSdkFeature({
        ...weatherAdd,
        access: { level: 'write' },
        mutates: true,
        handler: async (ctx: Ctx, input) => {
            const apiKey = input.apiKey?.trim() || null;
            let geo;
            try {
                geo = await getWeatherAdapter(input.provider).geocode(input.query, apiKey);
            } catch (e) {
                throw mapWeatherError(e);
            }
            const row = await ctx.repo.createLocation({
                userId: ctx.userId,
                workspaceId: ctx.workspaceId,
                label: geo.label,
                latitude: geo.latitude,
                longitude: geo.longitude,
                format: input.format,
                days: input.days,
                provider: input.provider,
                apiKeyEnc: apiKey ? await ctx.cipher().encrypt(apiKey) : null
            });
            ctx.audit({
                action: 'weather.add',
                description: `Ville météo ajoutée : « ${row.label} »`,
                metadata: { locationId: row.id, provider: row.provider }
            });
            return { location: toLocation(row) };
        }
    }),
    defineSdkFeature({
        ...weatherUpdate,
        access: { level: 'write' },
        mutates: true,
        handler: async (ctx: Ctx, input) => {
            // apiKey: undefined = leave; "" = clear; non-empty = encrypt + store.
            let apiKeyEnc: string | null | undefined;
            if (input.apiKey !== undefined) {
                const trimmed = input.apiKey.trim();
                apiKeyEnc = trimmed ? await ctx.cipher().encrypt(trimmed) : null;
            }
            const row = await ctx.repo.updateLocation(input.id, ctx.workspaceId, {
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
    }),
    defineSdkFeature({
        ...weatherRemove,
        access: { level: 'write' },
        mutates: true,
        handler: async (ctx: Ctx, input) => {
            const deleted = await ctx.repo.deleteLocation(input.id, ctx.workspaceId);
            if (!deleted) throw new FeatureError('not_found', 'Weather location not found');
            ctx.audit({
                action: 'weather.remove',
                level: 'info',
                description: 'Ville météo supprimée',
                metadata: { locationId: input.id }
            });
            return { id: input.id };
        }
    }),
    defineSdkFeature({
        ...weatherReorder,
        access: { level: 'write' },
        mutates: true,
        handler: async (ctx: Ctx, input) => {
            const rows = await ctx.repo.reorderLocations(ctx.workspaceId, input.ids);
            return { locations: rows.map(toLocation) };
        }
    }),
    defineSdkFeature({
        ...weatherSetPrimary,
        access: { level: 'write' },
        mutates: true,
        handler: async (ctx: Ctx, input) => {
            const target = await ctx.repo.findLocation(input.id, ctx.workspaceId);
            if (!target) throw new FeatureError('not_found', 'Weather location not found');
            const rows = await ctx.repo.setPrimaryLocation(ctx.workspaceId, input.id);
            return { locations: rows.map(toLocation) };
        }
    }),
    defineSdkFeature({
        ...weatherGet,
        handler: async (ctx: Ctx, input) => {
            const row = await ctx.repo.findLocation(input.id, ctx.workspaceId);
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
    }),
    defineSdkFeature({
        ...weatherKeyList,
        handler: async (ctx: Ctx) => {
            // Le fait, jamais le secret : la clé elle-même ne quitte pas la base.
            const held = new Set(await ctx.repo.listKeyProviders(ctx.workspaceId));
            return {
                providers: weatherProviderSchema.options.map((provider) => ({
                    provider,
                    hasKey: held.has(provider)
                }))
            };
        }
    }),
    defineSdkFeature({
        ...weatherSetKey,
        // L'écriture ne suffit pas : le rôle doit confier la gestion des clés
        // (voir manifest).
        access: { level: 'write', extras: ['manageKeys'] },
        mutates: true,
        handler: async (ctx: Ctx, input) => {
            const key = input.key.trim();
            if (key.length === 0) {
                await ctx.repo.deleteKey(ctx.workspaceId, input.provider);
                ctx.audit({
                    action: 'weather.setKey',
                    description: `Clé API météo supprimée (${input.provider})`,
                    metadata: { provider: input.provider, hasKey: false }
                });
                return { provider: input.provider, hasKey: false };
            }
            await ctx.repo.setKey(ctx.workspaceId, input.provider, await ctx.cipher().encrypt(key));
            ctx.audit({
                action: 'weather.setKey',
                description: `Clé API météo enregistrée (${input.provider})`,
                metadata: { provider: input.provider, hasKey: true }
            });
            return { provider: input.provider, hasKey: true };
        }
    })
];

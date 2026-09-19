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
import {
    providerNeedsKey,
    weatherProviderSchema,
    type WeatherLocation,
    type WeatherLocationRow,
    type WeatherProvider
} from '../contracts/domain';
import { defineSdkFeature, FeatureError, type SdkFeatureContext } from '@deveye/types/sdk/server';

import { fetchWeatherReport, forgetProviderReports, getWeatherAdapter, WeatherError } from './provider';
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
        isPrimary: row.is_primary === 1
    };
}

/**
 * La clé de l'espace pour un fournisseur. `tryDecrypt` : une clé illisible vaut
 * « pas de clé », jamais une erreur.
 */
async function workspaceKey(ctx: Ctx, provider: WeatherProvider): Promise<string | null> {
    const row = await ctx.repo.getKey(ctx.workspaceId, provider);
    return row ? ctx.cipher().tryDecrypt(row.key_enc) : null;
}

/** Les fournisseurs dont l'espace peut se servir : les libres, et ceux dont il tient la clé. */
async function usableProviders(ctx: Ctx): Promise<WeatherProvider[]> {
    const held = new Set(await ctx.repo.listKeyProviders(ctx.workspaceId));
    return weatherProviderSchema.options.filter((p) => !providerNeedsKey(p) || held.has(p));
}

/** Une ville ne se règle jamais sur un fournisseur que l'espace ne peut pas appeler. */
async function assertUsable(ctx: Ctx, provider: WeatherProvider): Promise<void> {
    if (!(await usableProviders(ctx)).includes(provider)) {
        throw new FeatureError('validation', 'Ce fournisseur n’a pas de clé dans cet espace.');
    }
}

const LOCATION_NOT_FOUND = 'Cette ville n’existe plus.';

/** Ce que la fiche affiche, par raison d'échec d'un fournisseur. */
const FAILURE_TEXT: Record<WeatherError['reason'], string> = {
    not_found: 'Aucun lieu ne correspond à cette recherche.',
    unauthorized: 'Le fournisseur refuse la clé d’API de cet espace.',
    fetch_failed: 'Le fournisseur météo ne répond pas.'
};

/**
 * La raison voyage en `details` : le client y lit qu'une clé est refusée, seul
 * échec qui périme un relevé déjà affiché.
 */
function mapWeatherError(e: unknown): FeatureError {
    if (!(e instanceof WeatherError)) return new FeatureError('internal', FAILURE_TEXT.fetch_failed);
    const code = e.reason === 'not_found' ? 'not_found' : 'internal';
    return new FeatureError(code, FAILURE_TEXT[e.reason], { reason: e.reason });
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
            await assertUsable(ctx, input.provider);
            let geo;
            try {
                geo = await getWeatherAdapter(input.provider).geocode(
                    input.query,
                    await workspaceKey(ctx, input.provider)
                );
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
                provider: input.provider
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
            if (input.provider) await assertUsable(ctx, input.provider);
            const row = await ctx.repo.updateLocation(input.id, ctx.workspaceId, {
                format: input.format,
                days: input.days,
                position: input.position,
                provider: input.provider
            });
            if (!row) throw new FeatureError('not_found', LOCATION_NOT_FOUND);
            ctx.audit({
                action: 'weather.update',
                description: `Ville météo modifiée : « ${row.label} »`,
                metadata: { locationId: row.id, provider: row.provider }
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
            if (!deleted) throw new FeatureError('not_found', LOCATION_NOT_FOUND);
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
            if (!target) throw new FeatureError('not_found', LOCATION_NOT_FOUND);
            const rows = await ctx.repo.setPrimaryLocation(ctx.workspaceId, input.id);
            return { locations: rows.map(toLocation) };
        }
    }),
    defineSdkFeature({
        ...weatherGet,
        handler: async (ctx: Ctx, input) => {
            const row = await ctx.repo.findLocation(input.id, ctx.workspaceId);
            if (!row) throw new FeatureError('not_found', LOCATION_NOT_FOUND);
            const apiKey = await workspaceKey(ctx, row.provider);
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
            const hasKey = key.length > 0;
            let moved = 0;
            if (hasKey) {
                await ctx.repo.setKey(ctx.workspaceId, input.provider, await ctx.cipher().encrypt(key));
            } else {
                await ctx.repo.deleteKey(ctx.workspaceId, input.provider);
                // Les villes qui s'en servaient repassent sur le premier fournisseur
                // encore utilisable, plutôt que de rester muettes.
                const [fallback] = await usableProviders(ctx);
                if (fallback) moved = await ctx.repo.moveLocations(ctx.workspaceId, input.provider, fallback);
            }
            // Posée, changée ou retirée : les relevés obtenus avec l'ancienne clé
            // ne valent plus, et c'est après l'écriture qu'ils s'oublient.
            forgetProviderReports(input.provider);
            ctx.audit({
                action: 'weather.setKey',
                description: `Clé API météo ${hasKey ? 'enregistrée' : 'supprimée'} (${input.provider})`,
                metadata: { provider: input.provider, hasKey, movedLocations: moved }
            });
            return { provider: input.provider, hasKey };
        }
    })
];

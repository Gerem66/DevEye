import { defineSdkFeature, FeatureError, type SdkFeatureContext } from '@deveye/types/sdk/server';

import { cveFavorites, cveGet, cveKeyList, cveNews, cveSearch, cveSetFavorite, cveSetKey } from '../contracts/commands';
import { cveProviderSchema, type CveEntry, type CveSeverityFilter } from '../contracts/domain';
import { NVD_KEY_STORE_KEY, searchTerms, toEntry, upsertToEntry } from './_shared';
import { nvdClient, type NvdClient } from './nvd';
import type { CveRepo, CveUpsert } from './repo';

type Ctx = SdkFeatureContext<CveRepo>;

/**
 * Le client HTTP est un point d'injection : les tests tournent sur le harnais
 * en mémoire sans jamais sortir sur le réseau.
 */
let client: NvdClient = nvdClient;

export function setNvdClient(next: NvdClient): void {
    client = next;
}

/** La clé du NVD de CET espace, ou rien. Une clé illisible vaut pas de clé. */
async function apiKeyOf(ctx: Ctx): Promise<string | null> {
    const stored = await ctx.store.get(NVD_KEY_STORE_KEY);
    return stored && stored.length > 0 ? stored : null;
}

function matchesSeverity(entry: CveUpsert, severity: CveSeverityFilter): boolean {
    return severity === 'all' || entry.severity === severity;
}

/** Range ce que le fournisseur vient de rendre, sans faire échouer la lecture. */
async function cache(ctx: Ctx, entries: CveUpsert[]): Promise<void> {
    if (entries.length === 0) return;
    try {
        await ctx.repo.upsertMany(entries);
    } catch (e) {
        // Le resultat est deja la : ne pas le perdre parce que le cache a rate.
        ctx.logger.warn({ err: (e as Error).message }, 'Mise en cache des CVE échouée');
    }
}

export const cveHandlers = [
    defineSdkFeature({
        ...cveNews,
        handler: async (ctx: Ctx, input) => {
            const [rows, ingestedAt] = await Promise.all([
                ctx.repo.listNews(ctx.workspaceId, input.severity, input.limit),
                ctx.repo.getState('ingestedAt')
            ]);
            return { entries: rows.map(toEntry), ingestedAt };
        }
    }),
    defineSdkFeature({
        ...cveSearch,
        handler: async (ctx: Ctx, input) => {
            const terms = searchTerms(input.query);
            if (terms.length === 0) throw new FeatureError('validation', 'Requête vide.');

            const local = await ctx.repo.search(ctx.workspaceId, terms, input.severity, input.limit);
            const truncated = local.length > input.limit;
            const entries: CveEntry[] = local.slice(0, input.limit).map(toEntry);

            // Le catalogue local ne tient que ce qui est passe par ici : des qu'il
            // ne suffit pas, le NVD tranche, avec son corpus entier.
            if (truncated || entries.length >= input.limit) {
                return { entries, truncated, remote: false, remoteError: null };
            }

            const known = new Set(entries.map((e) => e.id));
            const favorites = new Set((await ctx.repo.listFavorites(ctx.workspaceId)).map((r) => r.cve_id));
            const apiKey = await apiKeyOf(ctx);
            const single = terms.length === 1 ? terms[0].toUpperCase() : null;

            try {
                const found = single?.startsWith('CVE-')
                    ? [await client.byId(single, apiKey)].filter((e): e is CveUpsert => e !== null)
                    : await client.keyword(input.query.trim(), apiKey, input.limit);
                await cache(ctx, found);
                for (const entry of found) {
                    if (entries.length >= input.limit) break;
                    if (known.has(entry.id) || !matchesSeverity(entry, input.severity)) continue;
                    known.add(entry.id);
                    entries.push(upsertToEntry(entry, favorites.has(entry.id)));
                }
                entries.sort((a, b) => b.published - a.published || (a.id < b.id ? 1 : -1));
                return { entries, truncated, remote: true, remoteError: null };
            } catch (e) {
                // Le local a peut-etre deja de quoi repondre : le rendre, en disant
                // que la moitie distante a manque.
                return { entries, truncated, remote: true, remoteError: (e as Error).message };
            }
        }
    }),
    defineSdkFeature({
        ...cveGet,
        handler: async (ctx: Ctx, input) => {
            const row = await ctx.repo.find(ctx.workspaceId, input.id);
            if (row) return { entry: toEntry(row) };

            const apiKey = await apiKeyOf(ctx);
            let found: CveUpsert | null;
            try {
                found = await client.byId(input.id, apiKey);
            } catch (e) {
                throw new FeatureError('internal', (e as Error).message);
            }
            if (!found) throw new FeatureError('not_found', `${input.id} est inconnue du NVD.`);
            await cache(ctx, [found]);
            return { entry: upsertToEntry(found, false) };
        }
    }),
    defineSdkFeature({
        ...cveFavorites,
        handler: async (ctx: Ctx) => {
            const rows = await ctx.repo.listFavorites(ctx.workspaceId);
            return { entries: rows.map(toEntry) };
        }
    }),
    defineSdkFeature({
        ...cveSetFavorite,
        access: { level: 'write' },
        mutates: true,
        handler: async (ctx: Ctx, input) => {
            if (input.favorite) {
                // Epingler une CVE que le catalogue ignore doit marcher : la liste
                // des epingles joint les entrees, une epingle orpheline n'y
                // paraitrait pas.
                const known = await ctx.repo.find(ctx.workspaceId, input.id);
                if (!known) {
                    const apiKey = await apiKeyOf(ctx);
                    let found: CveUpsert | null;
                    try {
                        found = await client.byId(input.id, apiKey);
                    } catch (e) {
                        throw new FeatureError('internal', (e as Error).message);
                    }
                    if (!found) throw new FeatureError('not_found', `${input.id} est inconnue du NVD.`);
                    await ctx.repo.upsertMany([found]);
                }
                await ctx.repo.addFavorite(ctx.workspaceId, input.id, ctx.userId, Math.floor(Date.now() / 1000));
            } else {
                await ctx.repo.removeFavorite(ctx.workspaceId, input.id);
            }

            ctx.audit({
                action: input.favorite ? 'cve.favorite' : 'cve.unfavorite',
                description: `${input.favorite ? 'CVE épinglée' : 'CVE retirée des épingles'} : ${input.id}`,
                metadata: { cveId: input.id }
            });

            const row = await ctx.repo.find(ctx.workspaceId, input.id);
            if (!row) throw new FeatureError('not_found', `${input.id} est inconnue du catalogue.`);
            return { entry: toEntry(row) };
        }
    }),
    defineSdkFeature({
        ...cveKeyList,
        handler: async (ctx: Ctx) => {
            // Le fait, jamais le secret : la clé elle-même ne quitte pas la base.
            const held = await apiKeyOf(ctx);
            return { keys: cveProviderSchema.options.map((provider) => ({ provider, hasKey: held !== null })) };
        }
    }),
    defineSdkFeature({
        ...cveSetKey,
        access: { level: 'write', extras: ['manageKeys'] },
        mutates: true,
        handler: async (ctx: Ctx, input) => {
            const key = input.key.trim();
            if (key.length === 0) await ctx.store.remove(NVD_KEY_STORE_KEY);
            // Chiffrement 'server' par defaut : le ticker, qui n'a pas de session,
            // ne sait relire que cet etage.
            else await ctx.store.put(NVD_KEY_STORE_KEY, key);

            ctx.audit({
                action: 'cve.setKey',
                description: `Clé d’API ${input.provider.toUpperCase()} ${key.length === 0 ? 'retirée' : 'enregistrée'}`,
                metadata: { provider: input.provider }
            });
            return { keys: cveProviderSchema.options.map((provider) => ({ provider, hasKey: key.length > 0 })) };
        }
    })
];

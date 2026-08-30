import {
    osintHistory,
    osintHistoryClear,
    osintHistoryRemove,
    osintKeyList,
    osintLookup,
    osintProbe,
    osintSetKey
} from '../contracts/commands';
import {
    detectTarget,
    OSINT_PROVIDER_META,
    osintProviderSchema,
    type OsintHistoryEntry,
    type OsintLookupRow,
    type OsintProvider
} from '../contracts/domain';
import { defineSdkFeature, FeatureError, type SdkFeatureContext } from '@deveye/types/sdk/server';

import { PROBES, probeAccepts, probesFor, readCache, runProbe, writeCache } from './probes';
import type { OsintRepo } from './repo';

type Ctx = SdkFeatureContext<OsintRepo>;

/**
 * `osint.lookup` ne sonde rien : il reconnaît la cible, journalise et rend la
 * liste des sondes ; le client tire un `osint.probe` par sonde. L'historique
 * s'écrit au niveau `read`, à dessein : chercher est l'usage de la feature.
 */

async function toHistoryEntry(ctx: Ctx, row: OsintLookupRow): Promise<OsintHistoryEntry> {
    return {
        id: row.id,
        kind: row.kind,
        // `null` plutôt qu'un jet : une entrée illisible (coffre re-scellé,
        // clé tournée) ne doit pas empêcher d'afficher le reste de la liste.
        query: await ctx.cipher('private').tryDecrypt(row.query_enc),
        createdAt: Number(row.created)
    };
}

/**
 * La cible, telle que le **serveur** la reconnaît.
 *
 * Le client envoie un `target` déjà formé pour éviter un aller-retour, mais on
 * ne le croit jamais : la nature est re-déduite de la requête d'origine par la
 * même fonction partagée. Sans ça, un appelant pourrait faire passer une IP
 * interne pour un « nom de personne » et contourner les gardes des sondes.
 */
function trustedTarget(query: string): ReturnType<typeof detectTarget> {
    const target = detectTarget(query);
    if (target.value.length === 0) {
        throw new FeatureError('validation', 'Requête vide.');
    }
    return target;
}

/**
 * La clé d'un fournisseur, déchiffrée, ou `null`. `tryDecrypt` : une clé
 * illisible vaut « pas de clé », jamais une erreur.
 */
async function providerKey(ctx: Ctx, provider: OsintProvider | undefined): Promise<string | null> {
    if (!provider) return null;
    const row = await ctx.repo.getKey(ctx.workspaceId, provider);
    return row ? ctx.cipher().tryDecrypt(row.key_enc) : null;
}

/**
 * Le total est fixe (le registre) ; seule une sonde qui exige une clé absente
 * compte comme indisponible. Une clé qui ne fait qu'enrichir ne change rien.
 */
function countProbeAvailability(held: ReadonlySet<OsintProvider>): { available: number; total: number } {
    const probes = Object.values(PROBES);
    const missingKey = probes.filter((probe) => probe.requiresKey && !(probe.provider && held.has(probe.provider)));
    return { available: probes.length - missingKey.length, total: probes.length };
}

export const osintHandlers = [
    defineSdkFeature({
        ...osintLookup,
        mutates: true,
        handler: async (ctx: Ctx, input) => {
            const target = trustedTarget(input.query);
            const probes = probesFor(target.kind);

            const row = await ctx.repo.createLookup({
                userId: ctx.userId,
                workspaceId: ctx.workspaceId,
                kind: target.kind,
                queryEnc: await ctx.cipher('private').encrypt(target.query)
            });

            // La requête elle-même n'entre pas dans le journal d'audit : c'est la
            // donnée que la table prend soin de chiffrer, l'écrire en clair ici la
            // trahirait. La nature de la cible suffit à tracer l'usage.
            ctx.audit({
                action: 'osint.lookup',
                description: `Recherche OSINT (${target.kind})`,
                metadata: { kind: target.kind, probes: probes.length }
            });

            return { target, probes, entry: await toHistoryEntry(ctx, row) };
        }
    }),
    defineSdkFeature({
        ...osintProbe,
        handler: async (ctx: Ctx, input) => {
            const target = trustedTarget(input.target.query);
            const adapter = PROBES[input.probe];

            // Deux gardes : la nature re-déduite doit correspondre à celle
            // annoncée (sinon le client a bâti sa cible à la main), et la sonde
            // doit accepter cette nature.
            if (target.kind !== input.target.kind || target.value !== input.target.value) {
                throw new FeatureError('validation', 'Cible incohérente avec la requête.');
            }
            if (!probeAccepts(input.probe, target.kind)) {
                throw new FeatureError('validation', `La sonde « ${input.probe} » ne s'applique pas à cette cible.`);
            }

            // La clé est lue avant le cache : ce qu'une sonde rend en dépend,
            // et un résultat d'avant sa pose n'a plus rien à voir avec elle.
            const key = await providerKey(ctx, adapter.provider);
            const cached = readCache(input.probe, target, Boolean(key));
            if (cached) return { result: cached };

            const result = await runProbe(adapter, { target, key });
            writeCache(input.probe, target, Boolean(key), result, adapter.ttlMs);

            return { result };
        }
    }),
    defineSdkFeature({
        ...osintHistory,
        handler: async (ctx: Ctx, input) => {
            const rows = await ctx.repo.listLookups(ctx.workspaceId, input.limit);
            return { entries: await Promise.all(rows.map((r) => toHistoryEntry(ctx, r))) };
        }
    }),
    defineSdkFeature({
        ...osintHistoryRemove,
        access: { level: 'write' },
        mutates: true,
        handler: async (ctx: Ctx, input) => {
            const deleted = await ctx.repo.deleteLookup(input.id, ctx.workspaceId);
            if (!deleted) throw new FeatureError('not_found', 'Entrée introuvable.');
            return { id: input.id };
        }
    }),
    defineSdkFeature({
        ...osintHistoryClear,
        access: { level: 'write' },
        mutates: true,
        handler: async (ctx: Ctx) => {
            const removed = await ctx.repo.clearLookups(ctx.workspaceId);
            ctx.audit({
                action: 'osint.historyClear',
                description: `Historique OSINT effacé (${removed} entrée(s))`,
                metadata: { removed }
            });
            return { removed };
        }
    }),
    defineSdkFeature({
        ...osintKeyList,
        handler: async (ctx: Ctx) => {
            const rows = await ctx.repo.listKeys(ctx.workspaceId);
            const held = new Set(rows.map((r) => r.provider));
            // Tous les fournisseurs sont rendus, posés ou non : l'écran doit
            // proposer ceux qui manquent. La clé elle-même ne sort jamais.
            const { available: probesAvailable, total: probesTotal } = countProbeAvailability(held);
            return {
                providers: osintProviderSchema.options.map((provider) => ({
                    provider,
                    hasKey: held.has(provider)
                })),
                probesAvailable,
                probesTotal
            };
        }
    }),
    defineSdkFeature({
        ...osintSetKey,
        access: { level: 'write' },
        mutates: true,
        handler: async (ctx: Ctx, input) => {
            const key = input.key.trim();
            if (key.length === 0) {
                await ctx.repo.deleteKey(ctx.workspaceId, input.provider);
                ctx.audit({
                    action: 'osint.setKey',
                    description: `Clé OSINT supprimée (${OSINT_PROVIDER_META[input.provider].label})`,
                    metadata: { provider: input.provider, hasKey: false }
                });
                return { provider: input.provider, hasKey: false };
            }
            await ctx.repo.setKey(ctx.workspaceId, input.provider, await ctx.cipher().encrypt(key));
            ctx.audit({
                action: 'osint.setKey',
                description: `Clé OSINT enregistrée (${OSINT_PROVIDER_META[input.provider].label})`,
                metadata: { provider: input.provider, hasKey: true }
            });
            return { provider: input.provider, hasKey: true };
        }
    })
];

import {
    detectTarget,
    OSINT_PROVIDER_META,
    osintHistory,
    osintHistoryClear,
    osintHistoryRemove,
    osintKeyList,
    osintLookup,
    osintProbe,
    osintSetKey,
    osintProviderSchema,
    type OsintHistoryEntry,
    type OsintLookupRow,
    type OsintProvider
} from 'deveye-types';

import { PROBES, probeAccepts, probesFor, readCache, runProbe, writeCache } from '@/Services/osint';
import { defineFeature, FeatureError, type FeatureContext, type FeatureDefinition } from '../_define';

/**
 * OSINT — planification, exécution d'une sonde, historique, clés.
 *
 * Le partage du travail est le point à retenir : `osint.lookup` **ne sonde
 * rien**. Il reconnaît la cible, journalise, et rend la liste des sondes à
 * faire. Le client tire ensuite un `osint.probe` par sonde, en parallèle, ce qui
 * donne l'affichage progressif sans qu'aucun sujet live ni protocole particulier
 * n'ait été inventé pour ça.
 */

async function toHistoryEntry(ctx: FeatureContext, row: OsintLookupRow): Promise<OsintHistoryEntry> {
    return {
        id: row.id,
        kind: row.kind,
        // `null` plutôt qu'un jet : une entrée illisible (coffre re-scellé,
        // clé tournée) ne doit pas empêcher d'afficher le reste de la liste.
        query: await ctx.secure.tryDecrypt(row.query_enc),
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

/** La clé d'un fournisseur, déchiffrée, ou `null` si elle n'est pas posée. */
async function providerKey(ctx: FeatureContext, provider: OsintProvider | undefined): Promise<string | null> {
    if (!provider) return null;
    const row = await ctx.db.osint.getKey(ctx.workspaceId, provider);
    return row ? ctx.crypt.Decrypt(row.key_enc) : null;
}

export const osintLookupFeature: FeatureDefinition<
    typeof osintLookup.command,
    typeof osintLookup.input,
    typeof osintLookup.output
> = defineFeature({
    ...osintLookup,
    access: { feature: 'osint' },
    mutates: true,
    handler: async (ctx, input) => {
        const target = trustedTarget(input.query);
        const probes = probesFor(target.kind);

        const row = await ctx.db.osint.createLookup({
            userId: ctx.userId,
            workspaceId: ctx.workspaceId,
            kind: target.kind,
            queryEnc: await ctx.secure.encrypt(target.query)
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
});

export const osintProbeFeature: FeatureDefinition<
    typeof osintProbe.command,
    typeof osintProbe.input,
    typeof osintProbe.output
> = defineFeature({
    ...osintProbe,
    access: { feature: 'osint' },
    handler: async (ctx, input) => {
        const target = trustedTarget(input.target.query);
        const adapter = PROBES[input.probe];

        // Deux gardes, et les deux comptent. La nature re-déduite doit
        // correspondre à celle annoncée — sinon le client a bâti sa cible à la
        // main — et la sonde doit accepter cette nature.
        if (target.kind !== input.target.kind || target.value !== input.target.value) {
            throw new FeatureError('validation', 'Cible incohérente avec la requête.');
        }
        if (!probeAccepts(input.probe, target.kind)) {
            throw new FeatureError('validation', `La sonde « ${input.probe} » ne s'applique pas à cette cible.`);
        }

        const cached = readCache(input.probe, target);
        if (cached) return { result: cached };

        const key = await providerKey(ctx, adapter.provider);
        const result = await runProbe(adapter, { target, key });
        writeCache(input.probe, target, result, adapter.ttlMs);

        return { result };
    }
});

export const osintHistoryFeature: FeatureDefinition<
    typeof osintHistory.command,
    typeof osintHistory.input,
    typeof osintHistory.output
> = defineFeature({
    ...osintHistory,
    access: { feature: 'osint' },
    handler: async (ctx, input) => {
        const rows = await ctx.db.osint.listLookups(ctx.workspaceId, input.limit);
        return { entries: await Promise.all(rows.map((r) => toHistoryEntry(ctx, r))) };
    }
});

export const osintHistoryRemoveFeature: FeatureDefinition<
    typeof osintHistoryRemove.command,
    typeof osintHistoryRemove.input,
    typeof osintHistoryRemove.output
> = defineFeature({
    ...osintHistoryRemove,
    access: { feature: 'osint', level: 'write' },
    mutates: true,
    handler: async (ctx, input) => {
        const deleted = await ctx.db.osint.deleteLookup(input.id, ctx.workspaceId);
        if (!deleted) throw new FeatureError('not_found', 'Entrée introuvable.');
        return { id: input.id };
    }
});

export const osintHistoryClearFeature: FeatureDefinition<
    typeof osintHistoryClear.command,
    typeof osintHistoryClear.input,
    typeof osintHistoryClear.output
> = defineFeature({
    ...osintHistoryClear,
    access: { feature: 'osint', level: 'write' },
    mutates: true,
    handler: async (ctx) => {
        const removed = await ctx.db.osint.clearLookups(ctx.workspaceId);
        ctx.audit({
            action: 'osint.historyClear',
            description: `Historique OSINT effacé (${removed} entrée(s))`,
            metadata: { removed }
        });
        return { removed };
    }
});

/**
 * Compte les sondes disponibles / le total.
 *
 * Le total est fixe : le nombre de sondes enregistrées, qui ne varie pas selon
 * les clés posées. Seule une sonde qui **exige** une clé (`requiresKey`) et
 * dont le fournisseur n'est pas tenu compte comme indisponible — une sonde
 * qu'une clé ne fait qu'enrichir (`phone` avec Numverify) répond déjà sans
 * elle, et compte donc comme disponible dans les deux cas.
 */
function countProbeAvailability(held: ReadonlySet<OsintProvider>): { available: number; total: number } {
    const probes = Object.values(PROBES);
    const missingKey = probes.filter((probe) => probe.requiresKey && !(probe.provider && held.has(probe.provider)));
    return { available: probes.length - missingKey.length, total: probes.length };
}

export const osintKeyListFeature: FeatureDefinition<
    typeof osintKeyList.command,
    typeof osintKeyList.input,
    typeof osintKeyList.output
> = defineFeature({
    ...osintKeyList,
    access: { feature: 'osint' },
    handler: async (ctx) => {
        const rows = await ctx.db.osint.listKeys(ctx.workspaceId);
        const held = new Set(rows.map((r) => r.provider));
        // Tous les fournisseurs sont rendus, posés ou non : l'écran de réglages
        // doit pouvoir proposer ceux qui manquent, pas seulement lister l'acquis.
        // La clé elle-même ne sort jamais — seulement le fait qu'elle existe.
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
});

export const osintSetKeyFeature: FeatureDefinition<
    typeof osintSetKey.command,
    typeof osintSetKey.input,
    typeof osintSetKey.output
> = defineFeature({
    ...osintSetKey,
    access: { feature: 'osint', level: 'write' },
    mutates: true,
    handler: async (ctx, input) => {
        const key = input.key.trim();
        if (key.length === 0) {
            await ctx.db.osint.deleteKey(ctx.workspaceId, input.provider);
            ctx.audit({
                action: 'osint.setKey',
                description: `Clé OSINT supprimée (${OSINT_PROVIDER_META[input.provider].label})`,
                metadata: { provider: input.provider, hasKey: false }
            });
            return { provider: input.provider, hasKey: false };
        }
        await ctx.db.osint.setKey(ctx.workspaceId, input.provider, ctx.crypt.Encrypt(key));
        ctx.audit({
            action: 'osint.setKey',
            description: `Clé OSINT enregistrée (${OSINT_PROVIDER_META[input.provider].label})`,
            metadata: { provider: input.provider, hasKey: true }
        });
        return { provider: input.provider, hasKey: true };
    }
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const osintFeatures: FeatureDefinition<string, any, any>[] = [
    osintLookupFeature,
    osintProbeFeature,
    osintHistoryFeature,
    osintHistoryRemoveFeature,
    osintHistoryClearFeature,
    osintKeyListFeature,
    osintSetKeyFeature
];

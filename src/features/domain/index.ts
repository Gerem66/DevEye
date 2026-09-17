import crypto from 'node:crypto';

import {
    domainAdd,
    domainList,
    domainRemove,
    domainVerify,
    featureDescriptor,
    type FeatureDomain,
    type FeatureId
} from '@deveye/types';
import { DOMAIN_HOST_PATTERN, domainOwnershipRecord, normaliseDomainHost } from '@deveye/types/sdk/server';

import type { FeatureDomainRow } from '@/db/repos/featureDomains';
import { verifyFeatureDomain } from '@/Services/domains/verifier';
import { toSdkDomain } from '../_sdk/domains';
import { moduleDomains } from '../_sdk/register';
import { defineFeature, FeatureError, type FeatureContext, type FeatureDefinition } from '../_define';

/**
 * Les domaines d'une fonctionnalité dans l'espace actif. Module transversal :
 * la fonctionnalité visée est une donnée d'entrée, donc l'autorisation est en
 * tête de handler (et les commandes dans `ACCESS_EXEMPT`).
 */

type Hooks = NonNullable<ReturnType<typeof moduleDomains>>;

function hooksFor(ctx: FeatureContext, feature: FeatureId, level: 'read' | 'write'): Hooks {
    ctx.assertFeature(feature, level);
    const hooks = moduleDomains(feature, ctx);
    if (!hooks) throw new FeatureError('validation', 'Cette fonctionnalité ne gère pas de domaines.');
    return hooks;
}

async function view(
    ctx: FeatureContext,
    hooks: Hooks,
    row: FeatureDomainRow,
    useCount: number
): Promise<FeatureDomain> {
    // Un module qui ne sait pas dire ses enregistrements ne doit pas faire
    // échouer la liste entière : la propriété reste prouvable sans lui.
    const records = await hooks.records(toSdkDomain(row)).catch((error: unknown) => {
        ctx.logger.warn(
            { feature: row.feature, host: row.host, err: (error as Error).message },
            'Domain records failed'
        );
        return [];
    });
    return {
        id: row.id,
        host: row.host,
        ownership: domainOwnershipRecord(row.feature, row.host, row.token),
        records: [...records],
        dnsState: row.dns_state,
        dnsError: row.dns_error,
        probeState: row.probe_state,
        probeError: row.probe_error,
        verifiedAt: row.verified_at,
        checkedAt: row.checked_at,
        useCount
    };
}

const listFeature = defineFeature({
    ...domainList,
    handler: async (ctx, input) => {
        const hooks = hooksFor(ctx, input.feature, 'read');
        const [rows, uses] = await Promise.all([
            ctx.db.featureDomains.list(ctx.workspaceId, input.feature),
            hooks.useCount(ctx.workspaceId)
        ]);
        return { domains: await Promise.all(rows.map((row) => view(ctx, hooks, row, uses.get(row.id) ?? 0))) };
    }
});

const addFeature = defineFeature({
    ...domainAdd,
    mutates: true,
    handler: async (ctx, input) => {
        const hooks = hooksFor(ctx, input.feature, 'write');
        const host = normaliseDomainHost(input.host);
        if (!DOMAIN_HOST_PATTERN.test(host)) {
            throw new FeatureError(
                'validation',
                'Nom de domaine attendu, sans https:// ni chemin (ex. rdv.exemple.fr).'
            );
        }
        // Tous espaces confondus : deux espaces ne peuvent pas servir le même nom.
        if (await ctx.db.featureDomains.findByHost(input.feature, host)) {
            throw new FeatureError('conflict', 'Ce domaine est déjà déclaré.');
        }
        const now = Math.floor(Date.now() / 1000);
        const id = await ctx.db.featureDomains.insert({
            workspaceId: ctx.workspaceId,
            feature: input.feature,
            host,
            token: crypto.randomBytes(16).toString('hex'),
            now
        });
        const row = await ctx.db.featureDomains.find(id, ctx.workspaceId, input.feature);
        if (!row) throw new FeatureError('internal', 'Le domaine n’a pas pu être relu.');
        ctx.audit({
            action: 'domain.add',
            description: `${featureDescriptor(input.feature).label} : domaine ${host} déclaré`
        });
        return { domain: await view(ctx, hooks, row, 0) };
    }
});

const verifyFeature = defineFeature({
    ...domainVerify,
    mutates: true,
    handler: async (ctx, input) => {
        const hooks = hooksFor(ctx, input.feature, 'write');
        const row = await ctx.db.featureDomains.find(input.id, ctx.workspaceId, input.feature);
        if (!row) throw new FeatureError('not_found', 'Domaine introuvable.');
        const outcome = await verifyFeatureDomain(ctx, row, Math.floor(Date.now() / 1000));
        const uses = await hooks.useCount(ctx.workspaceId);
        return { domain: await view(ctx, hooks, outcome?.row ?? row, uses.get(row.id) ?? 0) };
    }
});

const removeFeature = defineFeature({
    ...domainRemove,
    mutates: true,
    handler: async (ctx, input) => {
        const hooks = hooksFor(ctx, input.feature, 'write');
        const row = await ctx.db.featureDomains.find(input.id, ctx.workspaceId, input.feature);
        if (!row) throw new FeatureError('not_found', 'Domaine introuvable.');
        // Avant la suppression : si le module ne sait pas lâcher ses références,
        // le domaine reste, plutôt que de laisser des éléments le désigner.
        await hooks.onRemoved(toSdkDomain(row));
        await ctx.db.featureDomains.delete(row.id, ctx.workspaceId, input.feature);
        ctx.audit({
            action: 'domain.remove',
            level: 'warning',
            description: `${featureDescriptor(input.feature).label} : domaine ${row.host} retiré`
        });
        return { ok: true as const };
    }
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const domainFeatures: FeatureDefinition<string, any, any>[] = [
    listFeature,
    addFeature,
    verifyFeature,
    removeFeature
];

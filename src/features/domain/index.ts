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
import { httpsMode } from '@/Services/domains/proxy';
import { schedulePlanReconcile } from '@/Services/planPauses';
import { verifyFeatureDomain } from '@/Services/domains/verifier';
import { toSdkDomain } from '../_sdk/domains';
import { moduleDomains, moduleWebDomainFeatures } from '../_sdk/register';
import { defineFeature, FeatureError, type FeatureContext, type FeatureDefinition } from '../_define';
import { assertCoreLimit, coreAllowance } from '../_quota';

/**
 * Les domaines d'une fonctionnalité dans l'espace actif. Module transversal :
 * la fonctionnalité visée est une donnée d'entrée, donc l'autorisation est en
 * tête de handler (et les commandes dans `ACCESS_EXEMPT`).
 */

type Hooks = NonNullable<ReturnType<typeof moduleDomains>>;

/**
 * Un domaine web coûte un certificat sur le compte ACME de tout le serveur, et
 * donne à une page servie ici l'adresse de son choix : il se compte à l'offre.
 * Un même nom déclaré pour deux fonctionnalités ne compte qu'une fois.
 */
const HOSTS_KEY = 'domains.hosts';

function isWeb(hooks: Hooks): boolean {
    return hooks.manifest.domains?.web === true;
}

async function webHostsOf(ctx: FeatureContext, ownerWorkspaceIds: readonly number[]): Promise<Set<string>> {
    return new Set(await ctx.db.featureDomains.hostsOf(ownerWorkspaceIds, moduleWebDomainFeatures()));
}

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
    const domain = toSdkDomain(row);
    const records = await hooks.records(domain).catch((error: unknown) => {
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
        useCount,
        planPaused: domain.planPaused
    };
}

const listFeature = defineFeature({
    ...domainList,
    handler: async (ctx, input) => {
        const hooks = hooksFor(ctx, input.feature, 'read');
        const web = isWeb(hooks);
        const [rows, uses, allowance] = await Promise.all([
            ctx.db.featureDomains.list(ctx.workspaceId, input.feature),
            hooks.useCount(ctx.workspaceId),
            web ? coreAllowance(ctx, ctx.workspace.ownerUserId, HOSTS_KEY) : null
        ]);
        return {
            domains: await Promise.all(rows.map((row) => view(ctx, hooks, row, uses.get(row.id) ?? 0))),
            https: web ? httpsMode() : null,
            quota:
                allowance === null
                    ? null
                    : {
                          used: (await webHostsOf(ctx, allowance.ownerWorkspaceIds)).size,
                          limit: allowance.limit
                      }
        };
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
        if (isWeb(hooks)) {
            await assertCoreLimit(ctx, {
                ownerUserId: ctx.workspace.ownerUserId,
                fullKey: HOSTS_KEY,
                label: 'domaines personnalisés',
                countAfter: async (ids) => {
                    const hosts = await webHostsOf(ctx, ids);
                    return hosts.size + (hosts.has(host) ? 0 : 1);
                }
            });
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
        // Un nom que l'offre tient déjà en pause ailleurs l'est aussi ici.
        if (isWeb(hooks)) schedulePlanReconcile(ctx.workspace.ownerUserId);
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
        // Une place libérée rend la sienne au plus ancien nom en pause.
        if (isWeb(hooks)) schedulePlanReconcile(ctx.workspace.ownerUserId);
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

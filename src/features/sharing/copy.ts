import { createHash, randomUUID } from 'node:crypto';

import {
    featureDescriptor,
    ITEM_COPY_CHUNK_CHARS,
    itemCopyBegin,
    itemCopyChunk,
    itemCopyCommit,
    itemCopyExport,
    itemCopyPlan,
    itemCopyPut,
    itemCopyTarget,
    itemTierSchema,
    type FeatureId
} from '@deveye/types';
import { z } from 'zod';

import { appVersion } from '@/version';

import { defineFeature, FeatureError, type FeatureContext, type FeatureDefinition } from '../_define';
import { moduleItems } from '../_sdk/register';
import { loadHome } from './_shared';

/**
 * Copier un élément vers un autre espace, d'ici ou d'une autre instance. Deux
 * moitiés qui s'ignorent : la source rend l'élément en clair au navigateur, la
 * destination le reçoit du navigateur et le scelle sous sa propre clé. Entre
 * deux espaces d'ici, c'est le même chemin, les deux moitiés sur ce serveur :
 * un seul code, et la copie entre instances n'est pas un cas à part.
 *
 * Ce que la destination reçoit vient d'un navigateur, donc de n'importe qui :
 * rien n'y est cru. Le paquet est borné, son empreinte vérifiée, sa forme
 * validée ici, et ses lignes par le moteur contre l'arbre du module
 * (`importItemTree`).
 */

/** Un paquet vit ce temps-là, d'un côté comme de l'autre : le temps d'un transfert, pas d'une pause. */
const TTL_MS = 3 * 60_000;
/** Au-delà, ce n'est plus un élément qu'on copie. Borne aussi la mémoire qu'un compte peut retenir. */
const MAX_BYTES = 16 * 1024 * 1024;
/** Tous comptes confondus, dans un sens : une instance partagée ne se laisse pas remplir la mémoire. */
const MAX_BYTES_IN_FLIGHT = 128 * 1024 * 1024;

/** Deux versions parlent le même contrat quand majeur et mineur coïncident. */
const releaseOf = (version: string): string => version.split('.').slice(0, 2).join('.');

const bundleSchema = z.object({
    format: z.literal(1),
    feature: z.string(),
    appVersion: z.string(),
    tier: itemTierSchema,
    rows: z.record(z.string(), z.array(z.record(z.string(), z.unknown())))
});

interface Outgoing {
    userId: number;
    bytes: number;
    chunks: string[];
    expiresAt: number;
}

interface Incoming {
    userId: number;
    workspaceId: number;
    feature: FeatureId;
    bytes: number;
    sha256: string;
    chunks: (string | undefined)[];
    received: number;
    expiresAt: number;
}

/** Un transfert à la fois par compte et par sens : le suivant chasse le précédent. */
const outgoing = new Map<string, Outgoing>();
const incoming = new Map<string, Incoming>();

/** Fait place au transfert d'un compte, et refuse quand les autres tiennent déjà toute la mémoire prévue. */
function admit<T extends { userId: number; expiresAt: number; bytes: number }>(
    store: Map<string, T>,
    userId: number,
    bytes: number
): void {
    const now = Date.now();
    let held = 0;
    for (const [id, entry] of store) {
        if (entry.expiresAt <= now || entry.userId === userId) store.delete(id);
        else held += entry.bytes;
    }
    if (held + bytes > MAX_BYTES_IN_FLIGHT) {
        throw new FeatureError('rate_limited', 'Trop de copies en cours sur ce serveur : réessayez dans un instant.');
    }
}

function copyOf(ctx: FeatureContext, feature: FeatureId) {
    const copy = moduleItems(feature, ctx.db)?.copy;
    if (!copy) {
        throw new FeatureError('validation', `${featureDescriptor(feature).label} ne sait pas copier ses éléments.`);
    }
    return copy;
}

// ------------------------------------------------------------------ la source

const planFeature = defineFeature({
    ...itemCopyPlan,
    handler: async (ctx, input) => {
        ctx.assertFeature(input.feature, 'read');
        await ctx.assertItem(input.feature, input.itemId, 'read');
        const home = await loadHome(ctx, input.feature, input.itemId);
        const copy = copyOf(ctx, input.feature);
        const tier = await copy.tierOf(input.itemId);
        if (tier === null) throw new FeatureError('not_found', 'Élément introuvable');
        const plan = await copy.plan(input.itemId, home);
        const label = await moduleItems(input.feature, ctx.db)!.labelOf(ctx.secure.open, input.itemId, home);
        return { label, tier, blockers: [...plan.blockers], drops: [...plan.drops] };
    }
});

const exportFeature = defineFeature({
    ...itemCopyExport,
    handler: async (ctx, input) => {
        ctx.assertFeature(input.feature, 'read');
        await ctx.assertItem(input.feature, input.itemId, 'read');
        const home = await loadHome(ctx, input.feature, input.itemId);
        const copy = copyOf(ctx, input.feature);
        const plan = await copy.plan(input.itemId, home);
        if (plan.blockers.length > 0) throw new FeatureError('validation', plan.blockers[0]);
        const tier = await copy.tierOf(input.itemId);
        if (tier === null) throw new FeatureError('not_found', 'Élément introuvable');

        // Le chiffre du palier : `ctx.secure` lève `locked` tant que le coffre
        // est fermé, et l'écran le rouvre puis rappelle.
        const rows = await copy.read(input.itemId, tier === 'private' ? ctx.secure : ctx.secure.open);
        const json = JSON.stringify({ format: 1, feature: input.feature, appVersion: appVersion(), tier, rows });
        const bytes = Buffer.byteLength(json);
        if (bytes > MAX_BYTES) {
            throw new FeatureError('validation', 'Cet élément est trop volumineux pour être copié.');
        }
        const chunks: string[] = [];
        for (let at = 0; at < json.length; at += ITEM_COPY_CHUNK_CHARS) {
            chunks.push(json.slice(at, at + ITEM_COPY_CHUNK_CHARS));
        }

        admit(outgoing, ctx.userId, bytes);
        const exportId = randomUUID();
        outgoing.set(exportId, { userId: ctx.userId, bytes, chunks, expiresAt: Date.now() + TTL_MS });
        ctx.audit({
            action: 'share.copyExport',
            level: 'warning',
            description: `${featureDescriptor(input.feature).label} #${input.itemId} lu pour être copié ailleurs`,
            metadata: { feature: input.feature, itemId: input.itemId, tier, bytes }
        });
        return { exportId, bytes, chunks: chunks.length, sha256: createHash('sha256').update(json).digest('hex') };
    }
});

const chunkFeature = defineFeature({
    ...itemCopyChunk,
    handler: async (ctx, input) => {
        const entry = outgoing.get(input.exportId);
        if (!entry || entry.userId !== ctx.userId || entry.expiresAt <= Date.now()) {
            throw new FeatureError('not_found', 'Cette copie a expiré : recommencez.');
        }
        const data = entry.chunks[input.index];
        if (data === undefined) throw new FeatureError('validation', 'Tranche inconnue');
        // Le clair ne reste pas en mémoire plus que nécessaire.
        if (input.index === entry.chunks.length - 1) outgoing.delete(input.exportId);
        return { data };
    }
});

// ------------------------------------------------------------------ la destination

/** Le palier que la copie aura ici : un espace partagé n'a pas de palier gardé. */
const tierHere = (ctx: FeatureContext, wanted: 'open' | 'private'): 'open' | 'private' =>
    wanted === 'private' && ctx.workspace.kind === 'personal' ? 'private' : 'open';

const targetFeature = defineFeature({
    ...itemCopyTarget,
    handler: async (ctx, input) => {
        const label = featureDescriptor(input.feature).label;
        const blockers: string[] = [];
        if (!moduleItems(input.feature, ctx.db)?.copy) {
            blockers.push(`${label} ne sait pas recevoir de copie dans cet espace.`);
        } else if (!ctx.canFeature(input.feature, 'write')) {
            blockers.push(`Vous n’avez pas le droit d’écrire ${label} dans « ${ctx.workspace.name} ».`);
        }
        return { workspaceName: ctx.workspace.name, tier: tierHere(ctx, input.tier), blockers };
    }
});

const beginFeature = defineFeature({
    ...itemCopyBegin,
    handler: async (ctx, input) => {
        ctx.assertFeature(input.feature, 'write');
        copyOf(ctx, input.feature);
        if (input.bytes > MAX_BYTES) throw new FeatureError('validation', 'Cette copie est trop volumineuse.');
        // Un caractère pèse au moins un octet : plus de tranches que ça, et le
        // paquet annoncé ne serait pas celui qu'on s'apprête à retenir.
        if (input.chunks > Math.ceil(input.bytes / ITEM_COPY_CHUNK_CHARS) + 1) {
            throw new FeatureError('validation', 'Découpage incohérent');
        }
        admit(incoming, ctx.userId, input.bytes);
        const importId = randomUUID();
        incoming.set(importId, {
            userId: ctx.userId,
            workspaceId: ctx.workspaceId,
            feature: input.feature,
            bytes: input.bytes,
            sha256: input.sha256,
            chunks: new Array<string | undefined>(input.chunks).fill(undefined),
            received: 0,
            expiresAt: Date.now() + TTL_MS
        });
        return { importId };
    }
});

/** Le transfert en cours, s'il est bien celui de l'appelant, dans l'espace où il l'a ouvert. */
function incomingOf(ctx: FeatureContext, importId: string): Incoming {
    const entry = incoming.get(importId);
    if (
        !entry ||
        entry.userId !== ctx.userId ||
        entry.workspaceId !== ctx.workspaceId ||
        entry.expiresAt <= Date.now()
    ) {
        throw new FeatureError('not_found', 'Cette copie a expiré : recommencez.');
    }
    return entry;
}

const putFeature = defineFeature({
    ...itemCopyPut,
    handler: async (ctx, input) => {
        const entry = incomingOf(ctx, input.importId);
        if (input.index >= entry.chunks.length) throw new FeatureError('validation', 'Tranche inconnue');
        if (entry.chunks[input.index] === undefined) entry.received += 1;
        entry.chunks[input.index] = input.data;
        return { received: entry.received };
    }
});

const commitFeature = defineFeature({
    ...itemCopyCommit,
    // Le dispatcheur y lit `feature` : c'est sur elle qu'il prévient l'espace.
    mutates: true,
    handler: async (ctx, input) => {
        const entry = incomingOf(ctx, input.importId);
        if (input.feature !== entry.feature) throw new FeatureError('validation', 'Fonctionnalité inattendue');
        // Le droit est revérifié ici : il a pu tomber pendant le transfert.
        ctx.assertFeature(entry.feature, 'write');
        const copy = copyOf(ctx, entry.feature);
        if (entry.received !== entry.chunks.length) throw new FeatureError('validation', 'Copie incomplète');

        const json = entry.chunks.join('');
        if (
            Buffer.byteLength(json) !== entry.bytes ||
            createHash('sha256').update(json).digest('hex') !== entry.sha256
        ) {
            incoming.delete(input.importId);
            throw new FeatureError('validation', 'La copie est arrivée altérée : recommencez.');
        }
        let parsed;
        try {
            parsed = bundleSchema.safeParse(JSON.parse(json));
        } catch {
            parsed = null;
        }
        if (!parsed?.success || parsed.data.feature !== entry.feature) {
            incoming.delete(input.importId);
            throw new FeatureError('validation', 'Cette copie n’est pas lisible ici.');
        }
        const bundle = parsed.data;
        // Une autre version mineure décrit peut-être d'autres colonnes : le
        // moteur les refuserait une à une, autant le dire d'un mot.
        if (releaseOf(bundle.appVersion) !== releaseOf(appVersion())) {
            incoming.delete(input.importId);
            throw new FeatureError(
                'validation',
                `Cette copie vient d’un DevEye ${bundle.appVersion}, celui-ci est en ${appVersion()} : mettez les deux à la même version.`
            );
        }

        const tier = tierHere(ctx, bundle.tier);
        const cipher = tier === 'private' ? ctx.secure : ctx.secure.open;
        // Coffre fermé, `locked` doit partir AVANT la transaction, paquet gardé :
        // l'écran rouvre le coffre et rappelle, sans rien retransférer.
        if (tier === 'private') await cipher.encrypt('');

        const itemId = await ctx.db.transaction((db) =>
            copy.write(db.queryable, bundle.rows, { workspaceId: ctx.workspaceId, userId: ctx.userId, cipher, tier })
        );
        incoming.delete(input.importId);

        ctx.audit({
            action: 'share.copy',
            level: 'warning',
            description: `${featureDescriptor(entry.feature).label} #${itemId} reçu par copie dans « ${ctx.workspace.name} »`,
            metadata: { feature: entry.feature, itemId, tier, bytes: entry.bytes, fromVersion: bundle.appVersion }
        });
        return { itemId };
    }
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const copyFeatures: FeatureDefinition<string, any, any>[] = [
    planFeature,
    exportFeature,
    chunkFeature,
    targetFeature,
    beginFeature,
    putFeature,
    commitFeature
];

import {
    appStoresAddSource,
    appStoresListSources,
    appStoresListStoreApps,
    appStoresRemoveSource,
    appStoresTestSource,
    appStoresUpdateSource
} from '../contracts/commands';
import type { AppStore, AppStoresCapability, AppStoresSourceInput } from '../contracts/domain';
import { defineSdkFeature, FeatureError } from '@deveye/types/sdk/server';

import type { SourceRow } from './repo';
import { announceSource } from './service';
import { listAppleApps, parseAppleKey } from './stores/apple';
import { listGoogleApps, parseServiceAccount } from './stores/google';
import { credentialsOf, openCredentials, probeStore, storeFailure, type StoreCredentials } from './stores/index';
import {
    capabilitiesColumn,
    listingRef,
    nowSeconds,
    readSource,
    sealJson,
    syncOf,
    toSource,
    type Ctx,
    type StoredSource
} from './_shared';

/**
 * Les comptes de store de l'espace, réglés dans l'onglet Sources : une clé
 * d'API App Store Connect, ou le JSON d'un compte de service Google. Le secret
 * ne sort jamais, le DTO n'en dit que la présence. Tout est chiffré à l'étage
 * ouvert, le service les relit sans session.
 *
 * Lister et choisir restent sous l'écriture : ces commandes consomment le
 * quota d'appels d'une clé de l'espace et révèlent ce qu'elle ouvre.
 */

const WRITE = { level: 'write' } as const;

const SECRET_MISSING: Record<AppStore, string> = {
    apple: 'Collez le contenu du fichier .p8 de la clé : Apple ne le laisse télécharger qu’une fois.',
    google: 'Collez le contenu du fichier JSON du compte de service.'
};

const STEP: Record<AppStore, string> = {
    apple: 'Test de la clé auprès d’Apple',
    google: 'Test du compte de service auprès de Google'
};

/** Ce que la saisie dit de la source : son contenu sans secret, et le secret s'il en vient un neuf. */
function openInput(input: AppStoresSourceInput): { content: StoredSource; secret: string | null } {
    if (input.store === 'apple') {
        return {
            content: {
                label: input.label,
                issuerId: input.issuerId.toLowerCase(),
                keyId: input.keyId,
                vendorNumber: input.vendorNumber
            },
            secret: input.privateKey ? parseAppleKey(input.privateKey) : null
        };
    }
    const account = input.serviceAccount ? parseServiceAccount(input.serviceAccount) : null;
    return {
        content: {
            label: input.label,
            bucket: input.bucket,
            ...(account ? { clientEmail: account.clientEmail, privateKeyId: account.privateKeyId } : {})
        },
        secret: account?.privateKey ?? null
    };
}

/** Une clé acceptée qui n'ouvre rien. La note publique d'Apple n'y compte pas : elle se lit sans clé. */
const OPENS_NOTHING: Record<AppStore, string> = {
    apple: 'Apple accepte cette clé mais ne lui ouvre aucune donnée : donnez-lui un rôle dans App Store Connect (Admin couvre tout, réponses aux avis comprises).',
    google: 'Google accepte ce compte de service mais ne lui ouvre rien : invitez-le dans la Play Console, avec l’accès aux apps et aux rapports, puis comptez jusqu’à 24 h.'
};

/**
 * La clé passe chez son store : un refus net lève `refusedAs`, une clé qui
 * n'ouvre rien aussi ; le reste dit ce qu'elle sait lire.
 */
async function testKey(
    ctx: Ctx,
    credentials: StoreCredentials,
    refusedAs: 'validation' | 'conflict'
): Promise<AppStoresCapability[]> {
    ctx.progress({ step: STEP[credentials.store] });
    let capabilities: AppStoresCapability[];
    try {
        capabilities = await probeStore(credentials);
    } catch (e) {
        storeFailure(e, refusedAs);
    }
    const opened = credentials.store === 'apple' ? capabilities.filter((c) => c !== 'ratings') : capabilities;
    if (opened.length === 0) throw new FeatureError(refusedAs, OPENS_NOTHING[credentials.store]);
    return capabilities;
}

async function loadSource(ctx: Ctx, sourceId: number): Promise<SourceRow> {
    const row = await ctx.repo.findSource(sourceId, ctx.workspaceId);
    if (!row) throw new FeatureError('not_found', 'Source introuvable');
    return row;
}

async function openSource(ctx: Ctx, row: SourceRow): Promise<StoreCredentials> {
    const opened = await openCredentials(ctx.cipher(), row);
    if (!opened) {
        throw new FeatureError('validation', 'La clé enregistrée ne se lit plus : saisissez-la de nouveau.');
    }
    return opened.credentials;
}

/**
 * La clé vient de passer son test : une perte annoncée se referme, et ses
 * canaux l'apprennent. Une perte jamais annoncée s'efface sans un mot.
 */
async function recovered(ctx: Ctx, row: SourceRow): Promise<void> {
    if (Number(row.failing_count) === 0 && row.failing_since === null) return;
    await ctx.repo.clearSourceFailure(row.id);
    if (Number(row.failing_notified) !== 1) return;
    await announceSource(ctx.repo, ctx.cipher(), ctx.deveye.notify, row, {
        lost: false,
        cause: '',
        at: nowSeconds()
    }).catch((e: unknown) =>
        ctx.logger.warn({ err: e, sourceId: row.id }, 'Stores : avis de rétablissement non envoyé')
    );
}

async function present(ctx: Ctx, row: SourceRow) {
    const uses = await ctx.repo.countSourceUses(ctx.workspaceId);
    return { source: await toSource(ctx.cipher(), row, uses.get(row.id) ?? 0) };
}

export const appStoresSourceFeatures = [
    defineSdkFeature({
        ...appStoresListSources,
        access: WRITE,
        handler: async (ctx: Ctx) => {
            const [rows, uses] = await Promise.all([
                ctx.repo.listSources(ctx.workspaceId),
                ctx.repo.countSourceUses(ctx.workspaceId)
            ]);
            const cipher = ctx.cipher();
            return { sources: await Promise.all(rows.map((row) => toSource(cipher, row, uses.get(row.id) ?? 0))) };
        }
    }),
    defineSdkFeature({
        ...appStoresAddSource,
        access: WRITE,
        mutates: true,
        handler: async (ctx: Ctx, input) => {
            const { content, secret } = openInput(input);
            if (secret === null) throw new FeatureError('validation', SECRET_MISSING[input.store]);
            const credentials = credentialsOf(input.store, content, secret);
            if (!credentials) throw new FeatureError('validation', SECRET_MISSING[input.store]);
            const capabilities = await testKey(ctx, credentials, 'validation');
            const cipher = ctx.cipher();
            const row = await ctx.repo.createSource({
                workspaceId: ctx.workspaceId,
                store: input.store,
                content: await sealJson(cipher, content),
                secretEnc: await cipher.encrypt(secret),
                capabilities: capabilitiesColumn(capabilities),
                checkedAt: nowSeconds()
            });
            ctx.audit({
                action: 'appstores.addSource',
                description:
                    input.store === 'apple' ? 'Clé App Store Connect ajoutée' : 'Compte de service Google Play ajouté',
                metadata: { sourceId: row.id, store: input.store }
            });
            return { source: await toSource(cipher, row, 0) };
        }
    }),
    defineSdkFeature({
        ...appStoresUpdateSource,
        access: WRITE,
        mutates: true,
        handler: async (ctx: Ctx, input) => {
            const row = await loadSource(ctx, input.sourceId);
            if (row.store !== input.source.store) {
                throw new FeatureError(
                    'validation',
                    'Le store d’une source ne change pas : ajoutez plutôt une autre source.'
                );
            }
            const cipher = ctx.cipher();
            const opened = openInput(input.source);
            const content: StoredSource = { ...(await readSource(cipher, row)), ...opened.content };
            const secret = opened.secret ?? (await cipher.tryDecrypt(row.secret_enc));
            const credentials = secret ? credentialsOf(row.store, content, secret) : null;
            if (!credentials || !secret) throw new FeatureError('validation', SECRET_MISSING[row.store]);
            const capabilities = await testKey(ctx, credentials, 'validation');
            const updated = await ctx.repo.updateSource(row.id, ctx.workspaceId, {
                content: await sealJson(cipher, content),
                secretEnc: opened.secret ? await cipher.encrypt(opened.secret) : undefined,
                capabilities: capabilitiesColumn(capabilities),
                checkedAt: nowSeconds()
            });
            if (!updated) throw new FeatureError('not_found', 'Source introuvable');
            await recovered(ctx, row);
            syncOf()?.wake();
            return present(ctx, { ...updated, failing_count: 0, failing_since: null, failing_error: null });
        }
    }),
    defineSdkFeature({
        ...appStoresRemoveSource,
        access: WRITE,
        mutates: true,
        handler: async (ctx: Ctx, input) => {
            // Les fiches qui s'en servaient restent, sans source : leur
            // synchronisation s'arrête, et la fiche le dit.
            const removed = await ctx.repo.removeSource(input.sourceId, ctx.workspaceId);
            if (!removed) throw new FeatureError('not_found', 'Source introuvable');
            ctx.audit({
                action: 'appstores.removeSource',
                description: 'Source de Stores retirée',
                metadata: { sourceId: input.sourceId }
            });
            return { sourceId: input.sourceId };
        }
    }),
    defineSdkFeature({
        ...appStoresTestSource,
        access: WRITE,
        mutates: true,
        handler: async (ctx: Ctx, input) => {
            const row = await loadSource(ctx, input.sourceId);
            const capabilities = await testKey(ctx, await openSource(ctx, row), 'validation');
            const updated = await ctx.repo.setCapabilities(
                row.id,
                ctx.workspaceId,
                capabilitiesColumn(capabilities),
                nowSeconds()
            );
            if (!updated) throw new FeatureError('not_found', 'Source introuvable');
            await recovered(ctx, row);
            syncOf()?.wake();
            return present(ctx, { ...updated, failing_count: 0, failing_since: null, failing_error: null });
        }
    }),
    defineSdkFeature({
        ...appStoresListStoreApps,
        access: WRITE,
        handler: async (ctx: Ctx, input) => {
            const row = await loadSource(ctx, input.sourceId);
            const credentials = await openSource(ctx, row);
            ctx.progress({
                step: credentials.store === 'apple' ? 'Lecture des apps chez Apple' : 'Lecture des apps chez Google'
            });
            let apps: { externalId: string; name: string; bundleId: string | null }[];
            try {
                apps =
                    credentials.store === 'apple'
                        ? await listAppleApps(credentials.creds)
                        : await listGoogleApps(credentials.creds);
            } catch (e) {
                storeFailure(e, 'conflict');
            }
            const known = new Set(await ctx.repo.listListingRefs(ctx.workspaceId));
            return {
                apps: apps
                    .map((app) => ({
                        store: row.store,
                        externalId: app.externalId,
                        name: app.name,
                        bundleId: app.bundleId,
                        known: known.has(listingRef(ctx.keys, ctx.workspaceId, row.store, app.externalId))
                    }))
                    .sort((a, b) => a.name.localeCompare(b.name, 'fr', { sensitivity: 'base', numeric: true }))
            };
        }
    })
];

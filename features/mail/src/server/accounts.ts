import {
    mailAccountAdd,
    mailAccountCount,
    mailAccountDelete,
    mailAccountList,
    mailAccountReorder,
    mailAccountSetEnabled,
    mailAccountSetRemoteImages,
    mailAccountSetProfile,
    mailAccountTestConnection,
    mailAccountUpdate,
    mailOAuthFinish,
    mailOAuthProviders,
    mailOAuthStart
} from '../contracts/commands';
import {
    MAIL_SYNC_INTERVAL_DEFAULT_MINUTES,
    mailOAuthProviderSchema,
    mailSecurityTierSchema,
    type MailAccountRow
} from '../contracts/domain';
import { defineSdkFeature, FeatureError } from '@deveye/types/sdk/server';
import { z } from 'zod';

import * as mailClient from './client';
import type { MailCredentials, MailOAuthCredentials } from './client';
import { buildAuthorizationUrl, exchangeCodeForTokens, isOAuthConfigured } from './oauth';
import type { MailRepo } from './repo';
import {
    accountCipher,
    assertAtHome,
    assertMailUnlocked,
    assertTierAllowed,
    cipherFor,
    credentialsFor,
    decryptCredentials,
    encryptCredentials,
    imapFor,
    isForeign,
    loadAccount,
    mergeEndpoint,
    refreshCallback,
    rekeyTier,
    toAccountDTO,
    tryDecryptCredentials,
    WRITE,
    type Ctx
} from './_shared';

/**
 * Les comptes : leur liste, leur cycle de vie, leur palier, et l'entrée OAuth.
 *
 * Chaque commande choisit son codec par le compte (`accountCipher`) et, pour un
 * compte gardé, exige la session déverrouillée (`assertMailUnlocked`) avant de
 * lire quoi que ce soit : une liste vide n'est pas une liste verrouillée.
 *
 * Le compte est l'élément que le partage projette (`Docs/SHARING.md`) : une
 * fenêtre le liste, le relève, y lit et en expédie ; supprimer, changer de
 * palier et retoucher les identifiants restent au domicile (`assertAtHome`).
 */

/**
 * Les comptes visibles d'ici (les siens, plus les projetés), moins ceux qu'une
 * restriction de rôle masque : ils disparaissent de la liste plutôt que d'y
 * figurer grisés, une ligne qu'on voit sans pouvoir l'ouvrir apprenant déjà
 * qu'elle existe.
 */
async function listVisibleAccounts(ctx: Ctx): Promise<MailAccountRow[]> {
    const [rows, hidden] = await Promise.all([
        ctx.repo.accounts.listVisible(ctx.workspaceId),
        ctx.items.restrictions()
    ]);
    return rows.filter((row) => hidden.get(String(row.id)) !== 'none');
}

export const mailAccountListFeature = defineSdkFeature<
    MailRepo,
    typeof mailAccountList.command,
    typeof mailAccountList.input,
    typeof mailAccountList.output
>({
    ...mailAccountList,
    handler: async (ctx) => {
        const rows = await listVisibleAccounts(ctx);
        // Le codec est choisi ligne par ligne : un compte projeté reste chiffré
        // sous la clé de son espace d'origine, et le lire avec celle d'ici le
        // ferait passer pour verrouillé.
        const accounts = await Promise.all(
            rows.map(async (row) =>
                toAccountDTO(
                    await accountCipher(ctx, row),
                    row,
                    isForeign(ctx, row),
                    ctx.quota.isPaused('accounts', String(row.id))
                )
            )
        );
        return { accounts };
    }
});

export const mailAccountCountFeature = defineSdkFeature<
    MailRepo,
    typeof mailAccountCount.command,
    typeof mailAccountCount.input,
    typeof mailAccountCount.output
>({
    ...mailAccountCount,
    // Les mêmes lignes que la liste : une carte qui compte autre chose que la
    // liste qu'elle ouvre se lit comme un bug.
    handler: async (ctx) => ({ count: (await listVisibleAccounts(ctx)).length })
});

export const mailAccountAddFeature = defineSdkFeature<
    MailRepo,
    typeof mailAccountAdd.command,
    typeof mailAccountAdd.input,
    typeof mailAccountAdd.output
>({
    ...mailAccountAdd,
    access: WRITE,
    mutates: true,
    handler: async (ctx, input) => {
        assertTierAllowed(ctx, input.draft.securityTier);
        await ctx.quota.assert('accounts', async (owned) => (await ctx.repo.accounts.countInWorkspaces(owned)) + 1);
        await assertMailUnlocked(ctx, input.draft.securityTier);
        const cipher = cipherFor(ctx, input.draft.securityTier);
        const credentials: MailCredentials = {
            kind: 'password',
            imap: input.draft.imap,
            smtp: input.draft.smtp,
            proxy: input.draft.proxy
        };
        const row = await ctx.repo.accounts.create({
            userId: ctx.userId,
            workspaceId: ctx.workspaceId,
            displayNameEnc: await cipher.encrypt(input.draft.displayName),
            emailAddressEnc: await cipher.encrypt(input.draft.emailAddress),
            securityTier: input.draft.securityTier,
            authMethod: 'password',
            credentialsEnc: await encryptCredentials(cipher, credentials),
            enabled: true,
            syncIntervalSeconds: MAIL_SYNC_INTERVAL_DEFAULT_MINUTES * 60
        });
        ctx.audit({
            action: 'mail.accountAdd',
            description: `Compte mail ajouté : « ${input.draft.displayName} »`,
            metadata: { accountId: row.id }
        });
        return { account: await toAccountDTO(cipher, row, false, ctx.quota.isPaused('accounts', String(row.id))) };
    }
});

export const mailAccountUpdateFeature = defineSdkFeature<
    MailRepo,
    typeof mailAccountUpdate.command,
    typeof mailAccountUpdate.input,
    typeof mailAccountUpdate.output
>({
    ...mailAccountUpdate,
    access: { ...WRITE, item: 'id' },
    mutates: true,
    handler: async (ctx, input) => {
        const existing = await loadAccount(ctx, input.id, 'write');
        // Ce formulaire réécrit les identifiants et le palier : la donnée d'un
        // autre espace, reliée à son mot de passe. Le domicile seulement.
        assertAtHome(ctx, existing, 'modifier ses identifiants');
        if (existing.auth_method !== 'password') {
            throw new FeatureError(
                'validation',
                'Un compte connecté par OAuth ne se modifie pas ainsi : supprimez-le puis reconnectez-le'
            );
        }
        await assertMailUnlocked(ctx, existing.security_tier);
        assertTierAllowed(ctx, input.draft.securityTier);
        await assertMailUnlocked(ctx, input.draft.securityTier);
        const cipher = cipherFor(ctx, input.draft.securityTier);

        // The edit form can't prefill secrets (the DTO never serves one back),
        // so a blank field means "keep it" rather than "clear it" — otherwise
        // renaming a mailbox would silently break its credentials.
        const stored = await credentialsFor(ctx, existing);
        const kept = stored.kind === 'password' ? stored : null;
        const credentials: MailCredentials = {
            kind: 'password',
            imap: mergeEndpoint(input.draft.imap, kept?.imap),
            smtp: mergeEndpoint(input.draft.smtp, kept?.smtp),
            proxy: input.draft.proxy === undefined ? (kept?.proxy ?? null) : input.draft.proxy
        };
        for (const [label, endpoint] of [
            ['IMAP', credentials.imap],
            ['SMTP', credentials.smtp]
        ] as const) {
            if (!endpoint.username || !endpoint.password) {
                throw new FeatureError('validation', `Identifiant et mot de passe ${label} requis`);
            }
        }
        const row = await ctx.repo.accounts.update(input.id, ctx.workspaceId, {
            displayNameEnc: await cipher.encrypt(input.draft.displayName),
            emailAddressEnc: await cipher.encrypt(input.draft.emailAddress),
            securityTier: input.draft.securityTier,
            authMethod: 'password',
            credentialsEnc: await encryptCredentials(cipher, credentials),
            enabled: existing.enabled === 1,
            // Owned by the account's own options panel, not by this form.
            syncIntervalSeconds: existing.sync_interval_seconds
        });
        if (!row) throw new FeatureError('not_found', 'Compte mail introuvable');
        if (existing.security_tier !== input.draft.securityTier) {
            await rekeyTier(ctx, existing, input.draft.securityTier, cipher);
        }
        ctx.audit({
            action: 'mail.accountUpdate',
            description: `Compte mail modifié : « ${input.draft.displayName} »`,
            metadata: { accountId: row.id }
        });
        return { account: await toAccountDTO(cipher, row, false, ctx.quota.isPaused('accounts', String(row.id))) };
    }
});

export const mailAccountSetProfileFeature = defineSdkFeature<
    MailRepo,
    typeof mailAccountSetProfile.command,
    typeof mailAccountSetProfile.input,
    typeof mailAccountSetProfile.output
>({
    ...mailAccountSetProfile,
    access: { ...WRITE, item: 'id' },
    mutates: true,
    handler: async (ctx, input) => {
        const existing = await loadAccount(ctx, input.id, 'write');
        // Depuis une fenêtre, le nom et la cadence se règlent ; le palier et le
        // proxy, non : le premier relie la boîte au mot de passe de son auteur,
        // le second fait partie de ses identifiants.
        if (input.securityTier !== existing.security_tier) assertAtHome(ctx, existing, 'changer son palier');
        if (input.proxy !== undefined) assertAtHome(ctx, existing, 'modifier son proxy');
        // Both ends of the move have to be reachable: reading what's there now,
        // and writing it back under the tier the user is switching to.
        await assertMailUnlocked(ctx, existing.security_tier);
        assertTierAllowed(ctx, input.securityTier);
        await assertMailUnlocked(ctx, input.securityTier);
        // Réécrit sous le codec de son domicile : un compte projeté chiffré
        // avec la clé d'ici deviendrait illisible chez lui, donc pour tout le
        // monde, relève de fond comprise.
        const from = await accountCipher(ctx, existing);
        const to = isForeign(ctx, existing) ? from : cipherFor(ctx, input.securityTier);

        const credentials = await decryptCredentials(from, existing.credentials_enc);
        // Absent means "leave the proxy alone": the DTO never echoes proxy
        // credentials back, so only an explicit null removes it.
        if (input.proxy !== undefined) credentials.proxy = input.proxy;
        const emailAddress = (await from.tryDecrypt(existing.email_address_enc)) ?? '';

        const row = await ctx.repo.accounts.update(input.id, existing.workspace_id, {
            displayNameEnc: await to.encrypt(input.displayName),
            emailAddressEnc: await to.encrypt(emailAddress),
            securityTier: input.securityTier,
            authMethod: existing.auth_method,
            credentialsEnc: await encryptCredentials(to, credentials),
            enabled: existing.enabled === 1,
            syncIntervalSeconds: input.syncIntervalMinutes * 60
        });
        if (!row) throw new FeatureError('not_found', 'Compte mail introuvable');
        if (existing.security_tier !== input.securityTier) {
            await rekeyTier(ctx, existing, input.securityTier, to);
        }

        ctx.audit({
            action: 'mail.accountSetProfile',
            description: `Compte mail modifié : « ${input.displayName} »`,
            metadata: { accountId: row.id, securityTier: input.securityTier }
        });
        return {
            account: await toAccountDTO(to, row, isForeign(ctx, row), ctx.quota.isPaused('accounts', String(row.id)))
        };
    }
});

export const mailAccountDeleteFeature = defineSdkFeature<
    MailRepo,
    typeof mailAccountDelete.command,
    typeof mailAccountDelete.input,
    typeof mailAccountDelete.output
>({
    ...mailAccountDelete,
    access: { ...WRITE, item: 'id' },
    mutates: true,
    handler: async (ctx, input) => {
        const existing = await loadAccount(ctx, input.id, 'write');
        // Supprimer depuis un espace qui ne fait que le voir détruirait la donnée
        // d'un autre : retirer la projection est `share.set`, pas ceci.
        assertAtHome(ctx, existing, 'la supprimer');
        await ctx.repo.accounts.delete(input.id, ctx.workspaceId);
        // Le ménage d'un élément supprimé (restrictions par rôle, projections,
        // route de notification), qu'aucune clé étrangère ne rattache à la table
        // des comptes.
        await ctx.items.forget(String(input.id));
        ctx.audit({
            action: 'mail.accountDelete',
            level: 'warning',
            description: 'Compte mail supprimé',
            metadata: { accountId: input.id }
        });
        return { id: input.id };
    }
});

export const mailAccountReorderFeature = defineSdkFeature<
    MailRepo,
    typeof mailAccountReorder.command,
    typeof mailAccountReorder.input,
    typeof mailAccountReorder.output
>({
    ...mailAccountReorder,
    access: WRITE,
    mutates: true,
    handler: async (ctx, input) => {
        await ctx.repo.accounts.reorder(ctx.workspaceId, input.ids);
        return { ids: input.ids };
    }
});

export const mailAccountSetEnabledFeature = defineSdkFeature<
    MailRepo,
    typeof mailAccountSetEnabled.command,
    typeof mailAccountSetEnabled.input,
    typeof mailAccountSetEnabled.output
>({
    ...mailAccountSetEnabled,
    access: { ...WRITE, item: 'id' },
    mutates: true,
    handler: async (ctx, input) => {
        // La pause est un état de la boîte, pas un de ses réglages de domicile :
        // une fenêtre peut suspendre la relève de ce qu'elle voit.
        const existing = await loadAccount(ctx, input.id, 'write');
        const row = await ctx.repo.accounts.setEnabled(input.id, existing.workspace_id, input.enabled);
        if (!row) throw new FeatureError('not_found', 'Compte mail introuvable');
        return {
            account: await toAccountDTO(
                await accountCipher(ctx, row),
                row,
                isForeign(ctx, row),
                ctx.quota.isPaused('accounts', String(row.id))
            )
        };
    }
});

export const mailAccountSetRemoteImagesFeature = defineSdkFeature<
    MailRepo,
    typeof mailAccountSetRemoteImages.command,
    typeof mailAccountSetRemoteImages.input,
    typeof mailAccountSetRemoteImages.output
>({
    ...mailAccountSetRemoteImages,
    access: { ...WRITE, item: 'id' },
    mutates: true,
    handler: async (ctx, input) => {
        const existing = await loadAccount(ctx, input.id, 'write');
        const row = await ctx.repo.accounts.setAllowRemoteImages(input.id, existing.workspace_id, input.allowed);
        if (!row) throw new FeatureError('not_found', 'Compte mail introuvable');
        return {
            account: await toAccountDTO(
                await accountCipher(ctx, row),
                row,
                isForeign(ctx, row),
                ctx.quota.isPaused('accounts', String(row.id))
            )
        };
    }
});

export const mailAccountTestConnectionFeature = defineSdkFeature<
    MailRepo,
    typeof mailAccountTestConnection.command,
    typeof mailAccountTestConnection.input,
    typeof mailAccountTestConnection.output
>({
    ...mailAccountTestConnection,
    access: { ...WRITE, item: 'id' },
    handler: async (ctx, input) => {
        if (input.draft) {
            const credentials: MailCredentials = {
                kind: 'password',
                imap: input.draft.imap,
                smtp: input.draft.smtp,
                proxy: input.draft.proxy
            };
            return mailClient.testConnection(credentials);
        }
        // The command's own `.refine` guarantees exactly one of `id`/`draft`,
        // so reaching here means `id` is set — but narrow it rather than assert.
        if (input.id === undefined) throw new FeatureError('validation', 'Fournir soit id, soit draft');
        const account = await loadAccount(ctx, input.id, 'write');
        await assertMailUnlocked(ctx, account.security_tier);
        const cipher = await accountCipher(ctx, account);
        return imapFor(ctx, account, (credentials) =>
            mailClient.testConnection(credentials, refreshCallback(ctx, account, credentials, cipher))
        );
    }
});

export const mailOAuthProvidersFeature = defineSdkFeature<
    MailRepo,
    typeof mailOAuthProviders.command,
    typeof mailOAuthProviders.input,
    typeof mailOAuthProviders.output
>({
    ...mailOAuthProviders,
    handler: async () => ({ configured: mailOAuthProviderSchema.options.filter(isOAuthConfigured) })
});

/** La charge du `state` OAuth, telle que `mail.oauthStart` la pose et `mail.oauthFinish` la relit. */
export const oauthStateSchema = z.object({
    provider: mailOAuthProviderSchema,
    securityTier: mailSecurityTierSchema,
    /** Le nom saisi au formulaire. Vide : le compte prend son adresse. */
    displayName: z.string().default(''),
    /**
     * La boîte à renouveler, déjà vérifiée par `mail.oauthStart` (existence,
     * domicile, méthode) : le ticket est signé, cet identifiant ne se falsifie
     * pas. `null` pour une création.
     */
    accountId: z.number().int().positive().nullable().default(null)
});

/**
 * L'entrée du consentement OAuth. Le `state` est un ticket de session de dix
 * minutes (le temps de choisir un compte chez le fournisseur) qui porte le
 * fournisseur et le palier ; `mail.oauthFinish` le rend, dans la même session,
 * et crée ou renouvelle le compte sous le bon codec.
 */
export const mailOAuthStartFeature = defineSdkFeature<
    MailRepo,
    typeof mailOAuthStart.command,
    typeof mailOAuthStart.input,
    typeof mailOAuthStart.output
>({
    ...mailOAuthStart,
    access: { ...WRITE, item: 'accountId' },
    handler: async (ctx, input) => {
        if (!isOAuthConfigured(input.provider)) {
            throw new FeatureError('validation', `OAuth ${input.provider} n'est pas configuré sur ce serveur`);
        }
        assertTierAllowed(ctx, input.securityTier);
        // Renouvellement : la boîte est vérifiée ICI, pendant qu'on a la session
        // et ses droits. La route de callback n'en a plus, elle ne fera que
        // reprendre l'identifiant que ce ticket scelle.
        if (input.accountId !== null) {
            const account = await ctx.repo.accounts.findById(input.accountId, ctx.workspaceId);
            if (!account) throw new FeatureError('not_found', 'Boîte introuvable');
            assertAtHome(ctx, account, 'reconnecter cette boîte');
            if (account.auth_method === 'password') {
                throw new FeatureError('validation', 'Cette boîte utilise une connexion manuelle : rien à reconnecter');
            }
        }
        const state = await ctx.secrecy.ticket(
            {
                provider: input.provider,
                securityTier: input.securityTier,
                displayName: input.displayName,
                accountId: input.accountId
            },
            { ttlSeconds: 600 }
        );
        return { authUrl: buildAuthorizationUrl(input.provider, state, ctx.origins.app) };
    }
});

/**
 * La fin du consentement, dans la session qui l'a lancé : la fenêtre du
 * fournisseur n'a fait que rapporter le code et le `state`, et le `state` ne se
 * rend qu'à la session qui l'a émis. Un lien de consentement envoyé à un tiers
 * n'aboutit donc nulle part. `oauth` s'injecte pour les tests, l'échange du
 * code sortant sur le réseau.
 */
export function mailOAuthFinishFeature(
    oauth: { exchangeCodeForTokens: typeof exchangeCodeForTokens } = { exchangeCodeForTokens }
) {
    return defineSdkFeature<
        MailRepo,
        typeof mailOAuthFinish.command,
        typeof mailOAuthFinish.input,
        typeof mailOAuthFinish.output
    >({
        ...mailOAuthFinish,
        access: WRITE,
        mutates: true,
        handler: async (ctx, input) => {
            const ticket = await ctx.secrecy.redeem(input.state);
            const claims = ticket ? oauthStateSchema.safeParse(ticket.payload) : null;
            if (!claims?.success) throw new FeatureError('validation', 'Lien de connexion expiré ou invalide');
            const { provider, securityTier, displayName, accountId } = claims.data;
            // Le palier a été vérifié à l'émission du ticket ; il reste à tenir
            // le codec, un compte gardé exigeant que la session le soit encore.
            await assertMailUnlocked(ctx, securityTier);
            const cipher = cipherFor(ctx, securityTier);
            const tokens = await oauth.exchangeCodeForTokens(provider, input.code, ctx.origins.app).catch((e) => {
                throw new FeatureError('validation', e instanceof Error ? e.message : String(e));
            });
            const credentials: MailOAuthCredentials = {
                kind: 'oauth',
                provider,
                email: tokens.email,
                accessToken: tokens.accessToken,
                refreshToken: tokens.refreshToken,
                expiresAt: tokens.expiresAt,
                // Posé ensuite depuis le formulaire du compte, si on en veut un.
                proxy: null
            };
            const providerName = provider === 'google' ? 'Google' : 'Microsoft';
            const authMethod = provider === 'google' ? ('oauth_google' as const) : ('oauth_microsoft' as const);

            if (accountId !== null) {
                const existing = await ctx.repo.accounts.findById(accountId, ctx.workspaceId);
                if (!existing) {
                    throw new FeatureError('not_found', 'Boîte introuvable : elle a pu être supprimée entre-temps');
                }
                // L'adresse consentie doit être celle de la boîte : sans ce contrôle,
                // se tromper de compte chez le fournisseur écraserait les jetons
                // d'une boîte par ceux d'une autre, dont elle porterait le nom.
                const known = await cipher.tryDecrypt(existing.email_address_enc);
                if (known !== null && known.toLowerCase() !== tokens.email.toLowerCase()) {
                    throw new FeatureError('validation', `Ce consentement porte sur ${tokens.email}, pas sur ${known}`);
                }
                // Le proxy, et le jeton de rafraîchissement quand le fournisseur
                // n'en rend pas un neuf, appartiennent à la boîte : l'écran de
                // consentement ne les redemande pas, les écraser les perd.
                const previous = await tryDecryptCredentials(cipher, existing.credentials_enc);
                const reconnected: MailOAuthCredentials = {
                    ...credentials,
                    refreshToken: tokens.refreshToken ?? (previous?.kind === 'oauth' ? previous.refreshToken : null),
                    proxy: previous?.proxy ?? null
                };
                await ctx.repo.accounts.update(existing.id, ctx.workspaceId, {
                    displayNameEnc: existing.display_name_enc,
                    emailAddressEnc: existing.email_address_enc,
                    securityTier: existing.security_tier,
                    authMethod,
                    credentialsEnc: await encryptCredentials(cipher, reconnected),
                    enabled: existing.enabled === 1,
                    syncIntervalSeconds: existing.sync_interval_seconds
                });
                // L'état d'erreur ne survit pas au renouvellement : le laisser
                // ferait dire à la boîte qu'elle est toujours refusée.
                await ctx.repo.accounts.recordStatus(existing.id, Math.floor(Date.now() / 1000), null, 'ok');
                ctx.audit({
                    action: 'mail.oauthReconnect',
                    description: `Compte mail reconnecté via ${providerName}`,
                    metadata: { accountId: existing.id, provider }
                });
                return { accountId: existing.id };
            }

            await ctx.quota.assert('accounts', async (owned) => (await ctx.repo.accounts.countInWorkspaces(owned)) + 1);
            const account = await ctx.repo.accounts.create({
                userId: ctx.userId,
                workspaceId: ctx.workspaceId,
                displayNameEnc: await cipher.encrypt(displayName || tokens.email),
                emailAddressEnc: await cipher.encrypt(tokens.email),
                securityTier,
                authMethod,
                credentialsEnc: await encryptCredentials(cipher, credentials),
                enabled: true,
                syncIntervalSeconds: MAIL_SYNC_INTERVAL_DEFAULT_MINUTES * 60
            });
            ctx.audit({
                action: 'mail.oauthConnect',
                description: `Compte mail connecté via ${providerName}`,
                metadata: { accountId: account.id, provider }
            });
            return { accountId: account.id };
        }
    });
}

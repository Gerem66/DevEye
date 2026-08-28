import {
    mailAccountAdd,
    mailAccountCount,
    mailAccountDelete,
    mailAccountList,
    mailAccountReorder,
    mailAccountSetEnabled,
    mailAccountSetProfile,
    mailAccountTestConnection,
    mailAccountUpdate,
    mailOAuthStart
} from '../contracts/commands';
import { MAIL_SYNC_INTERVAL_DEFAULT_MINUTES } from '../contracts/domain';
import { defineSdkFeature, FeatureError } from '@deveye/types/sdk/server';

import * as mailClient from './client';
import type { MailCredentials } from './client';
import { buildAuthorizationUrl, isOAuthConfigured } from './oauth';
import type { MailRepo } from './repo';
import {
    assertMailUnlocked,
    assertTierAllowed,
    cipherFor,
    credentialsFor,
    decryptCredentials,
    encryptCredentials,
    imapFor,
    loadAccount,
    mergeEndpoint,
    refreshCallback,
    rekeyTier,
    toAccountDTO,
    WRITE
} from './_shared';

/**
 * Les comptes : leur liste, leur cycle de vie, leur palier, et l'entrée OAuth.
 *
 * Chaque commande choisit son codec par le palier du compte (`cipherFor`) et,
 * pour un compte gardé, exige la session déverrouillée (`assertMailUnlocked`)
 * avant de lire quoi que ce soit : une liste vide n'est pas une liste
 * verrouillée.
 */

export const mailAccountListFeature = defineSdkFeature<
    MailRepo,
    typeof mailAccountList.command,
    typeof mailAccountList.input,
    typeof mailAccountList.output
>({
    ...mailAccountList,
    handler: async (ctx) => {
        const rows = await ctx.repo.accounts.listByWorkspace(ctx.workspaceId);
        const accounts = await Promise.all(rows.map((row) => toAccountDTO(cipherFor(ctx, row.security_tier), row)));
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
    handler: async (ctx) => ({ count: await ctx.repo.accounts.count(ctx.workspaceId) })
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
        return { account: await toAccountDTO(cipher, row) };
    }
});

export const mailAccountUpdateFeature = defineSdkFeature<
    MailRepo,
    typeof mailAccountUpdate.command,
    typeof mailAccountUpdate.input,
    typeof mailAccountUpdate.output
>({
    ...mailAccountUpdate,
    access: WRITE,
    mutates: true,
    handler: async (ctx, input) => {
        const existing = await loadAccount(ctx, input.id);
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
        return { account: await toAccountDTO(cipher, row) };
    }
});

export const mailAccountSetProfileFeature = defineSdkFeature<
    MailRepo,
    typeof mailAccountSetProfile.command,
    typeof mailAccountSetProfile.input,
    typeof mailAccountSetProfile.output
>({
    ...mailAccountSetProfile,
    access: WRITE,
    mutates: true,
    handler: async (ctx, input) => {
        const existing = await loadAccount(ctx, input.id);
        // Both ends of the move have to be reachable: reading what's there now,
        // and writing it back under the tier the user is switching to.
        await assertMailUnlocked(ctx, existing.security_tier);
        assertTierAllowed(ctx, input.securityTier);
        await assertMailUnlocked(ctx, input.securityTier);
        const from = cipherFor(ctx, existing.security_tier);
        const to = cipherFor(ctx, input.securityTier);

        const credentials = await decryptCredentials(from, existing.credentials_enc);
        // Absent means "leave the proxy alone" — the DTO never echoes proxy
        // credentials back, so the client has nothing to resubmit (see the
        // command's own doc); only an explicit null removes it.
        if (input.proxy !== undefined) credentials.proxy = input.proxy;
        const emailAddress = (await from.tryDecrypt(existing.email_address_enc)) ?? '';

        const row = await ctx.repo.accounts.update(input.id, ctx.workspaceId, {
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
        return { account: await toAccountDTO(to, row) };
    }
});

export const mailAccountDeleteFeature = defineSdkFeature<
    MailRepo,
    typeof mailAccountDelete.command,
    typeof mailAccountDelete.input,
    typeof mailAccountDelete.output
>({
    ...mailAccountDelete,
    access: WRITE,
    mutates: true,
    handler: async (ctx, input) => {
        await loadAccount(ctx, input.id);
        await ctx.repo.accounts.delete(input.id, ctx.workspaceId);
        // Le ménage d'un élément supprimé (restrictions par rôle, projections,
        // route de notification), qu'aucune clé étrangère ne rattache à la
        // table des comptes : l'ex `itemSharing.forgetItem` + `clearRoute`.
        await ctx.items.forget(input.id);
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
    access: WRITE,
    mutates: true,
    handler: async (ctx, input) => {
        const row = await ctx.repo.accounts.setEnabled(input.id, ctx.workspaceId, input.enabled);
        if (!row) throw new FeatureError('not_found', 'Compte mail introuvable');
        return { account: await toAccountDTO(cipherFor(ctx, row.security_tier), row) };
    }
});

export const mailAccountTestConnectionFeature = defineSdkFeature<
    MailRepo,
    typeof mailAccountTestConnection.command,
    typeof mailAccountTestConnection.input,
    typeof mailAccountTestConnection.output
>({
    ...mailAccountTestConnection,
    access: WRITE,
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
        const account = await loadAccount(ctx, input.id);
        await assertMailUnlocked(ctx, account.security_tier);
        return imapFor(ctx, account, (credentials) =>
            mailClient.testConnection(credentials, refreshCallback(ctx, account, credentials))
        );
    }
});

/**
 * L'entrée du consentement OAuth. Le `state` est un ticket de session du SDK
 * (`ctx.secrecy.ticket`, dix minutes : le temps de choisir un compte chez le
 * fournisseur), qui porte le fournisseur et le palier ; la route de retour
 * (`routes.ts`) le rend contre les codecs de l'appelant et crée le compte sous
 * le bon. L'adresse de retour est celle de l'app (`ctx.origins.app`), la
 * même que celle enregistrée chez le fournisseur.
 */
export const mailOAuthStartFeature = defineSdkFeature<
    MailRepo,
    typeof mailOAuthStart.command,
    typeof mailOAuthStart.input,
    typeof mailOAuthStart.output
>({
    ...mailOAuthStart,
    access: WRITE,
    handler: async (ctx, input) => {
        if (!isOAuthConfigured(input.provider)) {
            throw new FeatureError('validation', `OAuth ${input.provider} n'est pas configuré sur ce serveur`);
        }
        assertTierAllowed(ctx, input.securityTier);
        const state = await ctx.secrecy.ticket(
            { provider: input.provider, securityTier: input.securityTier },
            { ttlSeconds: 600 }
        );
        return { authUrl: buildAuthorizationUrl(input.provider, state, ctx.origins.app) };
    }
});

import {
    passwordAdd,
    passwordCount,
    passwordDelete,
    passwordEdit,
    passwordGet,
    passwordList
} from '../contracts/commands';
import { defineSdkFeature, FeatureError } from '@deveye/types/sdk/server';

import {
    assertUnlocked,
    encryptPayload,
    toEntry,
    toMaskedEntry,
    tryDecryptPayload,
    vaultCipher,
    WRITE,
    type Ctx
} from './_shared';

/**
 * Coffre de mots de passe, scopé à l'espace actif.
 *
 * L'espace vient de l'enveloppe WS et l'appartenance est déjà vérifiée par le
 * dispatcheur : les handlers filtrent simplement sur `ctx.workspaceId`, sans
 * garde ni traduction d'id.
 *
 * Six commandes sous le préfixe `password.`, un verbe simple derrière le
 * point : le filet `MUTATION_VERB` de `_topics.ts` voit `add`, `edit` et
 * `delete`, qui déclarent bien `mutates`. Les trois lectures (`list`, `count`,
 * `get`) n'écrivent rien. L'ancienne `password.unlock` n'existe plus : son
 * registre en mémoire n'avait aucun lecteur, la vraie protection est le
 * chiffrement, et le déverrouillage de session passe par `secrecy.unlock`.
 */
export const passwordHandlers = [
    defineSdkFeature({
        ...passwordList,
        handler: async (ctx: Ctx) => {
            // When password-based encryption is on, listing needs the DEK. Surface a
            // `locked` error (don't silently skip every row) so the client prompts.
            await assertUnlocked(ctx);
            const cipher = vaultCipher(ctx);
            const rows = await ctx.repo.listByWorkspace(ctx.workspaceId);
            // A single undecryptable row (a corrupt blob) must not break
            // the whole list: skip it with a warning instead of failing the feature.
            let skipped = 0;
            const entries = (
                await Promise.all(
                    rows.map(async (r) => {
                        const payload = await tryDecryptPayload(cipher, r.content);
                        if (!payload) {
                            skipped += 1;
                            return null;
                        }
                        return toMaskedEntry(r.id, payload);
                    })
                )
            ).filter((e): e is NonNullable<typeof e> => e !== null);
            if (skipped > 0) {
                ctx.logger.warn({ skipped, total: rows.length }, 'password.list: skipped undecryptable rows');
            }
            return { entries };
        }
    }),
    defineSdkFeature({
        ...passwordCount,
        handler: async (ctx: Ctx) => {
            // Pure row count from clear metadata: no DEK, no unlock gate. This lets
            // the dashboard widget show a number even when the store is locked.
            return { count: await ctx.repo.countByWorkspace(ctx.workspaceId) };
        }
    }),
    defineSdkFeature({
        ...passwordGet,
        handler: async (ctx: Ctx, input) => {
            await assertUnlocked(ctx);
            const row = await ctx.repo.findById(input.passwordId, ctx.workspaceId);
            if (!row) throw new FeatureError('not_found', 'Password not found');
            const payload = await tryDecryptPayload(vaultCipher(ctx), row.content);
            if (!payload) throw new FeatureError('internal', 'Failed to decrypt password content');
            return { entry: toEntry(row.id, payload) };
        }
    }),
    defineSdkFeature({
        ...passwordAdd,
        mutates: true,
        access: WRITE,
        handler: async (ctx: Ctx, input) => {
            await assertUnlocked(ctx);
            const content = await encryptPayload(vaultCipher(ctx), input.entry);
            const row = await ctx.repo.create({
                userId: ctx.userId,
                workspaceId: ctx.workspaceId,
                content
            });
            ctx.audit({
                action: 'password.create',
                description: 'Mot de passe enregistré',
                metadata: { passwordId: row.id }
            });
            return { entry: toEntry(row.id, input.entry) };
        }
    }),
    defineSdkFeature({
        ...passwordEdit,
        mutates: true,
        access: WRITE,
        handler: async (ctx: Ctx, input) => {
            await assertUnlocked(ctx);
            const content = await encryptPayload(vaultCipher(ctx), input.entry);
            const updated = await ctx.repo.update(input.entry.id, ctx.workspaceId, content);
            if (!updated) throw new FeatureError('not_found', 'Password not found');
            ctx.audit({
                action: 'password.edit',
                description: 'Mot de passe modifié',
                metadata: { passwordId: input.entry.id }
            });
            return { entry: toEntry(updated.id, input.entry) };
        }
    }),
    defineSdkFeature({
        ...passwordDelete,
        mutates: true,
        access: WRITE,
        handler: async (ctx: Ctx, input) => {
            const deleted = await ctx.repo.delete(input.passwordId, ctx.workspaceId);
            if (!deleted) throw new FeatureError('not_found', 'Password not found');
            ctx.audit({
                action: 'password.delete',
                level: 'warning',
                description: 'Mot de passe supprimé',
                metadata: { passwordId: input.passwordId }
            });
            return { passwordId: input.passwordId };
        }
    })
];

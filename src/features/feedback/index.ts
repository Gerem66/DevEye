import { feedbackDelete, feedbackList, feedbackSetStatus, feedbackSubmit, FEEDBACK_PAGE_DEFAULT } from '@deveye/types';

import type { FeedbackQueryFilter } from '@/db/repos/feedback';
import { env } from '@/Utils/Env';
import { appVersion } from '@/version';
import { defineFeature, FeatureError, type FeatureContext, type FeatureDefinition } from '../_define';

/**
 * Les signalements. Écrire est ouvert à tout compte connecté, relire ne l'est
 * qu'aux administrateurs : un retour est adressé à celui qui tient le produit,
 * pas aux autres membres. `scope: 'account'` parce qu'un signalement porte sur
 * DevEye et non sur le contenu d'un espace.
 */
const ADMIN = { admin: true, scope: 'account' } as const;

/**
 * Combien de signalements un même compte peut envoyer par heure. Assez haut
 * pour qu'un usage normal ne le voie jamais, assez bas pour qu'un script ne
 * remplisse pas la table.
 */
const HOURLY_LIMIT = 20;

/** Lève si le serveur n'accepte pas les signalements. */
function assertEnabled(): void {
    if (!env.FEEDBACK_ENABLED) {
        throw new FeatureError('forbidden', 'Les signalements sont désactivés sur ce serveur');
    }
}

/** La ligne visée, ou `not_found` : un id inventé ne doit rien apprendre. */
async function loadOr404(ctx: FeatureContext, id: number) {
    const entry = await ctx.db.feedback.findById(id);
    if (!entry) throw new FeatureError('not_found', 'Ce signalement n’existe pas');
    return entry;
}

export const feedbackSubmitFeature: FeatureDefinition<
    typeof feedbackSubmit.command,
    typeof feedbackSubmit.input,
    typeof feedbackSubmit.output
> = defineFeature({
    ...feedbackSubmit,
    // Aucune garde : tout compte connecté peut signaler, c'est le principe.
    // Déclarée dans ACCESS_EXEMPT (`_permissions.ts`), la seule façon de dire
    // que l'absence est voulue. Pas de `scope: 'account'` non plus, à la
    // différence des trois autres : il forcerait l'espace personnel, et
    // l'espace enregistré ne serait plus celui d'où le signalement part.
    handler: async (ctx, input) => {
        assertEnabled();

        const sent = await ctx.db.feedback.countSince(ctx.userId, Math.floor(Date.now() / 1000) - 3600);
        if (sent >= HOURLY_LIMIT) {
            throw new FeatureError('rate_limited', 'Trop de signalements envoyés récemment, réessayez plus tard');
        }

        const message = input.message.trim();
        if (message.length === 0) throw new FeatureError('validation', 'Le message est vide');

        // Un retour libre ne transporte jamais de rapport technique, quoi qu'en
        // dise l'entrée : ce que l'interface annonce est ce qui part.
        const snapshot = input.kind === 'bug' ? input.snapshot : null;

        const id = await ctx.db.feedback.record({
            uid: ctx.userId,
            workspaceId: ctx.workspaceId,
            kind: input.kind,
            message,
            snapshot,
            ip: ctx.ip,
            appVersion: appVersion()
        });

        ctx.audit({
            action: 'feedback.submit',
            level: 'info',
            description: `Signalement envoyé (${input.kind === 'bug' ? 'bug' : 'retour'})`,
            metadata: { feedbackId: id, kind: input.kind, withSnapshot: snapshot !== null }
        });

        return { id };
    }
});

export const feedbackListFeature: FeatureDefinition<
    typeof feedbackList.command,
    typeof feedbackList.input,
    typeof feedbackList.output
> = defineFeature({
    ...feedbackList,
    access: ADMIN,
    handler: async (ctx, input) => {
        const { limit, offset, ...rest } = input;
        // Seuls les champs réellement posés partent au repo : un filtre absent
        // ne doit pas restreindre (et `exactOptionalPropertyTypes` l'exige).
        const filter: FeedbackQueryFilter = {};
        if (rest.kind !== undefined) filter.kind = rest.kind;
        if (rest.status !== undefined) filter.status = rest.status;
        if (rest.uid !== undefined) filter.uid = rest.uid;
        if (rest.search !== undefined) filter.search = rest.search.trim();

        const pageSize = limit ?? FEEDBACK_PAGE_DEFAULT;
        const start = offset ?? 0;
        const { entries, total, pending } = await ctx.db.feedback.query(filter, {
            limit: pageSize,
            offset: start
        });

        return { entries, total, pending, hasMore: start + entries.length < total };
    }
});

export const feedbackSetStatusFeature: FeatureDefinition<
    typeof feedbackSetStatus.command,
    typeof feedbackSetStatus.input,
    typeof feedbackSetStatus.output
> = defineFeature({
    ...feedbackSetStatus,
    access: ADMIN,
    handler: async (ctx, input) => {
        await loadOr404(ctx, input.id);
        await ctx.db.feedback.setStatus(input.id, input.status, ctx.userId);

        const entry = await loadOr404(ctx, input.id);
        ctx.audit({
            action: 'feedback.setStatus',
            level: 'info',
            description: `Signalement #${input.id} passé à « ${input.status} »`,
            metadata: { feedbackId: input.id, status: input.status }
        });
        return { entry };
    }
});

export const feedbackDeleteFeature: FeatureDefinition<
    typeof feedbackDelete.command,
    typeof feedbackDelete.input,
    typeof feedbackDelete.output
> = defineFeature({
    ...feedbackDelete,
    access: ADMIN,
    handler: async (ctx, input) => {
        await loadOr404(ctx, input.id);
        await ctx.db.feedback.remove(input.id);

        ctx.audit({
            action: 'feedback.delete',
            level: 'warning',
            description: `Signalement #${input.id} supprimé`,
            metadata: { feedbackId: input.id }
        });
        return { deleted: true as const };
    }
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const feedbackFeatures: FeatureDefinition<string, any, any>[] = [
    feedbackSubmitFeature,
    feedbackListFeature,
    feedbackSetStatusFeature,
    feedbackDeleteFeature
];

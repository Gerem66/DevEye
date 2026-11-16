import { appStoresListReviews, appStoresReplyReview } from '../contracts/commands';
import { APPSTORES_REPLY_MAX_LENGTH, type AppStoresReview } from '../contracts/domain';
import { defineSdkFeature, FeatureError, type SdkCipher } from '@deveye/types/sdk/server';

import type { ReviewRow } from './repo';
import { replyApple } from './stores/apple';
import { replyGoogle } from './stores/google';
import { openCredentials, storeFailure } from './stores/index';
import { StoreError, type StoreReply } from './stores/types';
import {
    appCipher,
    loadApp,
    loadHomeApp,
    nowSeconds,
    readJson,
    sealJson,
    type Ctx,
    type StoredListing,
    type StoredReview
} from './_shared';

/**
 * Les avis d'une app, et la réponse publique qu'on leur donne. Répondre est un
 * geste, donc sous l'écriture ; il part chez le store avec la clé de la source,
 * qui vit dans l'espace de l'app : une fenêtre projetée lit, elle ne répond pas.
 */

const PAGE_DEFAULT = 25;

const CANNOT_REPLY = {
    apple: 'Cette clé ne permet pas de répondre aux avis : il faut une clé d’API d’équipe au rôle Admin dans App Store Connect.',
    google: 'Ce compte de service ne permet pas de répondre aux avis : donnez-lui la permission « Répondre aux avis » dans la Play Console.'
} as const;

const TOO_LONG = {
    apple: `Une réponse sur l’App Store tient en ${APPSTORES_REPLY_MAX_LENGTH.apple} caractères au plus.`,
    google: `Une réponse sur Google Play tient en ${APPSTORES_REPLY_MAX_LENGTH.google} caractères au plus.`
} as const;

const GONE = 'Cet avis n’existe plus chez le store : il disparaîtra à la prochaine synchronisation.';

/** L'app d'un avis, pour `access.item` : elle seule décide, jamais un identifiant passé à côté. */
export const appOfReview = async (ctx: Ctx, input: { reviewId: number }) =>
    (await ctx.repo.findReview(input.reviewId))?.app_id;

function reviewDto(row: ReviewRow, stored: Partial<StoredReview> | null): AppStoresReview {
    const reply = stored?.reply;
    return {
        id: row.id,
        store: row.store,
        rating: Math.min(5, Math.max(1, Number(row.rating))),
        title: stored?.title ?? '',
        body: stored?.body ?? '',
        author: stored?.author ?? '',
        territory: stored?.territory ?? null,
        appVersion: stored?.appVersion ?? null,
        createdAt: Number(row.created_at),
        reply: reply
            ? {
                  body: reply.body,
                  at: reply.at ?? (row.replied_at === null ? null : Number(row.replied_at)),
                  state: reply.state
              }
            : null
    };
}

export async function toReview(cipher: SdkCipher, row: ReviewRow): Promise<AppStoresReview> {
    return reviewDto(row, await readJson<Partial<StoredReview>>(cipher, row.content));
}

export const appStoresReviewFeatures = [
    defineSdkFeature({
        ...appStoresListReviews,
        access: { item: 'appId' },
        handler: async (ctx: Ctx, input) => {
            await loadApp(ctx, input.appId);
            const limit = input.limit ?? PAGE_DEFAULT;
            const rows = await ctx.repo.listReviews(
                input.appId,
                { store: input.store, rating: input.rating, unanswered: input.unanswered, before: input.before },
                limit + 1
            );
            const cipher = await appCipher(ctx, input.appId);
            return {
                reviews: await Promise.all(rows.slice(0, limit).map((row) => toReview(cipher, row))),
                hasMore: rows.length > limit
            };
        }
    }),
    defineSdkFeature({
        ...appStoresReplyReview,
        access: { level: 'write', item: appOfReview },
        mutates: true,
        handler: async (ctx: Ctx, input) => {
            const review = await ctx.repo.findReview(input.reviewId);
            if (!review) throw new FeatureError('not_found', 'Avis introuvable');
            // L'app vient de l'avis, et se règle chez elle : sa clé y vit.
            const app = await loadHomeApp(ctx, review.app_id);
            await ctx.quota.assertActive('apps', String(app.id));
            if (input.body.length > APPSTORES_REPLY_MAX_LENGTH[review.store]) {
                throw new FeatureError('validation', TOO_LONG[review.store]);
            }

            const cipher = ctx.cipher();
            const listing = (await ctx.repo.listListingsOfApps([app.id])).find((l) => l.store === review.store);
            const source =
                listing && listing.source_id !== null
                    ? await ctx.repo.findSource(listing.source_id, ctx.workspaceId)
                    : null;
            const opened = source ? await openCredentials(cipher, source) : null;
            if (!listing || !opened) {
                throw new FeatureError(
                    'validation',
                    'Cette fiche n’a pas de source qui se lise : choisissez-en une dans les réglages de l’app pour répondre.'
                );
            }
            const stored = await readJson<StoredReview>(cipher, review.content);
            const appId = (await readJson<Partial<StoredListing>>(cipher, listing.content))?.externalId;
            if (!stored?.externalId || !appId) {
                throw new FeatureError(
                    'validation',
                    'Cet avis ne se lit plus : il sera relu à la prochaine synchronisation.'
                );
            }

            ctx.progress({
                step: review.store === 'apple' ? 'Envoi de la réponse à Apple' : 'Envoi de la réponse à Google'
            });
            let reply: StoreReply;
            try {
                reply =
                    opened.credentials.store === 'apple'
                        ? await replyApple(
                              opened.credentials.creds,
                              stored.externalId,
                              input.body,
                              stored.reply?.responseId ?? null
                          )
                        : await replyGoogle(opened.credentials.creds, appId, stored.externalId, input.body);
            } catch (e) {
                if (e instanceof StoreError && e.status === 403)
                    throw new FeatureError('conflict', CANNOT_REPLY[e.store]);
                if (e instanceof StoreError && e.status === 404) throw new FeatureError('conflict', GONE);
                storeFailure(e, 'conflict');
            }

            const next: StoredReview = { ...stored, reply };
            const repliedAt = reply.at ?? nowSeconds();
            await ctx.repo.updateReview(review.id, {
                rating: Number(review.rating),
                repliedAt,
                content: await sealJson(cipher, next)
            });
            ctx.audit({
                action: 'appstores.replyReview',
                description:
                    review.store === 'apple' ? 'Réponse publiée sur l’App Store' : 'Réponse publiée sur Google Play',
                metadata: { appId: app.id, reviewId: review.id, store: review.store }
            });
            return { review: reviewDto({ ...review, replied_at: repliedAt }, next) };
        }
    })
];

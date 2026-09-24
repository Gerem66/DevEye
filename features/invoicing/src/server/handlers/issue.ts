import { defineSdkFeature, FeatureError } from '@deveye/types/sdk/server';

import { invoicingDocIssue, invoicingDocStatus } from '../../contracts/commands';
import { addDays, dueDateOf, leavesAnswerTime, startOfMonth } from '../../contracts/calendar';
import { formatDate } from '../../contracts/display';
import { documentTotals } from '../../contracts/money';
import {
    invoicingClientContentSchema,
    type DocumentKind,
    type InvoicingClientContent,
    type InvoicingSettings,
    type VatRegime
} from '../../contracts/domain';
import {
    clientError,
    now,
    openJson,
    seal,
    settingsError,
    publicOriginOf,
    settingsOf,
    today,
    WRITE,
    type Ctx,
    docOr404,
    assertClient
} from '../_shared';
import { issuerGaps, listGaps } from '../../contracts/issuer';
import { reserveNumber } from '../numbering';
import { newToken } from '../service';
import { QUOTA_KEYS } from '../planUsage';
import { toDoc, toLine } from '../views';

/**
 * L'émission, et elle seule. Cinq refus avant d'écrire quoi que ce soit, parce
 * qu'un document émis ne se reprend pas : il se corrige par un avoir.
 */

/** Jusqu'où une date d'émission peut remonter : un mois, pas davantage. */
const BACKDATE_DAYS = 31;

/** La règle est dans les contrats, partagée avec l'écran qui prévient avant. */
function assertIssuer(settings: InvoicingSettings): void {
    const gaps = issuerGaps(settings.issuer);
    if (gaps.length === 0) return;
    throw settingsError(
        'validation',
        `Il manque ${listGaps(gaps)} de l’émetteur : ce sont des mentions obligatoires.`,
        'general'
    );
}

export const docIssue = defineSdkFeature({
    ...invoicingDocIssue,
    access: { ...WRITE, extras: ['issue'] },
    mutates: true,
    handler: async (ctx: Ctx, input) => {
        const row = await docOr404(ctx, input.id);
        await assertClient(ctx, row.client_id, 'write');
        if (row.status !== 'draft') {
            throw new FeatureError('conflict', 'Ce document est déjà émis : son numéro et son contenu sont figés.');
        }

        const settings = await settingsOf(ctx);
        assertIssuer(settings);

        if (row.client_id === null) {
            throw new FeatureError('validation', 'Choisissez le client de ce document avant de l’émettre.');
        }
        const clientRow = await ctx.repo.findClient(row.client_id, ctx.workspaceId);
        if (clientRow === null) {
            throw new FeatureError('validation', 'Le client de ce document n’existe plus : choisissez-en un autre.');
        }
        const client = await openJson<InvoicingClientContent | null>(
            ctx,
            clientRow.content,
            invoicingClientContentSchema,
            null
        );
        if (client === null || client.name.trim().length === 0) {
            throw clientError('validation', 'Le client de ce document n’a pas de nom : complétez sa fiche.');
        }

        const lineRows = await ctx.repo.listLines([row.id], ctx.workspaceId);
        const lines = await Promise.all(lineRows.map((line) => toLine(ctx, line, settings.vatRegime)));
        if (lines.some((line) => line.kind !== 'text' && line.label.trim().length === 0)) {
            throw new FeatureError('validation', 'Une ligne est sans désignation : complétez-la avant d’émettre.');
        }
        const totals = documentTotals(
            lines.map((line) => ({
                kind: line.kind,
                quantityMilli: line.quantityMilli,
                unitPrice: line.unitPrice,
                vatRateBp: line.vatRateBp
            }))
        );
        if (totals.grossCents <= 0) {
            throw new FeatureError('validation', 'Ce document est à zéro : ajoutez au moins une ligne à facturer.');
        }

        const day = today(settings);
        const issuedOn = input.issuedOn ?? day;
        if (issuedOn > day) {
            throw new FeatureError('validation', 'Un document ne s’émet pas à une date future.');
        }
        if (issuedOn < addDays(day, -BACKDATE_DAYS)) {
            throw new FeatureError('validation', 'Une date d’émission ne peut pas remonter à plus d’un mois.');
        }

        const kind = row.kind as DocumentKind;

        const termsDays = clientRow.payment_terms_days ?? settings.paymentTermsDays;
        const dueOn = kind === 'quote' ? null : (row.due_on ?? dueDateOf(issuedOn, termsDays));
        const validUntil =
            kind === 'quote' ? (row.valid_until ?? dueDateOf(issuedOn, settings.quoteValidityDays)) : null;

        // Avant la réservation du rang : un brouillon numéroté ne se supprime plus.
        // La règle porte sur la date résolue, donc couvre aussi celle qui vient
        // des réglages quand l'émission est antidatée.
        if (kind === 'quote' && validUntil !== null && !leavesAnswerTime(validUntil, day)) {
            if (row.valid_until !== null) {
                throw new FeatureError(
                    'validation',
                    `Ce devis n’est valable que jusqu’au ${formatDate(validUntil)} : repoussez la date « Valable jusqu’au », votre client doit avoir le temps de répondre.`
                );
            }
            throw settingsError(
                'validation',
                `Avec une validité de ${settings.quoteValidityDays} jours, ce devis naîtrait déjà expiré : allongez ce délai, ou fixez vous-même sa date « Valable jusqu’au ».`,
                'wording'
            );
        }
        if (dueOn !== null && dueOn < issuedOn) {
            throw new FeatureError(
                'validation',
                'L’échéance de ce document précède sa date d’émission : rien ne peut être à payer avant d’être émis.'
            );
        }

        // Le quota compte les pièces de CE type émises ce mois-ci sur tous les
        // espaces du propriétaire, et il est demandé AVANT la réservation du
        // rang : un refus ne doit pas consommer de numéro. Un avoir n'est borné
        // par rien : corriger une erreur n'est pas facturer.
        if (kind !== 'credit') {
            await ctx.quota.assert(
                QUOTA_KEYS[kind],
                async (ownerWorkspaceIds) =>
                    (await ctx.repo.countIssuedSince(ownerWorkspaceIds, startOfMonth(issuedOn), kind)) + 1
            );
        }

        const reserved = await reserveNumber(ctx, row, settings, issuedOn);

        // Un rang plus grand ne peut pas porter une date antérieure : la suite
        // doit se lire dans l'ordre du temps comme dans celui des numéros.
        const last = await ctx.repo.lastIssuedOn(ctx.workspaceId, row.kind, reserved.seqYear);
        if (last !== null && issuedOn < last) {
            throw new FeatureError(
                'conflict',
                `Le dernier document de cette suite est daté du ${last} : une date antérieure ouvrirait une suite incohérente.`
            );
        }

        const at = now();
        const issued = await ctx.repo.issueDoc(row.id, ctx.workspaceId, {
            status: kind === 'quote' ? 'sent' : 'issued',
            // Le régime se fige ici, et non à la création du brouillon : c'est
            // l'émission qui engage, et c'est le réglage de ce jour-là qui vaut.
            vat_regime: settings.vatRegime,
            issued_on: issuedOn,
            due_on: dueOn,
            valid_until: validUntil,
            total_net: totals.netCents,
            total_vat: totals.vatCents,
            total_gross: totals.grossCents,
            // L'instantané : renommer un client ou déménager ne doit pas
            // réécrire un document déjà émis.
            issuer_snapshot: await seal(ctx, settings.issuer),
            client_snapshot: await seal(ctx, client),
            issued_by: ctx.userId,
            updated: at
        });
        if (issued === 0) {
            throw new FeatureError('conflict', 'Ce document vient d’être émis ailleurs.');
        }
        const after0 = await docOr404(ctx, row.id);

        // Le lien du client naît avec le document : c'est par lui qu'il est remis,
        // et le faire naître d'un clic séparé revenait à cacher le canal
        // principal derrière un geste. Il reste révocable.
        if (after0.public_token === null) {
            await ctx.repo.setToken(row.id, ctx.workspaceId, newToken());
        }

        await ctx.repo.freezeLines(
            row.id,
            ctx.workspaceId,
            lines.map((line) => ({ id: line.id, net: line.netCents, vatBp: line.vatRateBp }))
        );

        // Un avoir qui couvre sa facture l'annule : c'est la seule voie, et elle
        // passe par une transition gardée comme les autres.
        if (kind === 'credit' && row.parent_doc_id !== null) {
            const parent = await ctx.repo.findDoc(row.parent_doc_id, ctx.workspaceId);
            if (parent !== null && parent.status === 'issued') {
                const settled = (await ctx.repo.settledOf([parent.id], ctx.workspaceId)).get(parent.id);
                if ((settled?.creditedCents ?? 0) >= (parent.total_gross ?? 0)) {
                    await ctx.repo.setStatus(parent.id, ctx.workspaceId, 'issued', 'cancelled', at);
                }
            }
        }

        ctx.audit({
            action: 'invoicing.issue',
            description: `Document ${reserved.label} émis`,
            metadata: { id: row.id, number: reserved.label }
        });

        const after = await docOr404(ctx, row.id);
        const settled = await ctx.repo.settledOf([after.id], ctx.workspaceId);
        const parentNumbers = await ctx.repo.numbersOf(
            after.parent_doc_id === null ? [] : [after.parent_doc_id],
            ctx.workspaceId
        );
        const freshLines = await Promise.all(
            (await ctx.repo.listLines([after.id], ctx.workspaceId)).map((line) =>
                toLine(ctx, line, after.vat_regime as VatRegime)
            )
        );
        return {
            doc: await toDoc(ctx, after, freshLines, {
                today: day,
                vatRegime: settings.vatRegime,
                publicOrigin: await publicOriginOf(ctx, settings),
                clientNames: new Map([[clientRow.id, client.name]]),
                settled,
                parentNumbers
            })
        };
    }
});

/** La suite d'un devis. Une facture, elle, ne change pas d'état à la main. */
export const docStatus = defineSdkFeature({
    ...invoicingDocStatus,
    access: WRITE,
    mutates: true,
    handler: async (ctx: Ctx, input) => {
        const row = await docOr404(ctx, input.id);
        await assertClient(ctx, row.client_id, 'write');
        if (row.kind !== 'quote') {
            throw new FeatureError(
                'conflict',
                'Seul un devis change d’état à la main : une facture suit ses règlements, et s’annule par un avoir.'
            );
        }

        if (row.status === 'draft') {
            throw new FeatureError('conflict', 'Ce devis n’est pas encore envoyé : émettez-le d’abord.');
        }

        const at = now();
        const touched = await ctx.repo.setStatus(row.id, ctx.workspaceId, row.status, input.status, at);
        if (touched === 0) {
            // Rejeu ou double clic : quand le résultat voulu est déjà là, c'est
            // un succès, pas un conflit.
            const current = await docOr404(ctx, row.id);
            if (current.status !== input.status) {
                throw new FeatureError(
                    'conflict',
                    'L’état de ce devis a changé entre-temps : rouvrez-le pour voir où il en est.'
                );
            }
        }

        const after = await docOr404(ctx, row.id);
        const settings = await settingsOf(ctx);
        const settled = await ctx.repo.settledOf([after.id], ctx.workspaceId);
        const lines = await Promise.all(
            (await ctx.repo.listLines([after.id], ctx.workspaceId)).map((line) =>
                toLine(ctx, line, after.vat_regime as VatRegime)
            )
        );
        return {
            doc: await toDoc(ctx, after, lines, {
                today: today(settings),
                vatRegime: settings.vatRegime,
                publicOrigin: await publicOriginOf(ctx, settings),
                clientNames: new Map(),
                settled,
                parentNumbers: new Map()
            })
        };
    }
});

export const issueHandlers = [docIssue, docStatus];

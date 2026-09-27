import { defineSdkFeature, FeatureError } from '@deveye/types/sdk/server';
import { MAIL_TRANSPORT_PROVIDER, type MailTransportProvider } from '@deveye/types/sdk';

import { invoicingSend, invoicingMailAccounts } from '../../contracts/commands';
import { kindLabel } from '../../contracts/display';
import { invoicingClientContentSchema, type DocumentKind } from '../../contracts/domain';
import { documentMail } from '../documentMail';
import { paperInputOf } from '../paperInput';
import {
    assertClient,
    clientError,
    docOr404,
    now,
    publicOriginOf,
    settingsError,
    settingsOf,
    WRITE,
    type Ctx
} from '../_shared';

/**
 * L'envoi au client. Le document part **en HTML dans le corps du message**, avec
 * le lien vers sa page : le PDF n'existe que dans le navigateur de
 * l'utilisateur, et une vraie pièce jointe demanderait un moteur de rendu
 * navigateur côté serveur. C'est ce que font Stripe et Qonto, et le lien vaut
 * mieux qu'une pièce jointe pour un devis, qui s'accepte d'un clic.
 *
 * Sans module Mail installé ou sans compte prêt, la commande refuse avec sa
 * raison : un fournisseur absent se dégrade, il ne se suppose pas.
 */

function transportOf(ctx: Ctx): MailTransportProvider {
    const transport = ctx.providers.get<MailTransportProvider>(MAIL_TRANSPORT_PROVIDER);
    if (transport === undefined) {
        throw new FeatureError(
            'conflict',
            'Aucun module Mail n’est installé sur ce DevEye : le document se télécharge et s’envoie à la main.'
        );
    }
    return transport;
}

export const senders = defineSdkFeature({
    ...invoicingMailAccounts,
    handler: async (ctx: Ctx) => {
        const accounts = await ctx.deveye.mail.listAccounts();
        return {
            senders: accounts.map((account) => ({
                id: account.id,
                label: account.label,
                address: account.address ?? ''
            }))
        };
    }
});

export const send = defineSdkFeature({
    ...invoicingSend,
    access: WRITE,
    mutates: true,
    handler: async (ctx: Ctx, input) => {
        const row = await docOr404(ctx, input.id);
        await assertClient(ctx, row.client_id, 'write');
        if (row.status === 'draft') {
            throw new FeatureError('conflict', 'Un brouillon ne s’envoie pas : émettez-le d’abord.');
        }

        const settings = await settingsOf(ctx);
        if (settings.mailSenderId === null) {
            throw settingsError(
                'conflict',
                'Aucun expéditeur choisi : il faut dire quel compte mail expédie vos documents.',
                'general'
            );
        }

        const transport = transportOf(ctx);
        if (!(await transport.isReady(settings.mailSenderId, ctx.workspaceId))) {
            throw settingsError(
                'conflict',
                'Le compte mail choisi n’est pas prêt à expédier : vérifiez-le, ou choisissez-en un autre.',
                'general'
            );
        }

        let to = input.to.trim();
        if (to.length === 0 && row.client_id !== null) {
            const clientRow = await ctx.repo.findClient(row.client_id, ctx.workspaceId);
            if (clientRow !== null) {
                const plain = await ctx.cipher().tryDecrypt(clientRow.content);
                const parsed = plain === null ? null : invoicingClientContentSchema.safeParse(JSON.parse(plain));
                if (parsed?.success) to = parsed.data.email.trim();
            }
        }
        if (to.length === 0) {
            throw clientError('validation', 'Ce client n’a pas d’adresse e-mail : complétez sa fiche.');
        }

        const paper = await paperInputOf(ctx, row);
        // Le lien n'est ajouté que s'il existe déjà : l'envoi ne crée pas de
        // porte publique à l'insu de qui l'expédie.
        const url =
            row.public_token === null
                ? null
                : `${await publicOriginOf(ctx, settings)}/f/${encodeURIComponent(row.public_token)}`;
        const title = `${kindLabel(row.kind as DocumentKind)} ${row.number_label ?? ''}`.trim();

        const sent = await transport.send(settings.mailSenderId, ctx.workspaceId, {
            to,
            ...documentMail({ paper, url, message: input.message })
        });

        if (sent) await ctx.repo.markSent(row.id, ctx.workspaceId, now());
        ctx.audit({
            action: 'invoicing.send',
            description: `${title} ${sent ? 'envoyé' : 'non envoyé'} à ${to}`,
            level: sent ? undefined : 'warning'
        });
        return { sent, to };
    }
});

export const sendHandlers = [senders, send];

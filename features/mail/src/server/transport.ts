import type { MailSender, MailTransportProvider } from '@deveye/types/sdk';
import { logFailure, type FeatureServiceDeps } from '@deveye/types/sdk/server';

import type { MailAccountRow } from '../contracts/domain';
import * as mailClient from './client';
import type { MailRepo } from './repo';
import { decryptCredentials, isOwnerSideMailError, persistRefreshedToken } from './_shared';

/**
 * Le transport des alertes e-mail des autres features
 * (`MAIL_TRANSPORT_PROVIDER`), publié par le service du module. Sans module,
 * l'app n'a pas de canal e-mail prêt, et l'écran des canaux le dit.
 *
 * Un expéditeur est un compte ouvert et actif, visible de l'espace : un compte
 * gardé exige un déverrouillage que l'ordonnanceur de fond n'a jamais, et un
 * compte en pause, qu'elle vienne de l'utilisateur ou de l'offre, ne doit pas
 * partir tout seul. Tout se lit sous le codec ouvert
 * du domicile du compte, sans session : un compte projeté reste chiffré sous la
 * clé de son espace d'origine, et le lire sous celle de l'espace du canal le
 * ferait passer pour muet.
 *
 * `send` ne lève jamais : `false` et une ligne de journal, l'appelant étant une
 * boucle de fond qui a seulement besoin de savoir si ce canal a accepté.
 */

/** Ce que la livraison demande au client : l'envoi, et rien d'autre. */
export type TransportClient = Pick<typeof mailClient, 'sendMail'>;

export function createMailTransport(
    deps: FeatureServiceDeps<MailRepo>,
    client: TransportClient = mailClient
): MailTransportProvider {
    const isReadySender = (row: MailAccountRow | null): row is MailAccountRow =>
        row !== null &&
        row.enabled === 1 &&
        row.security_tier === 'open' &&
        !deps.pauses.isPaused('accounts', String(row.id));
    const senderOf = async (row: MailAccountRow): Promise<MailSender | null> => {
        const cipher = deps.cipherFor(row.workspace_id);
        const address = await cipher.tryDecrypt(row.email_address_enc);
        // Sans adresse lisible, rien ne peut partir de ce compte : il ne
        // figure pas parmi les expéditeurs plutôt que d'y figurer inerte.
        if (!address) return null;
        const label = (await cipher.tryDecrypt(row.display_name_enc)) ?? `Compte ${row.id}`;
        return { id: row.id, label, address };
    };

    return {
        async listSenders(workspaceId) {
            const rows = await deps.repo.accounts.listVisible(workspaceId);
            const senders = await Promise.all(rows.filter(isReadySender).map(senderOf));
            return senders.filter((s): s is MailSender => s !== null);
        },
        async isReady(accountId, workspaceId) {
            return isReadySender(await deps.repo.accounts.findVisible(accountId, workspaceId));
        },
        async send(accountId, workspaceId, message) {
            const row = await deps.repo.accounts.findVisible(accountId, workspaceId);
            if (!isReadySender(row)) return false;
            try {
                const sender = await senderOf(row);
                if (!sender) return false;
                const cipher = deps.cipherFor(row.workspace_id);
                const credentials = await decryptCredentials(cipher, row.credentials_enc);
                await client.sendMail(
                    credentials,
                    {
                        from: sender.address,
                        to: [{ name: null, address: message.to }],
                        subject: message.subject,
                        text: message.text,
                        // Ajoutés seulement s'ils existent : un appelant qui
                        // n'envoie que du texte doit produire exactement le
                        // même message qu'avant.
                        ...(message.html === undefined ? {} : { html: message.html }),
                        ...(message.attachments === undefined
                            ? {}
                            : {
                                  attachments: message.attachments.map((a) => ({
                                      filename: a.filename,
                                      contentType: a.contentType,
                                      content: Buffer.from(a.content)
                                  }))
                              })
                    },
                    persistRefreshedToken(deps.repo, row.id, credentials, cipher)
                );
                return true;
            } catch (e) {
                logFailure(
                    deps.logger,
                    isOwnerSideMailError(e),
                    { err: e instanceof Error ? e.message : String(e), accountId, workspaceId },
                    'Alert mail failed',
                    'error'
                );
                return false;
            }
        }
    };
}

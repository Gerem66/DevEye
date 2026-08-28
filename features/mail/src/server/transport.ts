import type { MailSender, MailTransportProvider } from '@deveye/types/sdk';
import type { FeatureServiceDeps } from '@deveye/types/sdk/server';

import type { MailAccountRow } from '../contracts/domain';
import * as mailClient from './client';
import type { MailRepo } from './repo';
import { decryptCredentials, persistRefreshedToken } from './_shared';

/**
 * Le transport des alertes e-mail des autres features (`MAIL_TRANSPORT_PROVIDER`),
 * publié par le service du module : ce que `Services/notifications.ts` de
 * l'app demandait directement à la table `mail_accounts` et au client IMAP
 * quand Mail était native (`readyMailAccount`, `decryptCredentials`,
 * `sendMail`), inversé en contrat. Sans module, l'app n'a pas de canal e-mail
 * prêt, et l'écran des canaux le dit.
 *
 * Un expéditeur est un compte **ouvert et actif** de l'espace : un compte gardé
 * exige un déverrouillage que l'ordonnanceur de fond n'a jamais, et un compte
 * en pause ne doit pas partir tout seul. Tout se lit sous le codec ouvert de
 * l'espace (`deps.cipherFor`), sans session.
 *
 * `send` ne lève jamais : `false` et une ligne de journal, parce que l'appelant
 * est une boucle de fond (la livraison d'une alerte) qui n'a rien à faire
 * d'une exception, seulement à savoir si ce canal a accepté.
 */

/** Ce que la livraison demande au client : l'envoi, et rien d'autre. */
export type TransportClient = Pick<typeof mailClient, 'sendMail'>;

function isReadySender(row: MailAccountRow | null): row is MailAccountRow {
    return row !== null && row.enabled === 1 && row.security_tier === 'open';
}

export function createMailTransport(
    deps: FeatureServiceDeps<MailRepo>,
    client: TransportClient = mailClient
): MailTransportProvider {
    const senderOf = async (row: MailAccountRow, workspaceId: number): Promise<MailSender | null> => {
        const cipher = deps.cipherFor(workspaceId);
        const address = await cipher.tryDecrypt(row.email_address_enc);
        // Sans adresse lisible, rien ne peut partir de ce compte : il ne
        // figure pas parmi les expéditeurs plutôt que d'y figurer inerte.
        if (!address) return null;
        const label = (await cipher.tryDecrypt(row.display_name_enc)) ?? `Compte ${row.id}`;
        return { id: row.id, label, address };
    };

    return {
        async listSenders(workspaceId) {
            const rows = await deps.repo.accounts.listByWorkspace(workspaceId);
            const senders = await Promise.all(rows.filter(isReadySender).map((row) => senderOf(row, workspaceId)));
            return senders.filter((s): s is MailSender => s !== null);
        },
        async isReady(accountId, workspaceId) {
            return isReadySender(await deps.repo.accounts.findById(accountId, workspaceId));
        },
        async send(accountId, workspaceId, message) {
            const row = await deps.repo.accounts.findById(accountId, workspaceId);
            if (!isReadySender(row)) return false;
            try {
                const sender = await senderOf(row, workspaceId);
                if (!sender) return false;
                const cipher = deps.cipherFor(workspaceId);
                const credentials = await decryptCredentials(cipher, row.credentials_enc);
                await client.sendMail(
                    credentials,
                    {
                        from: sender.address,
                        to: [{ name: null, address: message.to }],
                        subject: message.subject,
                        text: message.text
                    },
                    persistRefreshedToken(deps.repo, row.id, credentials, cipher)
                );
                return true;
            } catch (e) {
                deps.logger.error(
                    { err: e instanceof Error ? e.message : String(e), accountId, workspaceId },
                    'Alert mail failed'
                );
                return false;
            }
        }
    };
}

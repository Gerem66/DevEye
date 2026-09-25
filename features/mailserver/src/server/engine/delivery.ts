import type { SdkFleetDomains, SdkPlanPauses } from '@deveye/types/sdk/server';

import type { AuthVerdict } from '../../contracts/domain';
import { isServing, now } from '../_shared';
import type { MailboxRow, MailserverRepo } from '../repo';
import type { EventRecorder } from './events';
import type { MailStore } from './mailstore';

/** La remise d'un message dans une boîte d'ici, qu'il arrive du réseau ou de la file d'envoi. */

export interface Verdicts {
    spf: AuthVerdict;
    dkim: AuthVerdict;
    dmarc: AuthVerdict;
}

export const NO_VERDICTS: Verdicts = { spf: 'none', dkim: 'none', dmarc: 'none' };

export interface Delivery {
    /** La boîte qu'une adresse désigne, ou `null` : domaine inconnu ou pas vérifié, boîte absente, éteinte ou en pause. */
    resolve(address: string): Promise<MailboxRow | null>;
    /** Lève `OverQuotaError` quand la boîte est pleine. */
    deliver(
        mailbox: MailboxRow,
        raw: Buffer,
        options: { from: string; verdicts: Verdicts; junk: boolean }
    ): Promise<void>;
}

export function createDelivery(deps: {
    repo: MailserverRepo;
    domains: SdkFleetDomains;
    pauses: SdkPlanPauses;
    store: MailStore;
    events: EventRecorder;
}): Delivery {
    return {
        async resolve(address) {
            const at = address.lastIndexOf('@');
            if (at <= 0) return null;
            // `prenom+liste@…` arrive chez `prenom`.
            const local = address.slice(0, at).toLowerCase().split('+')[0];
            const host = address.slice(at + 1).toLowerCase();
            const domain = await deps.domains.findByHost(host);
            if (!domain?.verified) return null;
            const mailbox = await deps.repo.findByAddress(`${local}@${domain.host}`);
            // Le domaine doit être celui de l'espace de la boîte : un nom redéclaré ailleurs ne lui amène pas son courrier.
            if (!mailbox || !isServing(mailbox, deps.pauses) || mailbox.workspace_id !== domain.workspaceId) {
                return null;
            }
            return mailbox;
        },

        async deliver(mailbox, raw, options) {
            const folder =
                (options.junk ? await deps.repo.findFolder(mailbox.id, 'Junk') : null) ??
                (await deps.repo.findFolder(mailbox.id, 'INBOX'));
            if (!folder) throw new Error(`La boîte ${mailbox.id} n’a pas de dossier de réception`);
            await deps.store.append(mailbox, folder, raw, { internalDate: now() });
            await deps.repo.touchDelivery(mailbox.id, now());
            await deps.events.record(mailbox, {
                kind: options.junk ? 'junked' : 'received',
                size: raw.length,
                ...options.verdicts,
                peer: options.from
            });
        }
    };
}

import type { MailserverClientProvider } from '@deveye/types/sdk/client';

import AccessPanel from './AccessPanel';
import { api } from './api';

/**
 * Ce que le module offre à Mail (`MAILSERVER_CLIENT_PROVIDER`) : savoir si une
 * adresse est hébergée ici, et l'onglet Accès de sa boîte, que Mail monte dans
 * les réglages du compte qui la lit. Sans droit de lecture sur le Serveur
 * mail, la liste refuse et Mail ne propose rien.
 */
export const clientProvider: MailserverClientProvider = {
    findByAddress: async (address) => {
        const wanted = address.trim().toLowerCase();
        const held = (await api.send('mailserver.list', {})).mailboxes.find(
            (mailbox) => mailbox.address.toLowerCase() === wanted
        );
        return held ? { id: held.id } : null;
    },
    AccessPanel
};

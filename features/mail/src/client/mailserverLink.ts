import { moduleClientProvider } from 'deveye-sdk-client';
import { MAILSERVER_CLIENT_PROVIDER } from '@deveye/types/sdk';
import type { MailserverClientProvider } from '@deveye/types/sdk/client';

import { api } from './api';

/** Le Serveur mail, s'il est installé et visible : joint par son contrat client, jamais importé. */
export function mailserver(): MailserverClientProvider | undefined {
    return moduleClientProvider<MailserverClientProvider>(MAILSERVER_CLIENT_PROVIDER);
}

export interface HostedMailbox {
    id: number;
    address: string;
}

/**
 * La boîte du Serveur mail qui héberge l'adresse d'un compte Mail, ou `null` :
 * module absent, adresse d'ailleurs, compte verrouillé (son adresse ne se lit
 * pas), ou Serveur mail illisible d'ici, où l'on ne propose rien plutôt que de
 * proposer à tort.
 */
export async function hostedMailboxOf(accountId: number): Promise<HostedMailbox | null> {
    const server = mailserver();
    if (!server) return null;
    const account = (await api.send('mail.accountList', {})).accounts.find((a) => a.id === accountId);
    if (!account || account.emailAddress === '') return null;
    try {
        const held = await server.findByAddress(account.emailAddress);
        return held ? { id: held.id, address: account.emailAddress } : null;
    } catch {
        return null;
    }
}

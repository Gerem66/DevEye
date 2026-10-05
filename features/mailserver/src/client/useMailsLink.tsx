import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { humanizeError, moduleClientProvider, openFeature, useResourceVersion } from 'deveye-sdk-client';
import { MAIL_CLIENT_PROVIDER } from '@deveye/types/sdk';
import type { MailAccountPrefill, MailClientProvider } from '@deveye/types/sdk/client';

import type { Connection, Mailbox } from '../contracts/domain';
import { api } from './api';

/**
 * Le lien entre une adresse hébergée ici et son compte dans Mail. Mail est
 * joint par son contrat client, jamais importé : sans le module, rien n'est
 * proposé.
 *
 * Ajouter crée un mot de passe d'application réservé à Mail, puis ouvre SON
 * formulaire prérempli. Aucun mot de passe n'est conservé en clair pour cela,
 * et fermer le formulaire sans enregistrer révoque celui qu'on vient de créer.
 */
export interface MailsLink {
    /** Mail est installé et le serveur a un nom : le geste a un sens. */
    available: boolean;
    /** Le compte Mail qui tient cette adresse ; `undefined` tant qu'on ne sait pas. */
    linkedId: number | null | undefined;
    busy: boolean;
    error: string | null;
    add(): void;
    open(): void;
    /** Le formulaire de Mail, à monter là où vit le bouton. */
    dialog: ReactNode;
}

export function useMailsLink(mailbox: Mailbox, connection: Connection | null): MailsLink {
    const mails = moduleClientProvider<MailClientProvider>(MAIL_CLIENT_PROVIDER);
    const accountsVersion = useResourceVersion('mail.accountList');
    const [linkedId, setLinkedId] = useState<number | null | undefined>(undefined);
    const [pending, setPending] = useState<{ prefill: MailAccountPrefill; credentialId: number } | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const lookup = useCallback(async () => {
        if (!mails) return setLinkedId(null);
        try {
            setLinkedId((await mails.findByAddress(mailbox.address))?.id ?? null);
        } catch {
            // Mail illisible d'ici (droit absent) : on ne propose rien plutôt que de proposer à tort.
            setLinkedId(undefined);
        }
    }, [mails, mailbox.address]);

    useEffect(() => {
        void lookup();
    }, [lookup, accountsVersion]);

    const add = () => {
        if (!connection || busy) return;
        setBusy(true);
        setError(null);
        api.send('mailserver.appPasswordCreate', { id: mailbox.id, label: 'Mail DevEye', forMails: true })
            .then((res) => {
                const login = { username: mailbox.address, password: res.secret };
                setPending({
                    credentialId: res.credential.id,
                    prefill: {
                        displayName: mailbox.displayName || mailbox.address,
                        emailAddress: mailbox.address,
                        imap: { host: connection.host, port: connection.imapPort, ...login },
                        smtp: { host: connection.host, port: connection.smtpPort, ...login }
                    }
                });
            })
            .catch((failure: unknown) => setError(humanizeError(failure, 'Le lien avec Mail n’a pas pu être préparé.')))
            .finally(() => setBusy(false));
    };

    const Dialog = mails?.AccountDialog;
    return {
        available: mails !== undefined && connection !== null,
        linkedId,
        busy,
        error,
        add,
        open: () => {
            if (typeof linkedId === 'number') openFeature('mail', linkedId);
        },
        dialog:
            Dialog && pending ? (
                <Dialog
                    open
                    prefill={pending.prefill}
                    onSaved={() => {
                        setPending(null);
                        void lookup();
                    }}
                    onClose={() => {
                        const abandoned = pending.credentialId;
                        setPending(null);
                        void api
                            .send('mailserver.appPasswordRevoke', { id: mailbox.id, credentialId: abandoned })
                            .catch(() => undefined);
                    }}
                />
            ) : null
    };
}

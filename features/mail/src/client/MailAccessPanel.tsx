import { useEffect, useState } from 'react';
import { settingsStyles as shell, useWorkspacePermissions } from 'deveye-sdk-client';
import type { SettingsPanelProps } from '@deveye/types/sdk/client';

import { hostedMailboxOf, mailserver, type HostedMailbox } from './mailserverLink';

/**
 * L'onglet Accès d'une boîte hébergée par le Serveur mail : le panneau du
 * Serveur mail lui-même, monté sur sa boîte, pour régler d'ici les mots de
 * passe d'application de l'adresse. L'onglet n'existe que pour ces comptes
 * (`settingsTabApplies`), et les droits sont ceux du Serveur mail, pas ceux de
 * Mail : c'est lui qui répond.
 */
export default function MailAccessPanel({ scope, close, gone }: SettingsPanelProps) {
    const accountId = scope.kind === 'item' ? Number(scope.itemId) : null;
    const permissions = useWorkspacePermissions();
    const [hosted, setHosted] = useState<HostedMailbox | null | undefined>(undefined);

    useEffect(() => {
        if (accountId === null) return;
        let live = true;
        void hostedMailboxOf(accountId).then((found) => {
            if (live) setHosted(found);
        });
        return () => {
            live = false;
        };
    }, [accountId]);

    const Panel = mailserver()?.AccessPanel;
    if (hosted === undefined) return <p className={shell.notice}>Chargement…</p>;
    if (!hosted || !Panel) {
        return <p className={shell.notice}>Cette adresse n’est pas hébergée par le Serveur mail.</p>;
    }
    return (
        <Panel
            scope={{ kind: 'item', itemId: String(hosted.id), itemLabel: hosted.address }}
            canWrite={permissions.canFeature('mailserver', 'write', String(hosted.id))}
            close={close}
            gone={gone}
        />
    );
}

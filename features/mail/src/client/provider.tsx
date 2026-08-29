import { useEffect, useRef } from 'react';
import { OpenPopup } from 'deveye-sdk-client';
import type { MailClientProvider } from '@deveye/types/sdk/client';

import AccountPopup, { ACCOUNT_POPUP, type AccountPopupResult } from './AccountPopup';
import { api } from './api';

/**
 * Ce que le module offre aux écrans de l'app (`MAIL_CLIENT_PROVIDER`) : le
 * formulaire d'un canal e-mail compose la liste des expéditeurs prêts et le
 * dialogue de compte de Mail, sans importer le module. `listSenders` filtre
 * déjà : seuls les comptes « open » peuvent envoyer sans déverrouillage, et une
 * boîte en pause n'envoie rien.
 */

interface AccountDialogProps {
    open: boolean;
    onClose: () => void;
    onSaved: () => void;
}

/**
 * Monte le dialogue de compte Mail à la demande, l'ouvre, rend le résultat.
 *
 * `AccountPopup` passe par le registre impératif des Popup : il faut qu'une
 * instance soit montée pour qu'`OpenPopup` la trouve, et la feature Mail n'est
 * pas forcément vivante quand on règle un canal. L'ouverture vit dans l'effet du
 * parent : React exécute les effets des enfants d'abord, donc `AccountPopup` est
 * déjà inscrit quand `OpenPopup` le vise.
 *
 * `saved` (connexion manuelle) et `oauth-connected` valent tous deux « une boîte
 * est sortie du dialogue » (`onSaved`) ; tout le reste est une fermeture.
 */
function AccountDialog({ open, onClose, onSaved }: AccountDialogProps) {
    const onCloseRef = useRef(onClose);
    onCloseRef.current = onClose;
    const onSavedRef = useRef(onSaved);
    onSavedRef.current = onSaved;

    useEffect(() => {
        if (!open) return;
        let live = true;
        void OpenPopup<AccountPopupResult>(ACCOUNT_POPUP, null).then((result) => {
            if (!live) return;
            if (result === 'saved' || result === 'oauth-connected') onSavedRef.current();
            else onCloseRef.current();
        });
        return () => {
            live = false;
        };
    }, [open]);

    return open ? <AccountPopup /> : null;
}

export const clientProvider: MailClientProvider = {
    listSenders: async () =>
        (await api.send('mail.accountList', {})).accounts
            .filter((a) => a.securityTier === 'open' && a.enabled)
            .map((a) => ({ id: a.id, label: a.displayName, address: a.emailAddress })),
    AccountDialog
};

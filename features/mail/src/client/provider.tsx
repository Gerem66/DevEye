import { useEffect, useRef } from 'react';
import { OpenPopup } from 'deveye-sdk-client';
import type { MailAccountPrefill, MailClientProvider } from '@deveye/types/sdk/client';

import AccountPopup, { ACCOUNT_POPUP, type AccountPopupInput, type AccountPopupResult } from './AccountPopup';
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
    prefill?: MailAccountPrefill;
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
function AccountDialog({ open, onClose, onSaved, prefill }: AccountDialogProps) {
    const onCloseRef = useRef(onClose);
    onCloseRef.current = onClose;
    const onSavedRef = useRef(onSaved);
    onSavedRef.current = onSaved;
    // Lu à l'ouverture seulement : un objet recréé à chaque rendu de l'appelant
    // ne doit pas rouvrir le dialogue.
    const prefillRef = useRef(prefill);
    prefillRef.current = prefill;

    useEffect(() => {
        if (!open) return;
        let live = true;
        const input: AccountPopupInput = prefillRef.current ? { prefill: prefillRef.current } : null;
        void OpenPopup<AccountPopupResult>(ACCOUNT_POPUP, input).then((result) => {
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
            .filter((a) => a.securityTier === 'open' && a.enabled && !a.planPaused)
            .map((a) => ({ id: a.id, label: a.displayName, address: a.emailAddress })),
    findByAddress: async (address) => {
        const wanted = address.trim().toLowerCase();
        const held = (await api.send('mail.accountList', {})).accounts.find(
            (a) => a.emailAddress.trim().toLowerCase() === wanted
        );
        return held ? { id: held.id } : null;
    },
    AccountDialog
};

import { useState } from 'react';

import Button from '@/Components/Button';
import { DialogCancelButton } from '@/Components/Dialog';
import Popup, { ClosePopup, OpenPopup } from '@/Components/Popup';
import TextInput from '@/Components/TextInput';
import { MAIL_CONFIRM_POPUP } from './ConfirmPopup';
import { humanizeError, ws } from './api';
import styles from './style.module.css';

import {
    MAIL_SYNC_INTERVAL_DEFAULT_MINUTES,
    MAIL_SYNC_INTERVAL_MAX_MINUTES,
    MAIL_SYNC_INTERVAL_MIN_MINUTES
} from 'deveye-types';
import type { MailAccount } from 'deveye-types';

export const ACCOUNT_SETTINGS_POPUP = 'popup-mail-account-settings';

/** Le dossier ouvert accompagne le compte : c'est lui que la reconstruction viserait. */
export interface AccountSettingsInput {
    account: MailAccount;
    /** Nom du dossier sélectionné, ou `null` si aucun — la maintenance est alors sans objet. */
    folderName: string | null;
}

/**
 * Ce que la popup a fait, plutôt qu'un simple « enregistré » : la reconstruction
 * du cache appartient à l'appelant, qui seul tient la liste des messages.
 */
export type AccountSettingsResult = 'saved' | 'reset' | null;

/**
 * Per-mailbox settings, opened from that account's options panel. Distinct from
 * `MailSettingsPopup`, which holds what is genuinely transversal (body render
 * mode, trusted image domains) — anything that describes *one* mailbox belongs
 * here instead, and the split is what keeps either dialog from turning into a
 * grab bag.
 *
 * Saves through `mail.accountSetProfile`, resubmitting the account's own name
 * and tier unchanged: that command owns the whole profile, and this dialog is
 * simply the surface for the part of it that isn't in the edit form.
 */
export function AccountSettingsPopup() {
    const [account, setAccount] = useState<MailAccount | null>(null);
    const [folderName, setFolderName] = useState<string | null>(null);
    const [intervalMinutes, setIntervalMinutes] = useState(String(MAIL_SYNC_INTERVAL_DEFAULT_MINUTES));
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    function handleOpen(input: AccountSettingsInput | null): void {
        if (!input) return;
        setAccount(input.account);
        setFolderName(input.folderName);
        setIntervalMinutes(String(input.account.syncIntervalMinutes));
        setError(null);
    }

    function close(result: AccountSettingsResult): void {
        ClosePopup(ACCOUNT_SETTINGS_POPUP, result);
    }

    /**
     * La reconstruction elle-même est confiée à l'appelant : elle vide la liste
     * affichée et la recharge, deux choses dont cette popup n'a pas la main.
     */
    async function requestReset(): Promise<void> {
        const confirmed = await OpenPopup<boolean>(MAIL_CONFIRM_POPUP, {
            title: 'Reconstruire le cache de ce dossier ?',
            message: `Le cache local de « ${folderName} » sera vidé puis retéléchargé depuis le serveur. Rien n’est touché côté boîte mail, mais l’opération est plus lente qu’une relève.`,
            confirmLabel: 'Reconstruire'
        });
        if (confirmed) close('reset');
    }

    async function save(): Promise<void> {
        if (!account) return;
        const minutes = Math.min(
            MAIL_SYNC_INTERVAL_MAX_MINUTES,
            Math.max(MAIL_SYNC_INTERVAL_MIN_MINUTES, Number(intervalMinutes) || MAIL_SYNC_INTERVAL_DEFAULT_MINUTES)
        );
        setSaving(true);
        setError(null);
        try {
            await ws.send('mail.accountSetProfile', {
                id: account.id,
                displayName: account.displayName,
                securityTier: account.securityTier,
                syncIntervalMinutes: minutes
            });
            close('saved');
        } catch (e) {
            setError(humanizeError(e, 'Enregistrement impossible.'));
        } finally {
            setSaving(false);
        }
    }

    const guarded = account?.securityTier === 'guarded';

    return (
        <Popup<AccountSettingsInput | null>
            id={ACCOUNT_SETTINGS_POPUP}
            title={account ? `Paramètres — ${account.displayName}` : 'Paramètres de la boîte'}
            width={460}
            onInputChange={handleOpen}
            onClosePopup={() => close(null)}
            onSubmit={() => void save()}
        >
            <div className={styles.form}>
                <p className={styles.sectionLabel}>Synchronisation</p>
                <div className={styles.formRow}>
                    <TextInput
                        type='number'
                        min={MAIL_SYNC_INTERVAL_MIN_MINUTES}
                        max={MAIL_SYNC_INTERVAL_MAX_MINUTES}
                        value={intervalMinutes}
                        disabled={guarded}
                        onChange={(e) => setIntervalMinutes(e.target.value)}
                    />
                </div>
                <p className={styles.fieldHint}>
                    {guarded
                        ? 'Cette boîte est protégée : elle n’est jamais relevée en tâche de fond et se synchronise à l’ouverture, une fois déverrouillée. Ce réglage ne s’y applique pas.'
                        : `Fréquence de relève de cette boîte en tâche de fond, en minutes (de ${MAIL_SYNC_INTERVAL_MIN_MINUTES} à ${MAIL_SYNC_INTERVAL_MAX_MINUTES}). Chaque relève rapatrie les nouveaux messages et met à jour les plus récents — lus ailleurs, supprimés ailleurs. La précision réelle dépend du rythme de vérification du serveur : une valeur plus basse ne fera pas mieux que ce rythme.`}
                </p>

                <p className={styles.sectionLabel}>Maintenance</p>
                <div className={styles.formRow}>
                    <Button variant='danger' disabled={folderName === null} onClick={() => void requestReset()}>
                        {folderName === null ? 'Reconstruire le cache' : `Reconstruire le cache de « ${folderName} »`}
                    </Button>
                </div>
                <p className={styles.fieldHint}>
                    {folderName === null
                        ? 'Ouvrez un dossier pour pouvoir reconstruire son cache.'
                        : 'Vide le cache local du dossier ouvert et le retélécharge en entier. Réservé aux cas où l’affichage a durablement divergé de la boîte : la relève ordinaire suffit le reste du temps.'}
                </p>

                {error && <p className={styles.status}>{error}</p>}
            </div>

            <div className={styles.popupActions}>
                <div className={styles.popupActionsLeft}>
                    <DialogCancelButton>Fermer</DialogCancelButton>
                </div>
                <Button disabled={saving || !account} onClick={() => void save()}>
                    {saving ? 'Enregistrement…' : 'Enregistrer'}
                </Button>
            </div>
        </Popup>
    );
}

export default AccountSettingsPopup;

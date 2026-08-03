import { useState } from 'react';

import Button from '@/Components/Button';
import { DialogCancelButton } from '@/Components/Dialog';
import Popup, { ClosePopup } from '@/Components/Popup';
import TextInput from '@/Components/TextInput';
import { humanizeError, ws } from './api';
import styles from './style.module.css';

import {
    MAIL_SYNC_INTERVAL_DEFAULT_MINUTES,
    MAIL_SYNC_INTERVAL_MAX_MINUTES,
    MAIL_SYNC_INTERVAL_MIN_MINUTES
} from 'deveye-types';
import type { MailAccount } from 'deveye-types';

export const ACCOUNT_SETTINGS_POPUP = 'popup-mail-account-settings';

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
    const [intervalMinutes, setIntervalMinutes] = useState(String(MAIL_SYNC_INTERVAL_DEFAULT_MINUTES));
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    function handleOpen(input: MailAccount | null): void {
        if (!input) return;
        setAccount(input);
        setIntervalMinutes(String(input.syncIntervalMinutes));
        setError(null);
    }

    function close(saved: boolean): void {
        ClosePopup(ACCOUNT_SETTINGS_POPUP, saved);
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
            close(true);
        } catch (e) {
            setError(humanizeError(e, 'Enregistrement impossible.'));
        } finally {
            setSaving(false);
        }
    }

    const guarded = account?.securityTier === 'guarded';

    return (
        <Popup<MailAccount | null>
            id={ACCOUNT_SETTINGS_POPUP}
            title={account ? `Paramètres — ${account.displayName}` : 'Paramètres de la boîte'}
            width={460}
            onInputChange={handleOpen}
            onClosePopup={() => close(false)}
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
                        : `Fréquence de relève de cette boîte en tâche de fond, en minutes (de ${MAIL_SYNC_INTERVAL_MIN_MINUTES} à ${MAIL_SYNC_INTERVAL_MAX_MINUTES}). La précision réelle dépend du rythme de vérification du serveur — une valeur plus basse ne fera pas mieux que ce rythme.`}
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

import { useState } from 'react';

import { ws } from '@/api/ws';
import Button from '@/Components/Button';
import { DialogCancelButton } from '@/Components/Dialog';
import Popup, { ClosePopup } from '@/Components/Popup';
import SelectInput from '@/Components/SelectInput';
import TextInput from '@/Components/TextInput';

import styles from './style.module.css';

import type { MailAccount, UptimeSettings } from 'deveye-types';

export const NOTIFICATIONS_POPUP = 'popup-uptime-notifications';

/**
 * Where down/recovery alerts go. Self-contained: it loads the settings when it
 * opens and saves them itself, so the list view only has to open it.
 */
export function NotificationsPopup() {
    const [settings, setSettings] = useState<UptimeSettings | null>(null);
    const [mailAccounts, setMailAccounts] = useState<MailAccount[]>([]);
    const [mailAccountId, setMailAccountId] = useState<number | null>(null);
    const [email, setEmail] = useState('');
    const [webhookUrl, setWebhookUrl] = useState('');
    const [emailEnabled, setEmailEnabled] = useState(true);
    const [webhookEnabled, setWebhookEnabled] = useState(false);
    const [status, setStatus] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    /** `null` also arrives on close (see Popup) — only reload on a real open. */
    function handleOpen(opening: boolean | null): void {
        if (!opening) return;
        setStatus(null);
        setSettings(null);
        void Promise.all([ws.send('uptime.getSettings', {}), ws.send('mail.accountList', {})])
            .then(([settingsRes, accountsRes]) => {
                setSettings(settingsRes.settings);
                setEmail(settingsRes.settings.email ?? '');
                setWebhookUrl(settingsRes.settings.webhookUrl ?? '');
                setEmailEnabled(settingsRes.settings.emailEnabled);
                setWebhookEnabled(settingsRes.settings.webhookEnabled);
                setMailAccountId(settingsRes.settings.mailAccountId);
                setMailAccounts(accountsRes.accounts);
            })
            .catch(() => setStatus('Chargement impossible.'));
    }

    async function save(): Promise<void> {
        setBusy(true);
        try {
            await ws.send('uptime.setSettings', { emailEnabled, email, mailAccountId, webhookEnabled, webhookUrl });
            ClosePopup(NOTIFICATIONS_POPUP, true);
        } catch {
            setStatus('Enregistrement impossible.');
        } finally {
            setBusy(false);
        }
    }

    /** Save first, then test — otherwise the test would use the old channels. */
    async function test(): Promise<void> {
        setBusy(true);
        setStatus(null);
        try {
            await ws.send('uptime.setSettings', { emailEnabled, email, mailAccountId, webhookEnabled, webhookUrl });
            const res = await ws.send('uptime.testNotification', {});
            setStatus(res.sent ? 'Notification de test envoyée.' : (res.error ?? 'Envoi impossible.'));
        } catch {
            setStatus('Envoi impossible.');
        } finally {
            setBusy(false);
        }
    }

    // Only "open" tier accounts can send unattended alerts — a "guarded" one
    // needs a live session unlock, which the background scheduler never has.
    const openAccounts = mailAccounts.filter((a) => a.securityTier === 'open' && a.enabled);

    return (
        <Popup
            id={NOTIFICATIONS_POPUP}
            title='Notifications'
            width={520}
            onInputChange={handleOpen}
            onClosePopup={() => ClosePopup(NOTIFICATIONS_POPUP, null)}
            onSubmit={() => void save()}
        >
            <p className={styles.popupHint}>
                Envoyées à chaque bascule d’un service surveillé : hors ligne (avec l’heure et l’erreur) puis retour en
                ligne (avec la durée de la panne).
            </p>

            <div className={styles.form}>
                <label className={styles.check}>
                    <input type='checkbox' checked={emailEnabled} onChange={(e) => setEmailEnabled(e.target.checked)} />
                    <span>Par e-mail</span>
                </label>
                <label className={styles.field}>
                    <span className={styles.fieldLabel}>Compte expéditeur</span>
                    <SelectInput
                        value={mailAccountId ?? ''}
                        disabled={!emailEnabled}
                        onChange={(e) => setMailAccountId(e.target.value ? Number(e.target.value) : null)}
                    >
                        <option value=''>Aucun</option>
                        {openAccounts.map((a) => (
                            <option key={a.id} value={a.id}>
                                {a.displayName} ({a.emailAddress})
                            </option>
                        ))}
                    </SelectInput>
                    <span className={styles.fieldHint}>
                        {openAccounts.length === 0
                            ? 'Aucun compte mail « open » configuré — ajoutez-en un dans la feature Mail.'
                            : 'Seuls les comptes « open » peuvent envoyer sans intervention manuelle.'}
                    </span>
                </label>
                <label className={styles.field}>
                    <span className={styles.fieldLabel}>Destinataire</span>
                    <TextInput
                        type='email'
                        placeholder='Adresse du compte expéditeur'
                        value={email}
                        disabled={!emailEnabled}
                        onChange={(e) => setEmail(e.target.value)}
                    />
                    <span className={styles.fieldHint}>Laissez vide pour utiliser l’adresse du compte expéditeur.</span>
                </label>

                <label className={styles.check}>
                    <input
                        type='checkbox'
                        checked={webhookEnabled}
                        onChange={(e) => setWebhookEnabled(e.target.checked)}
                    />
                    <span>Par webhook</span>
                </label>
                <label className={styles.field}>
                    <span className={styles.fieldLabel}>URL appelée en POST</span>
                    <TextInput
                        placeholder='https://exemple.com/hook'
                        value={webhookUrl}
                        disabled={!webhookEnabled}
                        onChange={(e) => setWebhookUrl(e.target.value)}
                    />
                    <span className={styles.fieldHint}>
                        Corps JSON : {'{ content, text, event, service, url, at }'}. Le message lisible est répété dans{' '}
                        <code>content</code> (Discord) et <code>text</code> (Slack), les autres champs servent aux
                        endpoints maison.
                    </span>
                </label>

                {settings && emailEnabled && !settings.mailAccountReady && (
                    <p className={styles.warning}>
                        Aucun compte mail « open » sélectionné : les e-mails ne partiront pas tant qu’un compte
                        expéditeur valide n’est pas choisi ci-dessus.
                    </p>
                )}
                {status && <p className={styles.status}>{status}</p>}
            </div>

            <div className={styles.popupActions}>
                <div className={styles.popupActionsLeft}>
                    <DialogCancelButton>Fermer</DialogCancelButton>
                    <Button variant='secondary' disabled={busy} onClick={() => void test()}>
                        Tester
                    </Button>
                </div>
                <Button disabled={busy} onClick={() => void save()}>
                    Enregistrer
                </Button>
            </div>
        </Popup>
    );
}

export default NotificationsPopup;

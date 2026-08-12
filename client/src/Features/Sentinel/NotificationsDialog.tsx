import { useEffect, useState } from 'react';
import type { MailAccount } from 'deveye-types';

import { ws } from '@/api/ws';
import Button from '@/Components/Button';
import Checkbox from '@/Components/Checkbox';
import { Dialog } from '@/Components/Dialog';
import SelectInput from '@/Components/SelectInput';
import TextInput from '@/Components/TextInput';

import styles from './style.module.css';

/**
 * Où partent les constats de Sentinelle.
 *
 * **Ses propres canaux**, et c'est tout le sujet : Sentinelle empruntait ceux
 * d'Uptime « pour éviter deux jeux de réglages ». On recevait donc des alertes
 * de sécurité sur un salon désigné pour la disponibilité, sans que rien ne
 * l'ait annoncé, et sans moyen de les couper sans couper aussi Uptime.
 *
 * Éteint par défaut : rien ne part tant que rien n'est réglé ici.
 */

interface Props {
    open: boolean;
    onClose: () => void;
}

export default function NotificationsDialog({ open, onClose }: Props) {
    const [accounts, setAccounts] = useState<MailAccount[]>([]);
    const [mailAccountId, setMailAccountId] = useState<number | null>(null);
    const [email, setEmail] = useState('');
    const [webhookUrl, setWebhookUrl] = useState('');
    const [emailEnabled, setEmailEnabled] = useState(false);
    const [webhookEnabled, setWebhookEnabled] = useState(false);
    const [status, setStatus] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    // Rechargé à chaque ouverture : un dialogue qui garde l'état d'avant fait
    // enregistrer ce qu'on croyait avoir annulé.
    useEffect(() => {
        if (!open) return;
        setStatus(null);
        void Promise.all([ws.send('sentinel.getSettings', {}), ws.send('mail.accountList', {})])
            .then(([s, a]) => {
                setEmailEnabled(s.settings.emailEnabled);
                setEmail(s.settings.email ?? '');
                setMailAccountId(s.settings.mailAccountId);
                setWebhookEnabled(s.settings.webhookEnabled);
                setWebhookUrl(s.settings.webhookUrl ?? '');
                setAccounts(a.accounts);
            })
            .catch(() => setStatus('Chargement impossible.'));
    }, [open]);

    function payload(): Parameters<typeof ws.send<'sentinel.setSettings'>>[1] {
        return { emailEnabled, email, mailAccountId, webhookEnabled, webhookUrl };
    }

    async function save(): Promise<void> {
        setBusy(true);
        setStatus(null);
        try {
            await ws.send('sentinel.setSettings', payload());
            onClose();
        } catch {
            setStatus('Enregistrement impossible.');
        } finally {
            setBusy(false);
        }
    }

    /** Enregistrer d'abord : sans quoi le test partirait sur les anciens canaux. */
    async function test(): Promise<void> {
        setBusy(true);
        setStatus(null);
        try {
            await ws.send('sentinel.setSettings', payload());
            const res = await ws.send('sentinel.testNotification', {});
            setStatus(res.sent ? 'Notification de test envoyée.' : (res.error ?? 'Envoi impossible.'));
        } catch {
            setStatus('Envoi impossible.');
        } finally {
            setBusy(false);
        }
    }

    // Seuls les comptes « open » peuvent envoyer sans intervention : un compte
    // gardé exige un déverrouillage que le moteur de fond n'a jamais.
    const openAccounts = accounts.filter((a) => a.securityTier === 'open' && a.enabled);

    return (
        <Dialog
            open={open}
            onClose={onClose}
            title='Notifications de Sentinelle'
            description='Distinctes de celles d’Uptime : une alerte de sécurité n’a ni les mêmes destinataires ni la même urgence qu’un service tombé.'
            width={520}
            footer={
                <div className={styles.dialogFooter}>
                    <Button variant='ghost' disabled={busy} onClick={() => void test()}>
                        Tester
                    </Button>
                    <Button variant='primary' disabled={busy} onClick={() => void save()}>
                        Enregistrer
                    </Button>
                </div>
            }
            onSubmit={() => void save()}
        >
            <div className={styles.dialogBody}>
                <p className={styles.fieldHint}>
                    Envoyées à l’ouverture d’un constat de gravité « élevé » ou plus, et regroupées par appareil : une
                    machine compromise déclenche plusieurs règles d’un coup, qui partent en un seul message.
                </p>

                <Checkbox checked={emailEnabled} onChange={setEmailEnabled}>
                    Par e-mail
                </Checkbox>

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
                        value={email}
                        disabled={!emailEnabled}
                        placeholder='Adresse du compte expéditeur'
                        onChange={(e) => setEmail(e.target.value)}
                    />
                </label>

                <Checkbox checked={webhookEnabled} onChange={setWebhookEnabled}>
                    Par webhook
                </Checkbox>

                <label className={styles.field}>
                    <span className={styles.fieldLabel}>URL</span>
                    <TextInput
                        value={webhookUrl}
                        disabled={!webhookEnabled}
                        placeholder='https://discord.com/api/webhooks/…'
                        onChange={(e) => setWebhookUrl(e.target.value)}
                    />
                    <span className={styles.fieldHint}>
                        Une seule URL pour Discord, Slack ou un point d’entrée maison : le corps porte les trois formes
                        à la fois.
                    </span>
                </label>

                {status && <p className={styles.notice}>{status}</p>}
            </div>
        </Dialog>
    );
}

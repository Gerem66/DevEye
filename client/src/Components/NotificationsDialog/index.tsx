import { useEffect, useState } from 'react';
import type { MailAccount, NotificationSettings } from 'deveye-types';

import { ws } from '@/api/ws';
import Button from '@/Components/Button';
import Checkbox from '@/Components/Checkbox';
import { Dialog } from '@/Components/Dialog';
import SelectInput from '@/Components/SelectInput';
import TextInput from '@/Components/TextInput';

import styles from './NotificationsDialog.module.css';

/**
 * Où partent les alertes d'une feature — **le même écran pour les quatre**.
 *
 * Uptime, Sentinelle, Bases de données et Déploiement règlent exactement les
 * mêmes champs : un compte expéditeur « open », un destinataire, un webhook.
 * Ils en avaient pourtant deux implémentations, et allaient en avoir quatre : le
 * dialogue de Sentinelle est né d'un copier-coller de la popup d'Uptime, dont il
 * a hérité les mêmes cent quarante lignes et perdu au passage l'avertissement
 * « aucun compte expéditeur valide » — un écran qui laissait donc croire à un
 * canal actif là où l'autre prévenait.
 *
 * Ce qui distingue réellement un émetteur d'un autre tient dans trois chaînes :
 * le préfixe de ses commandes, son titre, et la phrase qui dit **quand** il
 * écrit. Tout le reste est commun, y compris l'ordre des gestes — enregistrer
 * avant de tester, sans quoi le test partirait sur les anciens canaux.
 *
 * ⚠️ Les trois commandes attendues (`<feature>.getSettings`, `.setSettings`,
 * `.testNotification`) sont supposées exister : c'est la contrepartie du
 * paramétrage par préfixe. Un émetteur qui n'en déclarerait que deux se verrait
 * refusé par le typage des commandes, pas par une vérification d'exécution.
 */

/** Les émetteurs qui savent notifier, côté client. Miroir de `notificationFeatureSchema`. */
export type NotificationsFeature = 'uptime' | 'sentinel' | 'database' | 'deploy';

interface Props {
    open: boolean;
    onClose: () => void;
    /** L'émetteur : décide de la ligne de réglages lue et écrite. */
    feature: NotificationsFeature;
    /** Titre du dialogue — « Notifications de Sentinelle », etc. */
    title: string;
    /**
     * Ce qui distingue ces canaux de ceux des autres features, en une phrase.
     * Affiché sous le titre : c'est ce qui évite de régler Uptime en croyant
     * régler la Sentinelle.
     */
    description: string;
    /** **Quand** cette feature écrit. Affiché en tête du corps. */
    when: string;
}

/** Les commandes d'un émetteur, reconstituées depuis son préfixe. */
type Commands = {
    get: `${NotificationsFeature}.getSettings`;
    set: `${NotificationsFeature}.setSettings`;
    test: `${NotificationsFeature}.testNotification`;
};

function commandsOf(feature: NotificationsFeature): Commands {
    return {
        get: `${feature}.getSettings`,
        set: `${feature}.setSettings`,
        test: `${feature}.testNotification`
    };
}

export function NotificationsDialog({ open, onClose, feature, title, description, when }: Props) {
    const [settings, setSettings] = useState<NotificationSettings | null>(null);
    const [accounts, setAccounts] = useState<MailAccount[]>([]);
    const [mailAccountId, setMailAccountId] = useState<number | null>(null);
    const [email, setEmail] = useState('');
    const [webhookUrl, setWebhookUrl] = useState('');
    const [emailEnabled, setEmailEnabled] = useState(false);
    const [webhookEnabled, setWebhookEnabled] = useState(false);
    const [status, setStatus] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const commands = commandsOf(feature);

    // Rechargé à chaque ouverture : un dialogue qui garde l'état d'avant fait
    // enregistrer ce qu'on croyait avoir annulé.
    useEffect(() => {
        if (!open) return;
        setStatus(null);
        setSettings(null);
        void Promise.all([ws.send(commands.get, {}), ws.send('mail.accountList', {})])
            .then(([s, a]) => {
                setSettings(s.settings);
                setEmailEnabled(s.settings.emailEnabled);
                setEmail(s.settings.email ?? '');
                setMailAccountId(s.settings.mailAccountId);
                setWebhookEnabled(s.settings.webhookEnabled);
                setWebhookUrl(s.settings.webhookUrl ?? '');
                setAccounts(a.accounts);
            })
            .catch(() => setStatus('Chargement impossible.'));
    }, [open, commands.get]);

    function payload() {
        return { emailEnabled, email, mailAccountId, webhookEnabled, webhookUrl };
    }

    async function save(): Promise<void> {
        setBusy(true);
        setStatus(null);
        try {
            await ws.send(commands.set, payload());
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
            await ws.send(commands.set, payload());
            const res = await ws.send(commands.test, {});
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
            title={title}
            description={description}
            width={520}
            footer={
                <div className={styles.footer}>
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
            <div className={styles.body}>
                <p className={styles.fieldHint}>{when}</p>

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
                        type='email'
                        value={email}
                        disabled={!emailEnabled}
                        placeholder='Adresse du compte expéditeur'
                        onChange={(e) => setEmail(e.target.value)}
                    />
                    <span className={styles.fieldHint}>Laissez vide pour utiliser l’adresse du compte expéditeur.</span>
                </label>

                <Checkbox checked={webhookEnabled} onChange={setWebhookEnabled}>
                    Par webhook
                </Checkbox>

                <label className={styles.field}>
                    <span className={styles.fieldLabel}>URL appelée en POST</span>
                    <TextInput
                        value={webhookUrl}
                        disabled={!webhookEnabled}
                        placeholder='https://discord.com/api/webhooks/…'
                        onChange={(e) => setWebhookUrl(e.target.value)}
                    />
                    <span className={styles.fieldHint}>
                        Une seule URL pour Discord, Slack ou un point d’entrée maison : le message lisible est répété
                        dans <code>content</code> (Discord) et <code>text</code> (Slack), et les champs structurés
                        suivent pour les endpoints maison.
                    </span>
                </label>

                {/* L'avertissement n'existait que dans Uptime. Il compte partout :
                    sans lui, un canal coché sans compte expéditeur valide a
                    exactement l'air d'un canal qui fonctionne. */}
                {settings && emailEnabled && !settings.mailAccountReady && (
                    <p className={styles.warning}>
                        Aucun compte mail « open » sélectionné : les e-mails ne partiront pas tant qu’un compte
                        expéditeur valide n’est pas choisi ci-dessus.
                    </p>
                )}
                {status && <p className={styles.notice}>{status}</p>}
            </div>
        </Dialog>
    );
}

export default NotificationsDialog;

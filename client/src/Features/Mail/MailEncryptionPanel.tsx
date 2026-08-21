import { useEffect, useState } from 'react';
import type { MailAccount, MailSecurityTier } from 'deveye-types';

import Button from '@/Components/Button';
import { invalidate, useResourceVersion } from '@/stores/invalidation';

import { humanizeError, withSecrecy, ws } from './api';
import styles from './style.module.css';

/**
 * Le palier de chiffrement d'une boîte : l'onglet Chiffrement de ses réglages.
 *
 * Le choix vivait dans le formulaire d'ajout/édition du compte, au milieu des
 * champs IMAP : il en sort, parce que ce n'est pas de la configuration de
 * connexion mais un réglage de l'élément, comme pour les autres features. Le
 * formulaire d'ajout garde le choix à la création (il détermine sous quelle
 * clé la boîte naît) ; ensuite, c'est ici.
 *
 * Changer de palier re-chiffre toute la boîte côté serveur (comptes, dossiers,
 * enveloppes) : le bouton l'annonce, et le passage par `withSecrecy` couvre le
 * déverrouillage qu'exige une boîte protégée.
 */
export default function MailEncryptionPanel({ accountId }: { accountId: number }) {
    const version = useResourceVersion('mail.accountList');
    const [account, setAccount] = useState<MailAccount | null>(null);
    const [tier, setTier] = useState<MailSecurityTier>('open');
    const [busy, setBusy] = useState(false);
    const [status, setStatus] = useState<string | null>(null);

    useEffect(() => {
        void ws
            .send('mail.accountList', {})
            .then((res) => {
                const found = res.accounts.find((a) => a.id === accountId) ?? null;
                setAccount(found);
                if (found) setTier(found.securityTier);
            })
            .catch((e) => setStatus(humanizeError(e, 'Chargement impossible.')));
    }, [accountId, version]);

    if (!account) return <p className={styles.status}>{status ?? 'Chargement…'}</p>;

    const changed = tier !== account.securityTier;

    const save = async () => {
        setBusy(true);
        setStatus(null);
        try {
            await withSecrecy(() =>
                ws.send('mail.accountSetProfile', {
                    id: account.id,
                    displayName: account.displayName,
                    securityTier: tier,
                    syncIntervalMinutes: account.syncIntervalMinutes
                })
            );
            invalidate('mail.accountList');
            setStatus('Palier changé : la boîte a été re-chiffrée.');
        } catch (e) {
            setStatus(humanizeError(e, 'Changement impossible.'));
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className={styles.form}>
            <div className={styles.tierChoice}>
                {(['open', 'guarded'] as MailSecurityTier[]).map((t) => (
                    <label key={t} className={styles.tierOption}>
                        <input
                            type='radio'
                            name='accountSecurityTier'
                            checked={tier === t}
                            disabled={busy}
                            onChange={() => setTier(t)}
                        />
                        <span>
                            <strong>{t === 'open' ? 'Ouvert' : 'Protégé'}</strong>
                            <span className={styles.fieldHint}>
                                {t === 'open'
                                    ? 'Synchro automatique en tâche de fond, utilisable pour les notifications (ex. Uptime).'
                                    : 'Nécessite le déverrouillage par mot de passe à chaque consultation ; jamais synchronisé seul.'}
                            </span>
                        </span>
                    </label>
                ))}
            </div>

            <p className={styles.fieldHint}>
                Changer de palier re-chiffre toute la boîte (identité, dossiers, enveloppes) sous la nouvelle clé.
                Passer en « Protégé » exige que le chiffrement par mot de passe soit activé sur le compte, et retire la
                boîte de la relève de fond.
            </p>

            <div className={styles.formRow}>
                <Button onClick={() => void save()} disabled={busy || !changed}>
                    {busy ? 'Re-chiffrement…' : 'Changer de palier'}
                </Button>
            </div>

            {status && <p className={styles.status}>{status}</p>}
        </div>
    );
}

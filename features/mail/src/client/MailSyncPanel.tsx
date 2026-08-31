import { useCallback, useEffect, useState } from 'react';
import { Button, invalidate, settingsStyles as shell, Switch, TextInput, useResourceVersion } from 'deveye-sdk-client';
import type { SettingsPanelProps } from '@deveye/types/sdk/client';

import { api, humanizeError } from './api';
import styles from './style.module.css';

import {
    MAIL_SYNC_INTERVAL_DEFAULT_MINUTES,
    MAIL_SYNC_INTERVAL_MAX_MINUTES,
    MAIL_SYNC_INTERVAL_MIN_MINUTES
} from '../contracts/domain';
import type { MailAccount } from '../contracts/domain';

/**
 * La synchronisation d'une boîte : la cadence de relève et la pause. La
 * reconstruction du cache est ailleurs (`MailAdvancedPanel`), n'étant pas un
 * geste du quotidien.
 *
 * Enregistre par `mail.accountSetProfile`, en resoumettant le nom et le palier
 * tels quels : la commande possède le profil entier, ce panneau n'est que la
 * surface de sa cadence.
 *
 * La boîte est l'élément de la portée (`scope.itemId`) ; l'onglet n'existe qu'à
 * cette échelle. Sans le droit d'écriture, la cadence et la pause se lisent mais
 * ne se changent pas.
 */
export default function MailSyncPanel({ scope, canWrite }: SettingsPanelProps) {
    const accountId = scope.kind === 'item' ? Number(scope.itemId) : null;
    const version = useResourceVersion('mail.accountList');
    const [account, setAccount] = useState<MailAccount | null>(null);
    const [intervalMinutes, setIntervalMinutes] = useState('');
    const [busy, setBusy] = useState(false);
    const [status, setStatus] = useState<string | null>(null);

    useEffect(() => {
        if (accountId === null) return;
        void api
            .send('mail.accountList', {})
            .then((res) => {
                const found = res.accounts.find((a) => a.id === accountId) ?? null;
                setAccount(found);
                if (found) setIntervalMinutes(String(found.syncIntervalMinutes));
            })
            .catch((e) => setStatus(humanizeError(e, 'Chargement impossible.')));
    }, [accountId, version]);

    const guarded = account?.securityTier === 'guarded';

    const saveInterval = useCallback(async () => {
        if (!account) return;
        const minutes = Math.min(
            MAIL_SYNC_INTERVAL_MAX_MINUTES,
            Math.max(MAIL_SYNC_INTERVAL_MIN_MINUTES, Number(intervalMinutes) || MAIL_SYNC_INTERVAL_DEFAULT_MINUTES)
        );
        setBusy(true);
        setStatus(null);
        try {
            await api.send('mail.accountSetProfile', {
                id: account.id,
                displayName: account.displayName,
                securityTier: account.securityTier,
                syncIntervalMinutes: minutes
            });
            setIntervalMinutes(String(minutes));
            invalidate('mail.accountList');
            setStatus('Cadence enregistrée.');
        } catch (e) {
            setStatus(humanizeError(e, 'Enregistrement impossible.'));
        } finally {
            setBusy(false);
        }
    }, [account, intervalMinutes]);

    const setEnabled = useCallback(
        async (enabled: boolean) => {
            if (!account) return;
            setBusy(true);
            setStatus(null);
            try {
                await api.send('mail.accountSetEnabled', { id: account.id, enabled });
                setAccount({ ...account, enabled });
                invalidate('mail.accountList');
            } catch (e) {
                setStatus(humanizeError(e, 'Changement impossible.'));
            } finally {
                setBusy(false);
            }
        },
        [account]
    );

    if (accountId === null) return null;
    if (!account) return <p className={shell.notice}>{status ?? 'Chargement…'}</p>;

    return (
        <div className={shell.section}>
            <div className={shell.field}>
                <span className={shell.sectionLabel}>Relève</span>
                <Switch
                    checked={account.enabled}
                    disabled={busy || !canWrite}
                    onChange={(on) => void setEnabled(on)}
                    label={account.enabled ? 'Boîte relevée automatiquement' : 'Boîte en pause : plus aucune relève'}
                />
                <div className={styles.formRow}>
                    <TextInput
                        type='number'
                        min={MAIL_SYNC_INTERVAL_MIN_MINUTES}
                        max={MAIL_SYNC_INTERVAL_MAX_MINUTES}
                        value={intervalMinutes}
                        disabled={guarded || busy || !canWrite}
                        onChange={(e) => setIntervalMinutes(e.target.value)}
                        aria-label='Cadence de relève, en minutes'
                    />
                    {canWrite && (
                        <Button onClick={() => void saveInterval()} disabled={guarded || busy}>
                            Enregistrer
                        </Button>
                    )}
                </div>
                <span className={shell.fieldHint}>
                    {guarded
                        ? 'Cette boîte est protégée : elle n’est jamais relevée en tâche de fond et se synchronise à l’ouverture, une fois déverrouillée. Ce réglage ne s’y applique pas.'
                        : `Fréquence de relève en tâche de fond, en minutes (de ${MAIL_SYNC_INTERVAL_MIN_MINUTES} à ${MAIL_SYNC_INTERVAL_MAX_MINUTES}). Chaque relève rapatrie les nouveaux messages et met à jour les plus récents. La précision réelle dépend du rythme de vérification du serveur.`}
                </span>
            </div>

            {!canWrite && (
                <p className={shell.sectionHint}>
                    Votre rôle ne permet pas de régler la relève d’une boîte : elle relève de l’écriture sur Mail.
                </p>
            )}

            {status && <p className={shell.notice}>{status}</p>}
        </div>
    );
}

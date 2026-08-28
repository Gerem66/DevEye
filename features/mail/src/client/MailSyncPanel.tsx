import { useCallback, useEffect, useState } from 'react';
import {
    Button,
    ConfirmDialog,
    invalidate,
    SelectInput,
    settingsStyles as shell,
    Switch,
    TextInput,
    useResourceVersion,
    withSecrecy,
    type ConfirmRequest
} from 'deveye-sdk-client';
import type { SettingsPanelProps } from '@deveye/types/sdk/client';

import { api, humanizeError } from './api';
import styles from './style.module.css';

import {
    MAIL_SYNC_INTERVAL_DEFAULT_MINUTES,
    MAIL_SYNC_INTERVAL_MAX_MINUTES,
    MAIL_SYNC_INTERVAL_MIN_MINUTES
} from '../contracts/domain';
import type { MailAccount, MailFolder } from '../contracts/domain';

/**
 * La synchronisation d'une boîte : l'onglet Synchronisation de ses réglages.
 *
 * Reprend ce que portait l'ancienne popup « Paramètres de cette boîte »
 * (cadence de relève, reconstruction du cache d'un dossier) et y range aussi
 * la pause de la boîte, qui n'était accessible que par l'icône de sa carte :
 * suspendre la relève est un réglage de synchronisation, pas une action de
 * liste.
 *
 * Enregistre par `mail.accountSetProfile`, en resoumettant le nom et le palier
 * tels quels : la commande possède le profil entier, ce panneau n'est que la
 * surface de sa cadence.
 *
 * La boîte est l'élément de la portée (`scope.itemId`) ; l'onglet n'existe
 * qu'à cette échelle, le manifest le dit. Sans le droit d'écriture, la cadence
 * et la pause se lisent mais ne se changent pas, et la maintenance (qui
 * réécrit le cache) n'est pas proposée.
 */
export default function MailSyncPanel({ scope, canWrite }: SettingsPanelProps) {
    const accountId = scope.kind === 'item' ? scope.itemId : null;
    const version = useResourceVersion('mail.accountList');
    const [account, setAccount] = useState<MailAccount | null>(null);
    const [folders, setFolders] = useState<MailFolder[]>([]);
    const [intervalMinutes, setIntervalMinutes] = useState('');
    const [folderId, setFolderId] = useState<number | null>(null);
    const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
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

    // Les dossiers ne servent qu'à la maintenance, et une boîte protégée
    // demanderait un déverrouillage rien que pour afficher l'onglet : on ne
    // les charge que pour une boîte ouverte, et pour qui peut reconstruire.
    useEffect(() => {
        if (!account || guarded || accountId === null || !canWrite) return;
        void withSecrecy(() => api.send('mail.folderList', { accountId }))
            .then((res) => {
                setFolders(res.folders);
                const inbox = res.folders.find((f) => f.specialUse === 'inbox') ?? res.folders[0] ?? null;
                setFolderId(inbox?.id ?? null);
            })
            .catch(() => undefined);
    }, [account, guarded, accountId, canWrite]);

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

    const requestReset = () => {
        const folder = folders.find((f) => f.id === folderId);
        if (!folder) return;
        setConfirm({
            title: `Reconstruire le cache de « ${folder.name} » ?`,
            description:
                'Le cache local du dossier sera vidé puis retéléchargé depuis le serveur. Rien n’est touché côté boîte mail, mais l’opération est plus lente qu’une relève.',
            confirmLabel: 'Reconstruire',
            onConfirm: () => {
                setConfirm(null);
                setBusy(true);
                setStatus(null);
                void withSecrecy(() => api.send('mail.folderReset', { folderId: folder.id }))
                    .then(() => {
                        invalidate('mail.folderList', 'mail.messageList');
                        setStatus(`Cache de « ${folder.name} » reconstruit.`);
                    })
                    .catch((e) => setStatus(humanizeError(e, 'Reconstruction impossible.')))
                    .finally(() => setBusy(false));
            }
        });
    };

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

            {canWrite && !guarded && folders.length > 0 && (
                <div className={shell.field}>
                    <span className={shell.sectionLabel}>Maintenance</span>
                    <div className={styles.formRow}>
                        <SelectInput
                            value={folderId === null ? '' : String(folderId)}
                            onChange={(e) => setFolderId(e.target.value === '' ? null : Number(e.target.value))}
                            aria-label='Dossier à reconstruire'
                        >
                            {folders.map((f) => (
                                <option key={f.id} value={f.id}>
                                    {f.name}
                                </option>
                            ))}
                        </SelectInput>
                        <Button variant='danger' disabled={busy || folderId === null} onClick={requestReset}>
                            Reconstruire le cache
                        </Button>
                    </div>
                    <span className={shell.fieldHint}>
                        Vide le cache local du dossier choisi et le retélécharge en entier. Réservé aux cas où
                        l’affichage a durablement divergé de la boîte : la relève ordinaire suffit le reste du temps.
                    </span>
                </div>
            )}

            {!canWrite && (
                <p className={shell.sectionHint}>
                    Votre rôle ne permet pas de régler la relève d’une boîte : elle relève de l’écriture sur Mail.
                </p>
            )}

            {status && <p className={shell.notice}>{status}</p>}

            <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} busy={busy} />
        </div>
    );
}

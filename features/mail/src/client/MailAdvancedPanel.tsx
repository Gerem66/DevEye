import { useEffect, useState } from 'react';
import {
    Button,
    ConfirmDialog,
    invalidate,
    SelectInput,
    settingsStyles as shell,
    useResourceVersion,
    withSecrecy,
    type ConfirmRequest
} from 'deveye-sdk-client';
import type { SettingsPanelProps } from '@deveye/types/sdk/client';

import { api, humanizeError } from './api';
import styles from './style.module.css';

import type { MailAccount, MailFolder } from '../contracts/domain';

/**
 * La maintenance d'une boîte : reconstruire le cache local d'un dossier.
 *
 * À part du reste parce que rien ici ne sert au quotidien. Une reconstruction
 * vide ce qui est affiché pour tout retélécharger, ce qui est long et n'a de
 * sens qu'après une divergence durable : la relève ordinaire suffit le reste du
 * temps. Voisiner la cadence de relève dans le même onglet la faisait passer
 * pour un geste courant.
 *
 * Une boîte protégée n'y a pas droit : lister ses dossiers demanderait un
 * déverrouillage rien que pour afficher l'onglet.
 */
export default function MailAdvancedPanel({ scope, canWrite }: SettingsPanelProps) {
    const accountId = scope.kind === 'item' ? scope.itemId : null;
    const version = useResourceVersion('mail.accountList');
    const [account, setAccount] = useState<MailAccount | null>(null);
    const [folders, setFolders] = useState<MailFolder[]>([]);
    const [folderId, setFolderId] = useState<number | null>(null);
    const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
    const [busy, setBusy] = useState(false);
    const [status, setStatus] = useState<string | null>(null);

    useEffect(() => {
        if (accountId === null) return;
        void api
            .send('mail.accountList', {})
            .then((res) => setAccount(res.accounts.find((a) => a.id === accountId) ?? null))
            .catch((e) => setStatus(humanizeError(e, 'Chargement impossible.')));
    }, [accountId, version]);

    const guarded = account?.securityTier === 'guarded';

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
                <span className={shell.sectionLabel}>Reconstruire le cache d’un dossier</span>
                {!canWrite ? (
                    <p className={shell.fieldHint}>
                        Votre rôle ne permet pas la maintenance d’une boîte : elle relève de l’écriture sur Mail.
                    </p>
                ) : guarded ? (
                    <p className={shell.fieldHint}>
                        Cette boîte est protégée : ses dossiers ne se listent qu’une fois la session déverrouillée, et
                        la reconstruction n’est pas proposée ici.
                    </p>
                ) : folders.length === 0 ? (
                    <p className={shell.fieldHint}>Aucun dossier relevé pour l’instant.</p>
                ) : (
                    <>
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
                            l’affichage a durablement divergé de la boîte.
                        </span>
                    </>
                )}
            </div>

            {status && <p className={shell.notice}>{status}</p>}

            <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} busy={busy} />
        </div>
    );
}

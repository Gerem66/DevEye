import { useState } from 'react';
import {
    Button,
    ConfirmDialog,
    invalidate,
    settingsStyles as shell,
    UnlockCancelledError,
    withSecrecy,
    type ConfirmRequest
} from 'deveye-sdk-client';
import type { SettingsPanelProps } from '@deveye/types/sdk/client';

import { api, humanizeError } from './api';

/**
 * La maintenance d'une boîte : reconstruire son cache local, tous dossiers
 * confondus. Choisir un dossier demanderait de savoir lequel a divergé, ce que
 * personne ne sait devant un affichage faux ; le geste vise donc la boîte.
 *
 * À part du reste parce que rien ici ne sert au quotidien : une reconstruction
 * vide ce qui est affiché pour tout retélécharger, ce qui est long, et la
 * relève ordinaire suffit le reste du temps.
 *
 * Les dossiers ne se listent qu'au geste : une boîte protégée n'exige ainsi de
 * déverrouillage qu'au moment de reconstruire, pas pour afficher l'onglet.
 *
 * L'onglet ne porte que ce geste, donc le manifest le donne en `requiresWrite` :
 * sans l'écriture il n'existe pas, et ce panneau n'a pas de cas en lecture seule.
 */
export default function MailAdvancedPanel({ scope }: SettingsPanelProps) {
    const accountId = scope.kind === 'item' ? Number(scope.itemId) : null;
    const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
    const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
    const [status, setStatus] = useState<string | null>(null);

    if (accountId === null) return null;

    const rebuild = async () => {
        setStatus(null);
        setProgress({ done: 0, total: 0 });
        try {
            const { folders } = await withSecrecy(() => api.send('mail.folderList', { accountId }));
            for (const [index, folder] of folders.entries()) {
                setProgress({ done: index, total: folders.length });
                await withSecrecy(() => api.send('mail.folderReset', { folderId: folder.id }));
            }
            invalidate('mail.folderList', 'mail.messageList');
            setStatus(folders.length === 0 ? 'Aucun dossier à reconstruire.' : 'Cache de la boîte reconstruit.');
        } catch (e) {
            if (!(e instanceof UnlockCancelledError)) setStatus(humanizeError(e, 'Reconstruction impossible.'));
        } finally {
            setProgress(null);
        }
    };

    const requestRebuild = () =>
        setConfirm({
            title: 'Reconstruire le cache de la boîte ?',
            description:
                'La copie locale de tous les dossiers sera vidée puis retéléchargée. Aucun message n’est supprimé chez votre fournisseur, mais l’opération peut prendre plusieurs minutes.',
            confirmLabel: 'Reconstruire',
            onConfirm: () => {
                setConfirm(null);
                void rebuild();
            }
        });

    return (
        <div className={shell.section}>
            <div className={shell.field}>
                <span className={shell.sectionLabel}>Cache de la boîte</span>
                <span className={shell.fieldHint}>
                    DevEye garde une copie locale de vos messages pour les afficher vite. Si l’affichage ne correspond
                    plus à votre boîte (messages manquants, en double, ou déjà supprimés), reconstruisez-la : tout est
                    retéléchargé depuis votre fournisseur.
                </span>
                <div className={shell.sectionActions}>
                    <Button variant='danger' disabled={progress !== null} onClick={requestRebuild}>
                        {progress === null
                            ? 'Reconstruire le cache'
                            : progress.total === 0
                              ? 'Reconstruction…'
                              : `Reconstruction… ${progress.done + 1}/${progress.total}`}
                    </Button>
                </div>
            </div>

            {status && (
                <p className={shell.notice} role='status'>
                    {status}
                </p>
            )}

            <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
        </div>
    );
}

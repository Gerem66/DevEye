import { useState } from 'react';
import {
    Button,
    ConfirmDialog,
    copyText,
    Dialog,
    DialogCancelButton,
    humanizeError,
    invalidate
} from 'deveye-sdk-client';
import type { AudienceSubmission } from '../../contracts/domain';

import { api } from '../api';
import { formatDateTime } from '../format';
import styles from '../style.module.css';

interface SubmissionDialogProps {
    submission: AudienceSubmission | null;
    canWrite: boolean;
    onClose: () => void;
    /** Le tableau retire la ligne : lui seul sait ce qu'il a chargé. */
    onRemoved: (submissionId: number) => void;
}

/**
 * Un retour tel qu'il est arrivé.
 *
 * Le JSON brut, et pas seulement les colonnes du tableau : celui-ci ne montre
 * que les champs communs aux lignes chargées, et un formulaire qui a changé de
 * questions en cours de route a des retours que le tableau tronque sans le
 * dire.
 */
export function SubmissionDialog({ submission, canWrite, onClose, onRemoved }: SubmissionDialogProps) {
    const [confirm, setConfirm] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);

    if (!submission) return null;
    const raw = JSON.stringify(submission.fields, null, 2);

    const copy = () => {
        void copyText(raw).then((ok) => {
            if (!ok) return;
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
        });
    };

    const remove = async () => {
        try {
            await api.send('audience.submissionRemove', { submissionId: submission.id });
            invalidate('audience.forms', 'audience.detail');
            onRemoved(submission.id);
            onClose();
        } catch (e) {
            setError(humanizeError(e, 'Suppression impossible.'));
        } finally {
            setConfirm(false);
        }
    };

    return (
        <>
            <Dialog
                open
                onClose={onClose}
                title='Retour reçu'
                description={formatDateTime(submission.at)}
                footer={
                    <>
                        {canWrite && (
                            <Button variant='danger' icon='trash' onClick={() => setConfirm(true)}>
                                Supprimer
                            </Button>
                        )}
                        {/* Le pictogramme ne change pas, seul l'intitulé : c'est ce que
                            fait déjà le bouton de copie de l'écran d'installation. */}
                        <Button variant='secondary' icon='copy' onClick={copy}>
                            {copied ? 'Copié' : 'Copier le détail'}
                        </Button>
                        <DialogCancelButton>Fermer</DialogCancelButton>
                    </>
                }
            >
                {error && <p className={styles.error}>{error}</p>}

                {submission.path && (
                    <p className={styles.rawMeta}>
                        Envoyé depuis <code>{submission.path}</code>
                    </p>
                )}

                {/* Le contexte de la visite, quand on a su la retrouver. Absent d'un
                    envoi serveur ou d'un visiteur inactif depuis longtemps : c'est un
                    bonus, jamais une donnée du retour lui-même. */}
                {submission.context && (
                    <p className={styles.contextTags}>
                        <span className={styles.contextTag}>
                            arrivé sur {submission.context.entryPath || 'page inconnue'}
                        </span>
                        <span className={styles.contextTag}>
                            {submission.context.referrer ? `via ${submission.context.referrer}` : 'en direct'}
                        </span>
                        {submission.context.browser && (
                            <span className={styles.contextTag}>{submission.context.browser}</span>
                        )}
                        {submission.context.device && (
                            <span className={styles.contextTag}>{submission.context.device}</span>
                        )}
                    </p>
                )}

                <pre className={styles.raw}>{raw}</pre>
            </Dialog>

            <ConfirmDialog
                request={
                    confirm
                        ? {
                              title: 'Supprimer ce retour ?',
                              description: 'Il disparaît définitivement, et les répartitions le décomptent.',
                              confirmLabel: 'Supprimer',
                              tone: 'danger',
                              onConfirm: remove
                          }
                        : null
                }
                onClose={() => setConfirm(false)}
            />
        </>
    );
}

export default SubmissionDialog;

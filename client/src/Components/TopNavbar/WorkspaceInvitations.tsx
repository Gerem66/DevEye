import { useEffect, useState } from 'react';
import { errorNote } from '@/api/useResource';
import { ws } from '@/api/ws';
import ErrorNote, { type ErrorNoteInput } from '@/Components/ErrorNote';
import { useResourceVersion } from '@/stores/invalidation';
import { upsertWorkspace } from '@/stores/workspace';
import styles from './TopNavbar.module.css';

interface Invitation {
    id: number;
    workspaceId: number;
    workspaceName: string;
    invitedBy: string;
    expiresAt: number;
}

export interface WorkspaceInvitationsProps {
    /** L'espace vient d'être rejoint : l'appelant bascule dessus. */
    onJoined: (workspaceId: number) => void;
}

/**
 * Les invitations reçues, sous les espaces d'ici : accepter y entre et bascule
 * dessus, refuser l'efface. Rien ne s'affiche sans invitation, et un refus du
 * serveur (l'offre du propriétaire est pleine) se lit sous la ligne.
 */
export function WorkspaceInvitations({ onJoined }: WorkspaceInvitationsProps) {
    const [invitations, setInvitations] = useState<Invitation[]>([]);
    const [busy, setBusy] = useState<number | null>(null);
    const [error, setError] = useState<{ id: number; note: ErrorNoteInput } | null>(null);

    const version = useResourceVersion('user.invitations');
    useEffect(() => {
        let cancelled = false;
        ws.send('user.invitations', {})
            .then((res) => {
                if (!cancelled) setInvitations(res.invitations);
            })
            .catch(() => {
                // Le menu se rouvre, la liste se relit.
            });
        return () => {
            cancelled = true;
        };
    }, [version]);

    const answer = async (invitation: Invitation, accept: boolean): Promise<void> => {
        setBusy(invitation.id);
        setError(null);
        try {
            if (accept) {
                const res = await ws.send('workspace.acceptInvite', { invitationId: invitation.id });
                // L'espace est d'ici, quelle que soit l'instance où l'on se trouve.
                upsertWorkspace(res.workspace, null);
                onJoined(res.workspace.id);
            } else {
                await ws.send('workspace.declineInvite', { invitationId: invitation.id });
            }
            setInvitations((list) => list.filter((i) => i.id !== invitation.id));
        } catch (e) {
            setError({ id: invitation.id, note: errorNote(e, 'Réponse impossible.') });
        } finally {
            setBusy(null);
        }
    };

    if (invitations.length === 0) return null;
    return (
        <>
            {invitations.map((invitation) => (
                <div key={invitation.id} className={styles.invitationRow}>
                    <div className={styles.invitationLine}>
                        <span className='icon icon-mail' />
                        <span className={styles.workspaceText}>
                            <span className={styles.workspaceName}>{invitation.workspaceName}</span>
                            <span className={styles.workspaceMeta}>Invitation de {invitation.invitedBy}</span>
                        </span>
                        <button
                            type='button'
                            className={`${styles.invitationAnswer} ${styles.invitationAccept}`}
                            onClick={() => void answer(invitation, true)}
                            disabled={busy !== null}
                            title={`Rejoindre ${invitation.workspaceName}`}
                            aria-label={`Rejoindre ${invitation.workspaceName}`}
                        >
                            <span className='icon icon-v' />
                        </button>
                        <button
                            type='button'
                            className={`${styles.invitationAnswer} ${styles.invitationDecline}`}
                            onClick={() => void answer(invitation, false)}
                            disabled={busy !== null}
                            title={`Refuser l’invitation à ${invitation.workspaceName}`}
                            aria-label={`Refuser l’invitation à ${invitation.workspaceName}`}
                        >
                            <span className='icon icon-x' />
                        </button>
                    </div>
                    {error?.id === invitation.id && (
                        <div className={styles.invitationError}>
                            <ErrorNote note={error.note} />
                        </div>
                    )}
                </div>
            ))}
        </>
    );
}

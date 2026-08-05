import { useEffect, useState } from 'react';

import { ws, WsError } from '@/api/ws';
import Button from '@/Components/Button';
import { Dialog } from '@/Components/Dialog';
import { setActiveWorkspace, upsertWorkspace } from '@/stores/workspace';
import styles from './style.module.css';

/**
 * Jeton d'invitation présent dans l'URL, ou `null`.
 *
 * L'application n'a pas de routeur : elle bascule entre connexion et accueil sur
 * l'état d'authentification. Un lien d'invitation est donc lu une fois, au
 * chargement, puis effacé de la barre d'adresse — pour qu'un rafraîchissement ne
 * repropose pas une invitation déjà acceptée, et qu'un jeton ne traîne pas dans
 * l'historique du navigateur.
 */
export function readInviteToken(): string | null {
    const m = /^\/invite\/([A-Za-z0-9_-]+)\/?$/.exec(window.location.pathname);
    return m ? m[1] : null;
}

export function clearInviteFromUrl(): void {
    window.history.replaceState({}, '', '/');
}

interface Preview {
    workspaceName: string;
    alreadyMember: boolean;
}

/**
 * Écran d'acceptation d'une invitation.
 *
 * Annonce d'abord quel espace on rejoint — accepter à l'aveugle un lien reçu
 * par message serait désagréable — puis consomme le jeton et bascule dessus.
 */
export default function AcceptInvitePopup({ token, onDone }: { token: string; onDone: () => void }) {
    const [preview, setPreview] = useState<Preview | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [joining, setJoining] = useState(false);

    useEffect(() => {
        let cancelled = false;
        void (async () => {
            try {
                const res = await ws.send('workspace.invitePreview', { token });
                if (!cancelled) setPreview(res);
            } catch (e) {
                if (!cancelled) {
                    setError(
                        e instanceof WsError && e.code === 'not_found'
                            ? 'Cette invitation n’est plus valide : elle a expiré, été révoquée, ou atteint son nombre d’utilisations.'
                            : 'Impossible de vérifier cette invitation.'
                    );
                }
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [token]);

    const accept = (): void => {
        setJoining(true);
        void (async () => {
            try {
                const res = await ws.send('workspace.inviteAccept', { token });
                upsertWorkspace(res.workspace);
                setActiveWorkspace(res.workspace.id);
                onDone();
            } catch (e) {
                setError(e instanceof WsError ? e.message : 'Impossible de rejoindre cet espace.');
                setJoining(false);
            }
        })();
    };

    const title = error ? 'Invitation invalide' : preview ? `Rejoindre « ${preview.workspaceName} » ?` : 'Invitation…';

    return (
        <Dialog
            open
            onClose={onDone}
            title={title}
            width={440}
            onSubmit={preview && !preview.alreadyMember ? accept : onDone}
            footer={
                error || preview?.alreadyMember ? (
                    <Button onClick={onDone}>Fermer</Button>
                ) : (
                    <>
                        <Button variant='secondary' onClick={onDone} disabled={joining}>
                            Refuser
                        </Button>
                        <Button onClick={accept} disabled={!preview || joining}>
                            {joining ? 'Ajout…' : 'Rejoindre'}
                        </Button>
                    </>
                )
            }
        >
            <p className={styles.popupHint}>
                {error ??
                    (preview?.alreadyMember
                        ? `Vous êtes déjà membre de « ${preview.workspaceName} ».`
                        : preview
                          ? 'Vous aurez accès aux notes, mots de passe et réglages de cet espace, et ses membres verront ce que vous y créerez.'
                          : 'Vérification du lien…')}
            </p>
        </Dialog>
    );
}

import type { CSSProperties } from 'react';

import { avatarSrc } from '@/Features/Profile/avatar';
import { userColorVar } from '@/Features/Profile/userColors';
import { usePresentUsers, type PresentUser } from '@/live/usePresence';
import { startTeleport } from '@/stores/live';
import { requestSelectWorkspace } from '@/stores/viewRequest';
import { getActiveWorkspaceId, useActiveWorkspace } from '@/stores/workspace';
import styles from './LivePresence.module.css';

/**
 * Mini-widget « Présence » : qui d'autre est dans l'espace, et où.
 *
 * Une bulle par personne — jamais par onglet — bordée de sa couleur. Le survol
 * dit où elle se trouve ; le clic l'y rejoindra (S4).
 *
 * **Invisible dans un espace personnel**, qui est par construction une salle
 * d'une seule personne : le widget y afficherait à vie « vous, tout seul ».
 */
/**
 * Aller où ce pair se trouve.
 *
 * L'intention est posée **avant** l'éventuelle bascule d'espace : elle vit hors
 * de l'arbre React, donc elle attend tranquillement que les niveaux se montent
 * et se laisse consommer par chacun au fur et à mesure. Un pair à l'accueil
 * donne un chemin vide, ce qui referme ce qui est ouvert — c'est la même
 * mécanique dans les deux sens.
 */
function joinPeer(peer: PresentUser): void {
    startTeleport(peer.workspaceId, peer.path);
    if (peer.workspaceId !== getActiveWorkspaceId()) requestSelectWorkspace(peer.workspaceId);
}

export function LivePresence() {
    const workspace = useActiveWorkspace();
    const peers = usePresentUsers();

    if (!workspace || workspace.kind === 'personal') return null;

    if (peers.length === 0) {
        return (
            <span className={styles.pill} title='Personne d’autre dans cet espace'>
                <span className={`icon icon-user ${styles.icon}`} />
                <span className={styles.count}>Seul</span>
            </span>
        );
    }

    return (
        <span className={styles.pill}>
            <span className={styles.stack}>
                {peers.map((peer) => (
                    <button
                        key={peer.userId}
                        type='button'
                        className={styles.bubble}
                        style={{ '--peer': userColorVar(peer.color) } as CSSProperties}
                        title={`${peer.username} · ${peer.label} — cliquer pour le rejoindre`}
                        aria-label={`Rejoindre ${peer.username}, ${peer.label}`}
                        onClick={() => joinPeer(peer)}
                    >
                        {peer.avatar ? (
                            <img src={avatarSrc(peer.avatar)} alt='' />
                        ) : (
                            <span className={styles.initial}>{peer.username.charAt(0)}</span>
                        )}
                    </button>
                ))}
            </span>
        </span>
    );
}

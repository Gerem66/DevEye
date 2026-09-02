import type { CSSProperties } from 'react';

import { avatarSrc } from '@/Features/Profile/avatar';
import { userColorVar } from '@/Features/Profile/userColors';
import { openCursorChat } from '@/live/cursorChat';
import { useHideLiveCursors } from '@/live/hideCursors';
import { usePresentUsers, type PresentUser } from '@/live/usePresence';
import { startTeleport } from '@/stores/live';
import { requestSelectWorkspace } from '@/stores/viewRequest';
import { getActiveWorkspaceId, useActiveWorkspace } from '@/stores/workspace';
import styles from './LivePresence.module.css';

/**
 * Aller où ce pair se trouve. L'intention est posée avant l'éventuelle bascule
 * d'espace : elle vit hors de l'arbre React et se laisse consommer par chaque
 * niveau à mesure qu'il se monte. Un pair à l'accueil donne un chemin vide, ce
 * qui referme ce qui est ouvert.
 */
function joinPeer(peer: PresentUser): void {
    startTeleport(peer.workspaceId, peer.path);
    if (peer.workspaceId !== getActiveWorkspaceId()) requestSelectWorkspace(peer.workspaceId);
}

/**
 * Mini-widget « Présence » : qui d'autre est dans l'espace, et où. Une bulle par
 * personne, bordée de sa couleur ; le clic la rejoint. Invisible dans un espace
 * personnel, salle d'une seule personne.
 */
export function LivePresence() {
    const workspace = useActiveWorkspace();
    const peers = usePresentUsers();
    const hidden = useHideLiveCursors();

    if (!workspace || workspace.kind === 'personal') return null;

    if (peers.length === 0) {
        return (
            <span className={`${styles.pill} ${styles.pillAlone}`} title='Personne d’autre dans cet espace'>
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
                        <img src={avatarSrc(peer.avatar)} alt='' />
                    </button>
                ))}
            </span>
            {/* La bulle s'ouvre surtout à la touche « / » ; ce bouton est là pour
                la faire découvrir. Masqué quand les curseurs le sont : la bulle
                les suit. */}
            {!hidden && (
                <button
                    type='button'
                    className={styles.say}
                    title='Écrire au curseur (/)'
                    aria-label='Écrire au curseur'
                    onClick={() => openCursorChat()}
                >
                    <span className={`icon icon-chat ${styles.icon}`} />
                </button>
            )}
        </span>
    );
}

import type { UserColor } from '@deveye/types';
import { useMemo } from 'react';

import { useAuth } from '@/auth/AuthProvider';
import { featureCatalog } from '@/Pages/Home/catalog';
import { usePeers } from '@/stores/live';
import { useActiveWorkspace } from '@/stores/workspace';

/**
 * Un pair, tel que l'interface le montre : le roster ne porte que `userId` et la
 * couleur, le reste est résolu ici contre les membres de l'espace.
 */
export interface PresentUser {
    userId: number;
    username: string;
    avatar: string;
    color: UserColor;
    /** L'espace où il se trouve — le rejoindre peut vouloir dire y basculer. */
    workspaceId: number;
    /** Son lieu, déjà tronqué par le serveur selon MES droits. */
    path: string[];
    /** Ce lieu, en toutes lettres : « Mail », « Accueil », « Ailleurs ». */
    label: string;
}

/**
 * Le libellé d'une vue, pour dire où se trouve quelqu'un. PARESSEUX, comme le
 * catalogue : ce fichier est atteint par le graphe d'imports des modules, une
 * table figée à l'import raterait leurs titres.
 */
let VIEW_TITLES_MEMO: Record<string, string> | null = null;
function viewTitles(): Record<string, string> {
    VIEW_TITLES_MEMO ??= {
        ...Object.fromEntries(featureCatalog().map((entry) => [entry.id, entry.title])),
        clients: 'Appareils',
        profile: 'Profil',
        security: 'Sécurité',
        logs: 'Journaux',
        users: 'Utilisateurs',
        workspace: "Gestion de l'espace"
    };
    return VIEW_TITLES_MEMO;
}

export function livePathLabel(path: readonly string[]): string {
    // Le serveur a déjà tronqué ce que je n'ai pas le droit de voir : un chemin
    // vide veut donc dire « à l'accueil » **ou** « quelque part que je ne peux
    // pas voir ». Les deux se disent de la même manière, et c'est voulu — savoir
    // qu'il y a quelque chose à cacher est déjà une fuite.
    if (path.length === 0) return 'Accueil';
    const root = path[0];
    const viewId = root.slice(root.indexOf(':') + 1);
    if (viewId.startsWith('device:')) return 'Appareils';
    return viewTitles()[viewId] ?? 'Ailleurs';
}

/**
 * Les autres personnes présentes dans l'espace actif, une par compte.
 *
 * **Dédoublonné par compte** : deux onglets sont deux connexions mais un seul
 * humain, et la barre du haut afficherait sinon deux fois la même bulle. On
 * garde le chemin le plus profond — c'est celui qui dit vraiment où la personne
 * travaille, l'autre onglet étant probablement resté sur l'accueil.
 *
 * Moi-même exclu : mes propres onglets ne m'apprennent rien.
 */
export function usePresentUsers(): PresentUser[] {
    const peers = usePeers();
    const { user } = useAuth();
    const workspace = useActiveWorkspace();

    return useMemo(() => {
        const members = new Map((workspace?.users ?? []).map((u) => [u.id, u]));
        const byUser = new Map<number, PresentUser>();

        for (const peer of peers) {
            if (user && peer.userId === user.id) continue;
            const existing = byUser.get(peer.userId);
            if (existing && existing.path.length >= peer.path.length) continue;
            const member = members.get(peer.userId);
            byUser.set(peer.userId, {
                userId: peer.userId,
                // Un membre absent de la liste vient d'être ajouté à l'espace :
                // sa fiche arrivera au prochain rafraîchissement de session.
                username: member?.username ?? 'Membre',
                avatar: member?.avatar ?? '',
                color: peer.color,
                workspaceId: peer.workspaceId,
                path: peer.path,
                label: livePathLabel(peer.path)
            });
        }

        return [...byUser.values()].sort((a, b) => a.username.localeCompare(b.username, 'fr'));
    }, [peers, user, workspace]);
}

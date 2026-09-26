import type { Database } from '@/db';
import type { LiveTransport } from '@/live/hub';
import { forgetSessionsOf } from '@/Services/SecureStore';
import { invalidateAccess } from './_access';
import { notifyAdmins } from './admin/notify';

export interface DeleteUserDeps {
    db: Database;
    live?: Pick<LiveTransport, 'evictEverywhere' | 'closeSessionsOf' | 'evictRoom' | 'userChanged'>;
}

/**
 * Supprime un compte avec tout ce qu'il possède, que ce soit par un
 * administrateur ou par son titulaire. Les FK ON DELETE CASCADE emportent
 * l'espace personnel, les espaces partagés dont il est propriétaire et tout
 * leur contenu ; le reste ici prévient ceux qui les partageaient.
 */
export async function deleteUserEverywhere(
    { db, live }: DeleteUserDeps,
    userId: number,
    by: { userId: number; workspaceId: number }
): Promise<void> {
    // Relevés AVANT la suppression : la cascade emporte les rattachements,
    // et il n'y aurait plus personne à prévenir après coup.
    const shared = (await db.workspaces.findAccessibleByUser(userId)).filter((w) => w.kind === 'shared');
    const members = await db.workspaceMembers.listByWorkspaceIds(shared.map((w) => w.id));

    await db.users.delete(userId);
    invalidateAccess();
    forgetSessionsOf(userId);
    if (!live) return;
    live.evictEverywhere(userId);
    // Les espaces qu'il possédait ont disparu avec lui : leurs salles se vident.
    for (const w of shared) {
        if (w.owner_user_id === userId) live.evictRoom(w.id);
    }
    // Chaque membre de ses espaces relit sa session : le supprimé sort des
    // listes de membres, et un espace qu'il possédait sort des menus. Par
    // compte : assis ailleurs, un membre ne recevrait rien de la salle.
    for (const m of members) {
        if (m.user_id !== userId) live.userChanged(m.user_id, m.workspace_id, ['workspace'], by.userId);
    }
    await notifyAdmins(db, live, by.workspaceId, by.userId);
    // En dernier, après la dernière attente : un titulaire qui se supprime
    // lui-même tient sa réponse de cette socket, et la reçoit avant qu'elle
    // se ferme (`user.deleteAccount` ne ferme qu'au tour de boucle suivant).
    live.closeSessionsOf(userId);
}

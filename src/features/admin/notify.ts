import type { Database } from '@/db';
import type { LiveTransport } from '@/live/hub';

/**
 * Prévenir les administrateurs connectés qu'un compte ou une invitation a
 * changé : leur page Utilisateurs se relit. Par compte et non par salle, la
 * page se regarde depuis n'importe quel espace. L'auteur est compris : ses
 * autres onglets ne tiennent pas sa réponse.
 */
export async function notifyAdmins(
    db: Database,
    live: Pick<LiveTransport, 'userChanged'>,
    workspaceId: number,
    byUserId: number | null
): Promise<void> {
    for (const id of await db.users.listAdminIds()) live.userChanged(id, workspaceId, ['admin'], byUserId);
}

import type { UserRow } from '@deveye/types';

import type { Database } from '@/db';
import { e2eRunOf } from '@/Services/debug/e2e/identity';

export interface OpenAccountInput {
    email: string;
    username: string;
    /** Déjà haché : Argon2 ne tourne pas en transaction. */
    passwordHash: string;
    role: 'user' | 'admin';
    /** Secondes : quand les conditions du site ont été acceptées ; `null` sans site. */
    termsAcceptedAt: number | null;
}

/**
 * Crée un compte et son espace personnel : l'inscription, le compte de
 * développement et les comptes des essais passent tous par ici. Une adresse
 * d'essai marque le compte comme jetable, une fois pour toutes.
 */
export async function openAccount(
    db: Pick<Database, 'users' | 'workspaces'>,
    input: OpenAccountInput
): Promise<{ user: UserRow; personalWorkspaceId: number }> {
    const user = await db.users.create({ ...input, e2eRun: e2eRunOf(input.email) });
    // L'espace personnel ne peut pas exister avant le compte (sa FK
    // propriétaire le référence) : compte, espace, puis rattachement.
    const personal = await db.workspaces.createPersonal(user.id, input.username);
    await db.users.setPersonalWorkspace(user.id, personal.id);
    return { user, personalWorkspaceId: personal.id };
}

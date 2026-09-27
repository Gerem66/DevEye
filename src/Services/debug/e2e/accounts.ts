import { hashPassword } from '@/auth/argon';
import type { Database } from '@/db';
import { deleteUserEverywhere } from '@/features/_users';
import type { LiveHub } from '@/live/hub';
import { openAccount } from '@/Services/accounts';
import type { TestClient } from './client';
import type { TestIdentity } from './identity';

export interface TestSession extends TestIdentity {
    userId: number;
    workspaceId: number;
    client: TestClient;
}

/** Qui supprime : l'administrateur qui a lancé l'essai, ou personne (0) pour le ménage du démarrage. */
export interface Remover {
    userId: number;
    workspaceId: number;
}

/** Un compte jetable, créé par le même chemin qu'une inscription. */
export async function openTestAccount(
    db: Database,
    identity: TestIdentity
): Promise<{ userId: number; workspaceId: number }> {
    const passwordHash = await hashPassword(identity.password);
    const { user, personalWorkspaceId } = await db.transaction((tx) =>
        openAccount(tx, {
            email: identity.email,
            username: identity.username,
            passwordHash,
            role: 'user',
            termsAcceptedAt: null
        })
    );
    return { userId: user.id, workspaceId: personalWorkspaceId };
}

/** Se connecter comme une page : la route de connexion, puis la socket. */
export async function signIn(client: TestClient, identity: TestIdentity): Promise<void> {
    await client.api('/api/auth/login', { username: identity.username, password: identity.password });
    await client.connect();
}

/**
 * Supprime un compte jetable par le vrai chemin (modules prévenus, cascade,
 * sessions fermées), puis ce qu'il laisse hors de la cascade : ses lignes de
 * journal et une inscription en attente à son adresse.
 */
export async function removeTestAccount(
    { db, live }: { db: Database; live: LiveHub },
    account: { userId: number; email: string },
    by: Remover
): Promise<void> {
    await deleteUserEverywhere({ db, live }, account.userId, by);
    await db.debug.purgeLogsOf([account.userId]);
    await db.debug.purgeSignupsLike(account.email);
}

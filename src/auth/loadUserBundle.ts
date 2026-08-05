import type { Database } from '@/db';
import type { HomeLayout, MinimalUser, SessionBundle, ThemeStateDTO, UserRole, Workspace } from 'deveye-types';
import { homeLayoutSchema, themeStateSchema } from 'deveye-types';
import { permissionsFor } from '@/features/_access';

/**
 * Charge tout ce qu'une session a besoin de connaître : le compte, ses espaces,
 * et **le seul espace actif** avec son thème et sa disposition d'accueil.
 *
 * Le thème des autres espaces n'est délibérément pas embarqué (`bgImages` peut
 * contenir plusieurs data URLs de fond d'écran) : basculer d'espace va chercher
 * les siens.
 */
export async function loadUserBundle(db: Database, userId: number): Promise<SessionBundle | null> {
    const row = await db.users.findById(userId);
    if (!row) return null;

    // Security posture surfaced as "Sécurité → x / 3" in the profile. The
    // re-auth window counts when strict — short enough (≤ 5 min) to be a
    // meaningful protection, 0 being the strongest setting (always re-prompt).
    // A null interval falls back to the 60s server default, which is strict.
    const [twoFaRow, secretKeyRow] = await Promise.all([db.twoFactor.get(userId), db.userSecretKeys.get(userId)]);
    const reAuth = row.re_auth_interval ?? 60;
    const security = {
        twoFactor: Boolean(twoFaRow?.enabled),
        passwordEncryption: secretKeyRow?.wrap_mode === 'password',
        reAuthValidation: reAuth <= 300
    };

    const wsRows = await db.workspaces.findAccessibleByUser(userId);
    const memberRows = wsRows.length ? await db.workspaceMembers.listByWorkspaceIds(wsRows.map((w) => w.id)) : [];
    const memberIds = Array.from(new Set(memberRows.map((m) => m.user_id)));
    const memberUserRows = memberIds.length ? await db.users.findByIds(memberIds) : [];

    const workspaces: Workspace[] = wsRows.map((w) => {
        const userIds = new Set(memberRows.filter((m) => m.workspace_id === w.id).map((m) => m.user_id));
        const users: MinimalUser[] = memberUserRows
            .filter((u) => userIds.has(u.id))
            .map((u) => ({
                id: u.id,
                email: u.email,
                username: u.username,
                avatar: u.avatar,
                created: Number(u.created)
            }));
        return {
            id: w.id,
            kind: w.kind,
            name: w.name,
            logo: w.logo,
            ownerUserId: w.owner_user_id,
            users,
            features: parseStringArray(w.features),
            created: Number(w.created)
        };
    });

    // L'espace favori s'il est encore accessible, sinon le personnel. Un favori
    // dont l'accès a été révoqué ne doit pas bloquer la connexion : on retombe
    // silencieusement sur l'espace personnel, qui est toujours là.
    const accessible = new Set(workspaces.map((w) => w.id));
    const activeWorkspaceId =
        row.default_workspace_id !== null && accessible.has(row.default_workspace_id)
            ? row.default_workspace_id
            : row.personal_workspace_id;

    const activeRow = await db.workspaces.findById(activeWorkspaceId);

    return {
        user: {
            id: row.id,
            email: row.email,
            username: row.username,
            avatar: row.avatar,
            role: (row.role === 'admin' ? 'admin' : 'user') as UserRole,
            settings: parseStringArray(row.settings),
            security,
            personalWorkspaceId: row.personal_workspace_id,
            defaultWorkspaceId: row.default_workspace_id,
            lastLogin: Number(row.last_login),
            created: Number(row.created)
        },
        workspaces,
        activeWorkspaceId,
        theme: parseTheme(activeRow?.theme),
        homeLayout: parseHomeLayout(activeRow?.home_layout),
        permissions: activeRow
            ? await permissionsFor(db, userId, activeRow)
            : { isOwner: false, capabilities: [], features: [] }
    };
}

function parseTheme(raw: string | null | undefined): ThemeStateDTO | null {
    if (!raw) return null;
    try {
        const parsed = themeStateSchema.safeParse(JSON.parse(raw));
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
}

function parseHomeLayout(raw: string | null | undefined): HomeLayout | null {
    if (!raw) return null;
    try {
        const parsed = homeLayoutSchema.safeParse(JSON.parse(raw));
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
}

function parseStringArray(raw: unknown): string[] {
    if (Array.isArray(raw)) return raw.map(String);
    if (typeof raw === 'string') {
        try {
            const parsed: unknown = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed.map(String) : [];
        } catch {
            return [];
        }
    }
    return [];
}
